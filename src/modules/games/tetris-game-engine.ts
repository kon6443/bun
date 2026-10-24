import { ENGINE_VERSION, FRAMES_PER_SECOND, MAX_FRAMES, MAX_INPUT_LENGTH, simulateReplay } from './tetris-engine';
import type { GameBoard, GameEngine, HallOfFamePeriod } from './game-engine.registry';
import { GAME_SESSION_TTL_SECONDS } from '../../common/constants/app.constants';
import { DAILY_BOARD_PATTERN, dailyBoardAt, dailySeed } from './daily-board';
import { CHALLENGE_BOARD_PATTERN } from './challenge-board';
import { rankingPeriodStart } from './ranking-period';
import { GAME_HALL_OF_FAME_DAYS, GAME_HALL_OF_FAME_WEEKS } from '../../common/constants/app.constants';
import { GameDailyUnavailableErrorResponseDto } from './games-error.dto';

/** 테트리스 기본 보드 — 기존 기록은 마이그레이션 DEFAULT로 이 값을 가진다 */
const TETRIS_BOARD_KEY = 'default';

/** 테트리스 리플레이 params — 키는 정확히 이 둘 (games DESIGN §4-1) */
const TETRIS_PARAM_KEYS = ['arr', 'das'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TetrisGameEngineDeps {
  /** 데일리 seed HMAC 비밀값 — 없으면 오늘의 테트리스만 끈다(세션 503, /boards에서 빠짐) */
  getDailySecret: () => string | undefined;
}

/**
 * 테트리스 엔진 레지스트리 항목 — 엔진 사본(./tetris-engine, 원본 next-bun)의 simulateReplay를 감싼다 (games DESIGN §4-4)
 *
 * 보드: 기본 `default`(seed 무작위) · 오늘의 테트리스 `daily-YYYY-MM-DD`(seed = 데일리 HMAC, 전원 동일 — games-growth D-004)
 * · 도전장 `challenge-{원본 ID}`(seed = 원본 기록, 세션은 서비스가 연다 — D-005). 데일리·도전장은 보드 자체가 단위라 기간 필터를 쓰지 않는다.
 * detail은 랭킹·재생 화면에 쓰는 요약 값이다. 엔진 결과의 boardHash·endFrame은 검증용이라 저장하지 않는다.
 * 실측 수십 ms라 워커 없이 같은 스레드에서 돈다(games WORKLOG S3a 절).
 */
export function createTetrisGameEngine({ getDailySecret }: TetrisGameEngineDeps): GameEngine {
  return {
    engineVersion: ENGINE_VERSION,
    ticksPerSecond: FRAMES_PER_SECOND,
    maxSpeed: 1,
    maxFrames: MAX_FRAMES,
    maxInputLength: MAX_INPUT_LENGTH,
    sessionTtlSeconds: GAME_SESSION_TTL_SECONDS,
    defaultBoardKey: TETRIS_BOARD_KEY,
    supportsChallenge: true,
    resolveSessionBoard(board, now) {
      if (board === undefined) {
        return { boardKey: TETRIS_BOARD_KEY, mode: null, seed: null };
      }
      if (board === 'daily') {
        const secret = getDailySecret();
        if (!secret) {
          throw new GameDailyUnavailableErrorResponseDto();
        }
        const { boardKey } = dailyBoardAt(now);
        return { boardKey, mode: 'daily', seed: dailySeed(secret, boardKey) };
      }
      return null;
    },
    isRankingBoard(boardKey, now) {
      // 아직 오지 않은 날은 거부
      return (
        boardKey === TETRIS_BOARD_KEY ||
        CHALLENGE_BOARD_PATTERN.test(boardKey) ||
        (DAILY_BOARD_PATTERN.test(boardKey) && boardKey <= dailyBoardAt(now).boardKey)
      );
    },
    isPeriodRanking(boardKey) {
      return boardKey === TETRIS_BOARD_KEY;
    },
    isReplayPublic(boardKey, now) {
      // 데일리는 그날이 끝나고 세션 유효 시간이 더 지나야 공개 — 그날 마지막 순간에 받은 세션도 그날 보드로 등록되므로(디펜스 D-032와 같은 이유)
      const sessionsClosedAt = new Date(now.getTime() - GAME_SESSION_TTL_SECONDS * 1000);
      return !DAILY_BOARD_PATTERN.test(boardKey) || boardKey < dailyBoardAt(sessionsClosedAt).boardKey;
    },
    topLevelReplayParams: TETRIS_PARAM_KEYS,
    listBoards(now) {
      const boards: GameBoard[] = [{ boardKey: TETRIS_BOARD_KEY, mode: null, current: true, startsAt: null, endsAt: null }];
      if (getDailySecret()) {
        const today = dailyBoardAt(now);
        const yesterday = dailyBoardAt(new Date(today.startsAt.getTime() - DAY_MS));
        boards.push({ ...today, mode: 'daily', current: true }, { ...yesterday, mode: 'daily', current: false });
      }
      return boards;
    },
    hallOfFamePeriods(now) {
      // 기본 보드의 지난 주(등록 시각 범위) + 데일리 보드의 지난 날(공개된 것만). 데일리 비밀값이 없던 날은 기록이 없어 빈 기간이 된다
      const periods: HallOfFamePeriod[] = [];
      const thisWeek = rankingPeriodStart('weekly', now)!.getTime();
      for (let i = 1; i <= GAME_HALL_OF_FAME_WEEKS; i++) {
        const startsAt = new Date(thisWeek - i * 7 * DAY_MS);
        periods.push({ kind: 'weekly', boardKey: TETRIS_BOARD_KEY, startsAt, endsAt: new Date(startsAt.getTime() + 7 * DAY_MS) });
      }
      const today = dailyBoardAt(now).startsAt.getTime();
      for (let i = 1; i <= GAME_HALL_OF_FAME_DAYS; i++) {
        const day = dailyBoardAt(new Date(today - i * DAY_MS));
        if (this.isReplayPublic(day.boardKey, now)) {
          periods.push({ kind: 'daily', ...day });
        }
      }
      return periods;
    },
    isValidParams(params) {
      const keys = Object.keys(params).sort();
      return (
        keys.length === TETRIS_PARAM_KEYS.length &&
        keys.every((key, i) => key === TETRIS_PARAM_KEYS[i] && Number.isSafeInteger(params[key]))
      );
    },
    verify({ seed, frames, inputs, params }) {
      const result = simulateReplay({ seed, das: params.das, arr: params.arr, frames, inputs });
      if (!result.ok) {
        return Promise.resolve({ ok: false, reason: result.reason });
      }
      return Promise.resolve({
        ok: true,
        score: result.score,
        detail: {
          lines: result.lines,
          level: result.level,
          pieces: result.pieces,
          tSpins: result.tSpins,
          tetrises: result.tetrises,
          maxCombo: result.maxCombo,
          engineVersion: ENGINE_VERSION,
          das: params.das,
          arr: params.arr,
        },
      });
    },
  };
}

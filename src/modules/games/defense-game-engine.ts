import { ENGINE_VERSION, MAX_INPUT_LENGTH, MAX_TICKS, TICKS_PER_SECOND } from './defense-engine';
import type { GameBoard, GameEngine, ReplayInput, VerifiedReplay } from './game-engine.registry';
import { weeklyBoardAt, weeklySeed } from './weekly-board';
import { GameWeeklyUnavailableErrorResponseDto } from './games-error.dto';

/** 현재 무한 모드 시즌 — 큰 밸런스 패치 때만 올린다(D-014). 지난 시즌 보드는 조회만 */
export const DEFENSE_ENDLESS_SEASON = 1;
/** 세션 유효 시간 — 게임 시간 상한 90분 + 일시정지·증강 대기 여유 (§B3) */
export const DEFENSE_SESSION_TTL_SECONDS = 4 * 60 * 60;
/** 시간 검사 배속 상한 (D-004) */
const DEFENSE_MAX_SPEED = 3;

const ENDLESS_BOARD_PATTERN = /^endless-s([1-9]\d{0,3})$/;
const WEEKLY_BOARD_PATTERN = /^weekly-\d{4}-w(0[1-9]|[1-4]\d|5[0-3])$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const endlessBoardKey = (season: number) => `endless-s${season}`;

export interface DefenseGameEngineDeps {
  /** 주간 seed HMAC 비밀값 — 없으면 주간 도전만 끈다(세션 503, /boards에서 빠짐) */
  getWeeklySecret: () => string | undefined;
  /** 검증 실행 — 운영은 워커 풀, 테스트는 verifyDefenseReplay 인프로세스. 인프라 실패는 throw(503) */
  verify: (input: ReplayInput) => Promise<VerifiedReplay>;
}

/**
 * 디펜스 엔진 레지스트리 항목 (defense DESIGN §B2·§B3·§B6)
 *
 * 보드: 무한 `endless-s{시즌}`(seed는 세션 서비스가 무작위로) · 주간 `weekly-YYYY-wNN`(seed = 주간 HMAC, 전원 동일).
 * 주간 보드는 보드 자체가 1주라 랭킹 기간 필터를 쓰지 않는다.
 */
export function createDefenseGameEngine({ getWeeklySecret, verify }: DefenseGameEngineDeps): GameEngine {
  const currentEndless = endlessBoardKey(DEFENSE_ENDLESS_SEASON);
  return {
    engineVersion: ENGINE_VERSION,
    ticksPerSecond: TICKS_PER_SECOND,
    maxSpeed: DEFENSE_MAX_SPEED,
    maxFrames: MAX_TICKS,
    maxInputLength: MAX_INPUT_LENGTH,
    sessionTtlSeconds: DEFENSE_SESSION_TTL_SECONDS,
    defaultBoardKey: currentEndless,
    topLevelReplayParams: [],
    resolveSessionBoard(board, now) {
      // 생략하면 무한 — 랭킹 기본 보드와 같다
      if (board === undefined || board === 'endless') {
        return { boardKey: currentEndless, mode: 'endless', seed: null };
      }
      if (board === 'weekly') {
        const secret = getWeeklySecret();
        if (!secret) {
          throw new GameWeeklyUnavailableErrorResponseDto();
        }
        const { boardKey } = weeklyBoardAt(now);
        return { boardKey, mode: 'weekly', seed: weeklySeed(secret, boardKey) };
      }
      return null;
    },
    isRankingBoard(boardKey, now) {
      const endless = ENDLESS_BOARD_PATTERN.exec(boardKey);
      if (endless) {
        return Number(endless[1]) <= DEFENSE_ENDLESS_SEASON;
      }
      // 주차 키는 0 채움 고정 폭이라 문자열 비교 = 시간 순서. 아직 오지 않은 주는 거부
      return WEEKLY_BOARD_PATTERN.test(boardKey) && boardKey <= weeklyBoardAt(now).boardKey;
    },
    isPeriodRanking(boardKey) {
      return !WEEKLY_BOARD_PATTERN.test(boardKey);
    },
    isReplayPublic(boardKey, now) {
      // 주간 보드는 그 주가 끝나고 세션 유효 시간(4시간)이 더 지나야 공개 — 1위 입력을 받아 그대로·고쳐서 내는 복제 방지 (D-027).
      // 주 마지막 순간에 받은 세션도 그 주 보드로 등록되므로(§B3), 주가 바뀌자마자 공개하면 그 세션으로 복제본을 낼 수 있다(D-032)
      const sessionsClosedAt = new Date(now.getTime() - DEFENSE_SESSION_TTL_SECONDS * 1000);
      return !WEEKLY_BOARD_PATTERN.test(boardKey) || boardKey < weeklyBoardAt(sessionsClosedAt).boardKey;
    },
    listBoards(now) {
      const boards: GameBoard[] = [];
      for (let season = DEFENSE_ENDLESS_SEASON; season >= 1; season--) {
        boards.push({
          boardKey: endlessBoardKey(season),
          mode: 'endless',
          current: season === DEFENSE_ENDLESS_SEASON,
          startsAt: null,
          endsAt: null,
        });
      }
      if (getWeeklySecret()) {
        const thisWeek = weeklyBoardAt(now);
        const lastWeek = weeklyBoardAt(new Date(thisWeek.startsAt.getTime() - DAY_MS));
        boards.push(
          { ...thisWeek, mode: 'weekly', current: true },
          { ...lastWeek, mode: 'weekly', current: false },
        );
      }
      return boards;
    },
    isValidParams(params) {
      // 디펜스 리플레이는 게임별 설정이 없다
      return Object.keys(params).length === 0;
    },
    verify,
  };
}

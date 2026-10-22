import { ENGINE_VERSION, FRAMES_PER_SECOND, MAX_FRAMES, MAX_INPUT_LENGTH, simulateReplay } from './tetris-engine';
import type { GameEngine } from './game-engine.registry';
import { GAME_SESSION_TTL_SECONDS } from '../../common/constants/app.constants';

/** 테트리스는 보드가 하나 — 기존 기록은 마이그레이션 DEFAULT로 이 값을 가진다 */
const TETRIS_BOARD_KEY = 'default';

/** 테트리스 리플레이 params — 키는 정확히 이 둘 (games DESIGN §4-1) */
const TETRIS_PARAM_KEYS = ['arr', 'das'] as const;

/**
 * 테트리스 리플레이 검증 — 엔진 사본(./tetris-engine, 원본 next-bun)의 simulateReplay를 감싼다 (DESIGN §4-4)
 *
 * detail은 랭킹·재생 화면에 쓰는 요약 값이다. 엔진 결과의 boardHash·endFrame은 검증용이라 저장하지 않는다.
 * 실측 수십 ms라 워커 없이 같은 스레드에서 돈다(games WORKLOG S3a 절).
 */
export const tetrisGameEngine: GameEngine = {
  engineVersion: ENGINE_VERSION,
  ticksPerSecond: FRAMES_PER_SECOND,
  maxSpeed: 1,
  maxFrames: MAX_FRAMES,
  maxInputLength: MAX_INPUT_LENGTH,
  sessionTtlSeconds: GAME_SESSION_TTL_SECONDS,
  defaultBoardKey: TETRIS_BOARD_KEY,
  resolveSessionBoard(board) {
    return board === undefined ? { boardKey: TETRIS_BOARD_KEY, mode: null, seed: null } : null;
  },
  isRankingBoard(boardKey) {
    return boardKey === TETRIS_BOARD_KEY;
  },
  isPeriodRanking() {
    return true;
  },
  isReplayPublic() {
    return true;
  },
  topLevelReplayParams: TETRIS_PARAM_KEYS,
  listBoards() {
    return [{ boardKey: TETRIS_BOARD_KEY, mode: null, current: true, startsAt: null, endsAt: null }];
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

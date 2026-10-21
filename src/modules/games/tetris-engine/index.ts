/**
 * 테트리스 엔진 공개 API
 * 원본·동기화 규칙은 constants.ts 머리 주석 — 백엔드 사본은 직접 수정하지 않는다
 */

export * from './constants';
export { PIECE, PIECE_CELLS, PIECE_COUNT } from './pieces';
export {
  type GameState,
  type LockEvent,
  type TSpinKind,
  collides,
  createGame,
  getBoardHash,
  getCell,
  getDropY,
  stepFrame,
} from './game';
export {
  type InputRecorder,
  type ReplayFailureReason,
  type ReplayInput,
  type ReplayResult,
  type ReplaySuccess,
  buildReplay,
  createInputRecorder,
  isValidReplayHeader,
  recordInput,
  simulateReplay,
  toReplaySuccess,
} from './replay';

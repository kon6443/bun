/**
 * 대전 래퍼 공개 API
 * 원본·동기화 규칙은 constants.ts 머리 주석 — 백엔드 사본은 직접 수정하지 않는다
 */

export * from './constants';
export {
  type BattleLock,
  type BattleState,
  type GarbageEvent,
  type PendingGarbage,
  type StepBattleResult,
  computeAttack,
  createBattle,
  isPerfectClear,
  isValidGarbageEvent,
  pendingGarbageLines,
  receiveGarbage,
  stepBattle,
} from './battle';
export {
  type BattleReplayFailureReason,
  type BattleReplayInput,
  type BattleReplayResult,
  type BattleReplaySuccess,
  buildBattleReplay,
  encodeGarbageLog,
  isValidBattleReplayHeader,
  simulateBattleReplay,
} from './replay';

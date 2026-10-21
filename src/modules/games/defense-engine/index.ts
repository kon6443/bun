/**
 * 디펜스 엔진 공개 API
 * 원본·동기화 규칙은 constants.ts 머리 주석 — 백엔드 사본은 직접 수정하지 않는다
 */

export * from './constants';
export { ENEMIES, ENEMY_ID, type EnemyKind } from './data/enemies';
export { MAP_E1, type GameMap, type MapPath, type MapSlot } from './data/maps';
export { STAGES, STAGE_E1, findStage, type Stage, type Wave, type WaveGroup } from './data/stages';
export { TOWERS, TOWER_ID, type TowerKind, type TowerLevel } from './data/towers';
export {
  ENEMY_STATUS,
  PROJECTILE_STATUS,
  type Enemy,
  type GameState,
  type Projectile,
  type Spawner,
  type Tower,
  type WaveProgress,
  applyCommand,
  createGame,
  earlyCallBonus,
  getStateHash,
  scoreOf,
  sellRefund,
  step,
  upgradeCost,
  waveClearBonus,
} from './game';
export {
  type CommandRecorder,
  type ReplayFailureReason,
  type ReplayInput,
  type ReplayResult,
  type ReplaySuccess,
  buildReplay,
  createCommandRecorder,
  recordCommand,
  simulateReplay,
  toReplaySuccess,
} from './replay';

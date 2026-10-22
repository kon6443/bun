/**
 * 디펜스 엔진 공개 API
 * 원본·동기화 규칙은 constants.ts 머리 주석 — 백엔드 사본은 직접 수정하지 않는다
 */

export * from './constants';
export { AUGMENTS, AUGMENT_ID, type AugmentCard } from './data/augments';
export { ENEMIES, ENEMY_ID, type EnemyAbility, type EnemyKind } from './data/enemies';
export { MAP_E1, MAP_E2, type GameMap, type MapPath, type MapSlot } from './data/maps';
export { RULE_COUNT, RULE_ID, type WeeklyRules, isWeeklyBoardKey, pickWeeklyRules, ruleEffects } from './data/rules';
export {
  ENDLESS_BOARD_KEYS,
  STAGES,
  STAGE_E1,
  STAGE_E2,
  STAGE_E2_RULES,
  findStage,
  resolveBoard,
  type Stage,
  type Wave,
  type WaveGroup,
} from './data/stages';
export {
  TOWERS,
  TOWER_ID,
  type StatusApply,
  type TowerBranch,
  type TowerKind,
  type TowerSpecial,
  type TowerStage,
  towerStage,
} from './data/towers';
export { type Effect, type EffectSubject, flagValue, hasFlag, statValue } from './effects';
export { statusBits } from './status';
export { type SpawnSpec, createEnemy } from './spawn';
export { ultimatePeriod } from './combat';
export { maxLevel, slotAvailable, towerAllowed } from './state';
export {
  ENEMY_STATUS,
  PROJECTILE_STATUS,
  ZONE_KIND,
  type Enemy,
  type GameState,
  type Projectile,
  type Spawner,
  type Tower,
  type WaveProgress,
  type Zone,
  applyCommand,
  branchCost,
  buildCost,
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

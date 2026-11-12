/**
 * 포트리스 엔진 공개 API (§10)
 * 원본·동기화 규칙은 constants.ts 머리 주석 — 백엔드 사본은 직접 수정하지 않는다
 */

export * from './constants';
export { MAP_IDS, TANKS, WEAPONS, type MapId, type TankKind, type Weapon, type WeaponKind } from './data';
export { type Action, type ActionFail, type ActionOk, type FireInput, type ShotPreview, applyAction, previewShot } from './game';
export { stateHash, stateValues } from './hash';
export { cosDeg, isqrt, sinDeg } from './math';
export { fnv1a, nextRandom, streamSeed, toHex32 } from './random';
export { type SimulateFail, type SimulateOk, simulateMatch } from './replay';
export { type DeathCause, type Impact, type MatchEvent, eventsEndTick } from './sim';
export {
  type MatchConfig,
  type MatchMode,
  type MatchResult,
  type MatchState,
  type PlayerConfig,
  type Tank,
  aliveTanks,
  createMatch,
  nextSlot,
} from './state';
export { type Carve, type Column, type Terrain, carveCircle, groundAt, isSolid } from './terrain';

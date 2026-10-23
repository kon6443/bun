/**
 * 게임 상태 — 순수 데이터(일반 객체·배열)라 복제(스냅샷)할 수 있다. 생성·공통 조회
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import { RNG_PURPOSE, STAT } from './constants';
import type { MapPath } from './data/maps';
import { ruleEffects } from './data/rules';
import type { Stage } from './data/stages';
import { TOWERS } from './data/towers';
import { ANY_ENEMY_KIND, type Effect, type EffectSubject, ECONOMY_SUBJECT, statValue } from './effects';
import { streamSeed } from './random';

export const ENEMY_STATUS = { ALIVE: 0, KILLED: 1, LEAKED: 2 } as const;
export const PROJECTILE_STATUS = { FLYING: 0, DONE: 1 } as const;
export const ZONE_KIND = { FIRE: 0, SLOW: 1 } as const;

export type Enemy = {
  /** 생성 순번 (1부터, 모든 엔티티가 같은 카운터) */
  id: number;
  kind: number;
  hp: number;
  maxHp: number;
  air: boolean;
  /** 경로 인덱스 (공중 적은 공중 경로 — 없으면 지상) */
  path: number;
  pathTotal: number;
  /** 경로를 따라 간 거리 (밀리타일) */
  dist: number;
  segment: number;
  segmentStart: number;
  x: number;
  y: number;
  /** 웨이브 번호 (1부터) */
  wave: number;
  /** 킬 보상 기준 HP (난이도 배율 전) — 파생 적의 보상 기준 · 킬 보상 */
  rewardHp: number;
  reward: number;
  status: number;
  /** 현재 저항 ‰ — 용은 2페이즈에서 맞바꾼다 */
  resistPhy: number;
  resistMag: number;
  /** 0 = 1페이즈, 1 = 2페이즈 (용) */
  phase: number;
  /** 능력 다음 발동까지 남은 틱 */
  abilityTimer: number;
  /** 분열·증식으로 생긴 적 — 증식(R5)이 다시 일어나지 않게 */
  derived: boolean;
  // ---- 상태효과 (§C3) ----
  /** 상태효과가 하나라도 걸려 있을 수 있는지 — 걸 때 켜고, 매 틱 갱신 끝에 다시 계산한다(빈 적은 3단계를 건너뛴다) */
  afflicted: boolean;
  slow: number;
  slowTicks: number;
  stunTicks: number;
  /** 기절 점감 창 시작 틱과 창 안 적용 횟수 */
  stunWindowStart: number;
  stunCount: number;
  /** 화상 — 출처 타워 id별 1스택 (같은 인덱스끼리 짝) */
  burnSources: number[];
  burnDps: number[];
  burnTicks: number[];
  poisonStacks: number;
  poisonTicks: number;
  /** 스택당 초당 피해 (걸린 것 중 가장 큰 값) */
  poisonDps: number;
  /** 역병 타워가 건 중독 — 사망 시 전염 */
  plague: boolean;
  shred: number;
  shredTicks: number;
  vulnerable: number;
  vulnerableTicks: number;
  /** 저주 폭발 — 저주가 살아 있는 동안 사망하면 최대 HP 이 ‰만큼 범위 피해 (0 = 없음) */
  curseExplode: number;
  curseTicks: number;
  /** 생성 틱 — 지속 피해는 생성 뒤 30틱 주기마다(적마다 위상이 달라 같은 틱에 몰리지 않는다) */
  spawnTick: number;
  /** 산산조각 — 이번 사망을 일으킨 타격의 파편 피해(0 = 없음)·반경 */
  shatterDamage: number;
  shatterRadius: number;
};

export type Tower = {
  id: number;
  slot: number;
  kind: number;
  /** 1~5 */
  level: number;
  /** 0 = 분기 전, 1·2 = Lv4 분기 */
  branch: number;
  targetMode: number;
  /** 다음 공격까지 남은 틱 (0 = 준비됨) */
  cooldown: number;
  /** 마지막으로 겨눈 적 id (0 = 없음) — 렌더러 포신 방향 */
  targetId: number;
  /** 지은 시점까지 시작한 웨이브 수 · 준비 단계에 지었는지 — 판매 100% 판정 (§L4) */
  builtInWave: number;
  builtInPrep: boolean;
  /** 건설·업그레이드·분기에 쓴 골드 합 */
  invested: number;
  x: number;
  y: number;
  /** 공격 횟수 — "n번째마다" 특수 능력 */
  attacks: number;
  /** 광선 — 같은 대상에 쏜 틱 수 */
  beamTargetId: number;
  beamTicks: number;
  /** 궁극(주기형) 다음 발동까지 남은 틱 (0 = 궁극 없음) */
  ultTimer: number;
};

export type Projectile = {
  id: number;
  towerId: number;
  /** 쏜 타워의 슬롯 — 상태효과 출처 키 */
  slot: number;
  /** 타워가 팔려도 명중을 처리하도록 단계 정보를 싣는다 */
  towerKind: number;
  level: number;
  branch: number;
  targetId: number;
  damage: number;
  damageType: number;
  element: number;
  splash: number;
  /** "n번째마다" 상태효과를 이번 탄이 거는지 */
  nthStatus: boolean;
  /** 표적 근처 추가로 맞힐 수 (관통) */
  pierce: number;
  /** 대포 여진(증강) — 착탄 지점 감속 장판 */
  aftershock: boolean;
  originX: number;
  originY: number;
  /** 표적의 마지막 위치 — 범위탄은 표적이 죽으면 여기서 터진다 */
  aimX: number;
  aimY: number;
  ticksLeft: number;
  totalTicks: number;
  status: number;
  /** 표적의 적 배열 인덱스 추정값 — 조회 캐시일 뿐 결과·해시에 쓰지 않는다 */
  targetHint: number;
};

/** 바닥 장판 (화염지대·여진) */
export type Zone = {
  id: number;
  kind: number;
  x: number;
  y: number;
  radius: number;
  ticksLeft: number;
  /** 화상 초당 피해 / 감속 ‰ */
  value: number;
  /** 걸어 주는 상태효과 지속 */
  statusTicks: number;
  /** 상태효과 출처 키 (슬롯 + 1) */
  sourceKey: number;
};

export type Spawner = {
  wave: number;
  group: number;
  remaining: number;
  next: number;
};

export type WaveProgress = {
  total: number;
  /** 아직 스폰 안 됐거나 살아 있는 수 — 0이 되면 끝 */
  pending: number;
  kills: number;
  cleared: boolean;
};

export type GameState = {
  stageId: string;
  /** 해석한 보드(맵·웨이브·규칙) — 무한·주간은 seed로 만든 웨이브를 담는다. 헤더(mode·boardKey·seed)에서 다시 만들 수 있어 해시에 넣지 않는다 */
  board: Stage;
  seed: number;
  tick: number;
  gold: number;
  lives: number;
  /** 킬 보상·클리어 보너스·조기 호출 보너스 합 (시작 골드·판매 환급 제외) */
  goldEarned: number;
  kills: number;
  wavesStarted: number;
  wavesCleared: number;
  /** 다음 웨이브 자동 시작까지 남은 틱 (0 = 카운트다운 아님) · 이번 카운트다운 길이 */
  countdown: number;
  countdownTotal: number;
  nextId: number;
  rngWave: number;
  rngAugment: number;
  rngCombat: number;
  aliveEnemies: number;
  enemies: Enemy[];
  towers: Tower[];
  projectiles: Projectile[];
  zones: Zone[];
  spawners: Spawner[];
  /** 인덱스 = 웨이브 번호 − 1 */
  waves: WaveProgress[];
  /** 활성 효과 — 규칙 변형(판 시작) + 고른 증강 순서대로 (§C6) */
  effects: Effect[];
  /** 주간 규칙 변형 (뽑은 순서) · R6 금지 타워 */
  rules: number[];
  bannedTower: number;
  /** 증강 — 제시 주기·보장 규칙·고른 카드(순서)·지금 제시 중인 후보·대기 중인 제시·희귀 이상 없이 지난 제시 수 */
  augmentEvery: number;
  augmentGuarantee: boolean;
  augments: number[];
  augmentChoices: number[];
  augmentPending: boolean;
  /** 아직 열지 않은 제시 수 */
  augmentQueue: number;
  /** 연 제시 수(후보가 없어 건너뛴 제시 포함) — 제시 순번·전설 해금 */
  offersOpened: number;
  offersWithoutRare: number;
  over: boolean;
  victory: boolean;
  endTick: number;
};

export function stageOf(state: GameState): Stage {
  return state.board;
}

export function enemyPath(stage: Stage, air: boolean, index: number): MapPath {
  const { groundPaths, airPaths } = stage.map;
  if (air && airPaths.length > 0) return airPaths[Math.min(index, airPaths.length - 1)];
  return groundPaths[Math.min(index, groundPaths.length - 1)];
}

export const towerSubject = (kind: number, element: number): EffectSubject => ({ tower: kind, element, enemy: -1 });
export const enemySubject = (kind: number): EffectSubject => ({ tower: -1, element: -1, enemy: kind });

export function economyStat(state: GameState, stat: number, base: number): number {
  return statValue(state.effects, ECONOMY_SUBJECT, stat, base);
}

/** 판 시작 효과 — 규칙 변형(R6은 금지 타워 인자) → 스테이지 효과(캠페인 난이도) */
function initialEffects(stage: Stage): Effect[] {
  const effects: Effect[] = [];
  for (const id of stage.rules) for (const e of ruleEffects(id, stage.bannedTower)) effects.push(e);
  for (const e of stage.effects) effects.push(e);
  return effects;
}

/** 모든 적에 걸리는 수치를 읽을 때의 대상 (종류 무관 — ALL_ENEMIES 범위만 맞는다) */
const ANY_ENEMY: EffectSubject = { tower: -1, element: -1, enemy: ANY_ENEMY_KIND };

/** 그룹 스폰 횟수 — 강철 군단(R2) 수 −20% (최소 1) */
function scaledCount(effects: readonly Effect[], count: number): number {
  return Math.max(1, statValue(effects, ANY_ENEMY, STAT.ENEMY_COUNT, count));
}

export function createGame(stage: Stage, seed: number): GameState {
  const effects = initialEffects(stage);
  return {
    stageId: stage.id,
    board: stage,
    seed,
    tick: 0,
    gold: statValue(effects, ECONOMY_SUBJECT, STAT.START_GOLD, stage.startGold),
    lives: Math.max(1, statValue(effects, ECONOMY_SUBJECT, STAT.LIVES, stage.lives)),
    goldEarned: 0,
    kills: 0,
    wavesStarted: 0,
    wavesCleared: 0,
    countdown: 0,
    countdownTotal: 0,
    nextId: 1,
    rngWave: streamSeed(seed, RNG_PURPOSE.WAVE),
    // 증강 스트림 — 제시마다 FNV-1a(seed, AUGMENT, 제시 순번)으로 다시 시드한다(augment.ts). 이 초기값은 첫 제시 전까지 해시에만 쓰인다
    rngAugment: streamSeed(seed, RNG_PURPOSE.AUGMENT),
    rngCombat: streamSeed(seed, RNG_PURPOSE.COMBAT),
    aliveEnemies: 0,
    enemies: [],
    towers: [],
    projectiles: [],
    zones: [],
    spawners: [],
    // 웨이브 집계는 시작할 때(game.ts startWave) 스폰 수만큼 더한다 — 시작 전에는 0
    waves: stage.waves.map(() => ({ total: 0, pending: 0, kills: 0, cleared: false })),
    effects,
    rules: stage.rules.slice(),
    bannedTower: stage.bannedTower,
    augmentEvery: stage.augmentEvery > 0 ? statValue(effects, ECONOMY_SUBJECT, STAT.AUGMENT_EVERY, stage.augmentEvery) : 0,
    augmentGuarantee: stage.augmentGuarantee,
    augments: [],
    augmentChoices: [],
    augmentPending: false,
    augmentQueue: 0,
    offersOpened: 0,
    offersWithoutRare: 0,
    over: false,
    victory: false,
    endTick: 0,
  };
}

export function groupSpawnCount(state: GameState, count: number): number {
  return scaledCount(state.effects, count);
}

export function towerAtSlot(state: GameState, slot: number): Tower | null {
  for (const tower of state.towers) if (tower.slot === slot) return tower;
  return null;
}

/**
 * 슬롯을 쓸 수 있는지 — 잠긴 슬롯은 "개척"(SLOTS_UNLOCK) 수만큼 앞에서부터 열리고,
 * 좁은 땅(SLOTS_REMOVE)은 열린 슬롯 중 번호가 큰 것부터 막는다
 */
export function slotAvailable(state: GameState, stage: Stage, slot: number): boolean {
  const slots = stage.map.slots;
  if (slot < 0 || slot >= slots.length) return false;
  const unlock = statValue(state.effects, ECONOMY_SUBJECT, STAT.SLOTS_UNLOCK, 0);
  const remove = statValue(state.effects, ECONOMY_SUBJECT, STAT.SLOTS_REMOVE, 0);
  if (slots[slot].locked) {
    let order = 0;
    for (let i = 0; i < slot; i++) if (slots[i].locked) order++;
    if (order >= unlock) return false;
  }
  // 열린(원래 열린) 슬롯 중 뒤에서 remove개
  let after = 0;
  for (let i = slots.length - 1; i > slot; i--) if (!slots[i].locked) after++;
  return slots[slot].locked || after >= remove;
}

/** 이 판의 업그레이드 상한 레벨 — 스테이지 상한과 천장(R7) 중 작은 것 */
export function maxLevel(state: GameState, stage: Stage): number {
  return Math.min(stage.maxLevel, statValue(state.effects, ECONOMY_SUBJECT, STAT.MAX_LEVEL, stage.maxLevel));
}

/** 이 판에서 지을 수 있는 타워인지 — 스테이지 목록 + 금지령(R6) */
export function towerAllowed(state: GameState, stage: Stage, kind: number): boolean {
  return stage.towers.indexOf(kind) >= 0 && TOWERS[kind] !== undefined && state.bannedTower !== kind;
}


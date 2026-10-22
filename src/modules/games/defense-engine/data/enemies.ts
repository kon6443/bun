/**
 * 적 데이터 (defense DESIGN §C5) — 11종 + 분열 새끼(웨이브에 직접 넣지 않는 파생 종류)
 * HP는 웨이브 그룹이 정한다(단위 EHP × hpPermille — 생성기는 S1). hpPermille·threat는 생성기용 기록
 * 원본·동기화 규칙은 ../constants.ts 머리 주석
 */

import { ABILITY, RANK } from '../constants';

export type EnemyAbility = {
  kind: number;
  /** 주기 (틱) — 소환·회복 */
  every: number;
  /** 소환·분열 마리 수 / 페이즈 전환 시 박쥐 떼 묶음 수 */
  count: number;
  /** ‰ — 새끼·소환물 HP(부모 최대 HP 대비), 회복량(대상 최대 HP 대비) */
  value: number;
  /** 회복 반경 (밀리타일) */
  radius: number;
  /** 소환·분열되는 적 종류 */
  spawnKind: number;
};

export type EnemyKind = {
  id: number;
  air: boolean;
  rank: number;
  /** 밀리타일/틱 (33 ≈ 1칸/초) */
  speed: number;
  /** 물리·마법 저항 ‰ — 용은 2페이즈에서 맞바꾼다 */
  resistPhy: number;
  resistMag: number;
  /** 누수 시 깎는 목숨 */
  leakLives: number;
  /** 감속·기절·취약을 받는 비율 ‰ (보스·공성 거인 500) */
  slowScale: number;
  stunScale: number;
  vulnerableScale: number;
  /** 한 번 스폰에 나오는 마리 수 (박쥐 떼 5) */
  swarm: number;
  ability: EnemyAbility;
  /** 생성기(S1)용 — HP 배율·위협 가중치 ‰ */
  hpPermille: number;
  threat: number;
};

export const ENEMY_ID = {
  GRUNT: 0,
  RUNNER: 1,
  SHIELD: 2,
  SPLITTER: 3,
  BATS: 4,
  SUMMONER: 5,
  GHOST: 6,
  WYVERN: 7,
  PRIEST: 8,
  GIANT: 9,
  DRAGON: 10,
  /** 분열체 새끼 — 웨이브 데이터에는 쓰지 않는다 */
  SPLITLING: 11,
} as const;

const NO_ABILITY: EnemyAbility = { kind: ABILITY.NONE, every: 0, count: 0, value: 0, radius: 0, spawnKind: 0 };

function enemy(change: Partial<EnemyKind> & { id: number }): EnemyKind {
  return {
    air: false,
    rank: RANK.NORMAL,
    speed: 33,
    resistPhy: 0,
    resistMag: 0,
    leakLives: 1,
    slowScale: 1000,
    stunScale: 1000,
    vulnerableScale: 1000,
    swarm: 1,
    ability: NO_ABILITY,
    hpPermille: 1000,
    threat: 1000,
    ...change,
  };
}

/** 보스 공통: 감속·기절·취약 50%, 기절 점감은 1회차부터 50% (§C3·§C5) */
const BOSS_CC = { slowScale: 500, stunScale: 500, vulnerableScale: 500 };

// ---- 정본에 수치가 없는 값 (S1에서 재조정) ----
/** 소환사가 부르는 졸개 HP — 소환사 최대 HP 대비 ‰ */
const SUMMON_HP_PERMILLE = 40;
/** 용 2페이즈 박쥐 떼 HP — 용 최대 HP 대비 ‰(한 마리) */
const DRAGON_BAT_HP_PERMILLE = 20;

/** 인덱스 = 적 id */
export const ENEMIES: readonly EnemyKind[] = [
  enemy({ id: ENEMY_ID.GRUNT }),
  enemy({ id: ENEMY_ID.RUNNER, speed: 53, hpPermille: 700, threat: 1100 }),
  enemy({ id: ENEMY_ID.SHIELD, speed: 27, resistPhy: 500, hpPermille: 1200, threat: 1300 }),
  enemy({
    id: ENEMY_ID.SPLITTER, hpPermille: 800, threat: 1500,
    ability: { kind: ABILITY.SPLIT, every: 0, count: 3, value: 250, radius: 0, spawnKind: ENEMY_ID.SPLITLING },
  }),
  enemy({ id: ENEMY_ID.BATS, air: true, speed: 47, swarm: 5, hpPermille: 400, threat: 750 }),
  enemy({
    id: ENEMY_ID.SUMMONER, rank: RANK.BOSS, speed: 17, resistMag: 400, leakLives: 10, ...BOSS_CC,
    ability: { kind: ABILITY.SUMMON, every: 180, count: 3, value: SUMMON_HP_PERMILLE, radius: 0, spawnKind: ENEMY_ID.GRUNT },
    hpPermille: 0, threat: 0,
  }),
  enemy({ id: ENEMY_ID.GHOST, speed: 37, resistPhy: 700, threat: 1700 }),
  enemy({ id: ENEMY_ID.WYVERN, air: true, speed: 60, resistPhy: 200, leakLives: 2, threat: 2400 }),
  enemy({
    id: ENEMY_ID.PRIEST, speed: 30, resistMag: 500, hpPermille: 900, threat: 2000,
    ability: { kind: ABILITY.HEAL, every: 30, count: 0, value: 30, radius: 1500, spawnKind: 0 },
  }),
  enemy({
    id: ENEMY_ID.GIANT, rank: RANK.ELITE, speed: 20, resistPhy: 400, resistMag: 200, leakLives: 3,
    slowScale: 500, stunScale: 500, hpPermille: 6000, threat: 5000,
  }),
  enemy({
    id: ENEMY_ID.DRAGON, air: true, rank: RANK.BOSS, speed: 17, resistPhy: 600, resistMag: 0, leakLives: 20, ...BOSS_CC,
    ability: { kind: ABILITY.PHASE_SWAP, every: 0, count: 2, value: DRAGON_BAT_HP_PERMILLE, radius: 0, spawnKind: ENEMY_ID.BATS },
    hpPermille: 0, threat: 0,
  }),
  enemy({ id: ENEMY_ID.SPLITLING, speed: 43, hpPermille: 250, threat: 0 }),
];

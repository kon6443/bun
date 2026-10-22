/**
 * 타워 데이터 (defense DESIGN §C4) — 6종 × Lv1~3 + Lv4 분기 2택 + 분기별 Lv5 궁극. 수치 = 계약(바꾸면 ENGINE_VERSION 상승)
 * 정본에 없는 값(지속 틱·연쇄 도약 거리 등)은 아래 이름 붙은 상수로 둔다 — 시뮬레이터(S1)에서 다시 맞춘다
 * 원본·동기화 규칙은 ../constants.ts 머리 주석
 */

import { ATTACK, DAMAGE, ELEMENT, SPECIAL, STATUS } from '../constants';

export type StatusApply = {
  status: number;
  /** 감속·파쇄·취약 = ‰, 화상·중독 = 초당 피해(스택당), 기절 = 쓰지 않음 */
  value: number;
  ticks: number;
  /** 중독 최대 스택 (이 타워가 걸 때) */
  cap?: number;
};

export type TowerSpecial = {
  kind: number;
  every?: number;
  /** ‰ */
  mult?: number;
  /** 밀리타일 */
  radius?: number;
  ticks?: number;
  value?: number;
  max?: number;
  count?: number;
  airOnly?: boolean;
  status?: StatusApply;
};

export type TowerStage = {
  /** 이 단계가 되는 데 드는 골드 (Lv1 = 건설비, 그 뒤는 업그레이드·분기 비용) */
  cost: number;
  damage: number;
  periodTicks: number;
  /** 사거리 (밀리타일) — 펄스는 반경 */
  range: number;
  attack: number;
  /** 범위 피해 반경 (0 = 단일) */
  splash: number;
  /** 연쇄 수(표적 포함) · 튈 때마다 피해 감소 ‰ · 다음 대상까지 거리 */
  chainCount: number;
  chainFalloff: number;
  chainRange: number;
  element: number;
  hitsGround: boolean;
  hitsAir: boolean;
  status: readonly StatusApply[];
  specials: readonly TowerSpecial[];
};

export type TowerBranch = { lv4: TowerStage; lv5: TowerStage };

export type TowerKind = {
  id: number;
  damageType: number;
  /** 투사체 속도 (밀리타일/틱) — 유도형, 발사 시 거리로 비행 틱을 정한다(§C2) */
  projectileSpeed: number;
  /** 인덱스 0 = Lv1 */
  levels: readonly TowerStage[];
  /** 인덱스 = 분기 0(A)·1(B) */
  branches: readonly TowerBranch[];
};

export const TOWER_ID = {
  ARCHER: 0,
  CANNON: 1,
  MAGE: 2,
  FROST: 3,
  CROSSBOW: 4,
  TESLA: 5,
} as const;

/** 레벨 업 비용 (§C4·§L4 누적 70·120·200·340·580) */
const COST = [70, 50, 80, 140, 240] as const;

// ---- 정본에 수치가 없는 값 (S1 시뮬레이터에서 재조정) ----
/** 중독 지속 — 재적용 시 갱신 */
const POISON_TICKS = 90;
/** 중독 스택당 초당 피해 (§C4 "중독 2/초") */
const POISON_DPS = 2;
/** 화상 지속 (§C4 소이탄 "2초") */
const BURN_TICKS = 60;
/** 파쇄 지속 — 철갑 볼트(정본은 철갑포탄만 150틱) */
const SHRED_TICKS = 150;
/** 서리 취약 지속 — 감속과 같게 */
const FROST_VULN_TICKS = 45;
/** 테슬라 연쇄 도약 거리 */
const CHAIN_RANGE = 1500;
/** 역병 전염 반경 (§C4 1.5칸) · 저주 폭발 반경 */
const PLAGUE_RADIUS = 1500;
const CURSE_EXPLODE_RADIUS = 1500;
/** 화염지대 반경 = 소이탄 착탄 반경 */
const FIRE_ZONE_RADIUS = 1200;

function stage(base: TowerStage, change: Partial<TowerStage>): TowerStage {
  return { ...base, ...change };
}

const NO_SPECIALS: readonly TowerSpecial[] = [];
const NO_STATUS: readonly StatusApply[] = [];

// ==================== 궁수탑 — 물리·지공 단일 투사체 ====================

const ARCHER_1: TowerStage = {
  cost: COST[0], damage: 8, periodTicks: 18, range: 3000, attack: ATTACK.PROJECTILE, splash: 0,
  chainCount: 0, chainFalloff: 0, chainRange: 0, element: ELEMENT.NONE, hitsGround: true, hitsAir: true,
  status: NO_STATUS, specials: NO_SPECIALS,
};
const ARCHER_3 = stage(ARCHER_1, { cost: COST[2], damage: 19, range: 3300 });
const ARCHER_POISON = { status: STATUS.POISON, value: POISON_DPS, ticks: POISON_TICKS };

const ARCHER: TowerKind = {
  id: TOWER_ID.ARCHER,
  damageType: DAMAGE.PHY,
  projectileSpeed: 300,
  levels: [ARCHER_1, stage(ARCHER_1, { cost: COST[1], damage: 13 }), ARCHER_3],
  branches: [
    {
      // 저격수 → 헤드샷: 5발째마다 ×4, 최강 우선(Lv5가 되면 타게팅을 최강으로 — game.ts onLevelUp)
      lv4: stage(ARCHER_3, { cost: COST[3], damage: 50, periodTicks: 30, range: 4500 }),
      lv5: stage(ARCHER_3, {
        cost: COST[4], damage: 55, periodTicks: 30, range: 4500,
        specials: [{ kind: SPECIAL.EVERY_NTH_DAMAGE, every: 5, mult: 4000 }],
      }),
    },
    {
      // 독화살 → 역병: 중독 최대 6 → 10스택, 중독된 적 사망 시 1.5칸 전염
      lv4: stage(ARCHER_3, { cost: COST[3], damage: 16, periodTicks: 12, element: ELEMENT.POISON, status: [{ ...ARCHER_POISON, cap: 6 }] }),
      lv5: stage(ARCHER_3, {
        cost: COST[4], damage: 20, periodTicks: 12, element: ELEMENT.POISON, status: [{ ...ARCHER_POISON, cap: 10 }],
        specials: [{ kind: SPECIAL.PLAGUE, radius: PLAGUE_RADIUS, status: { ...ARCHER_POISON, cap: 10 } }],
      }),
    },
  ],
};

// ==================== 대포 — 물리·지상 범위 투사체 ====================

const CANNON_1: TowerStage = {
  cost: COST[0], damage: 14, periodTicks: 45, range: 2800, attack: ATTACK.PROJECTILE, splash: 1000,
  chainCount: 0, chainFalloff: 0, chainRange: 0, element: ELEMENT.NONE, hitsGround: true, hitsAir: false,
  status: NO_STATUS, specials: NO_SPECIALS,
};
const CANNON_3 = stage(CANNON_1, { cost: COST[2], damage: 34 });

const CANNON: TowerKind = {
  id: TOWER_ID.CANNON,
  damageType: DAMAGE.PHY,
  projectileSpeed: 220,
  levels: [CANNON_1, stage(CANNON_1, { cost: COST[1], damage: 22 }), CANNON_3],
  branches: [
    {
      // 소이탄 → 화염지대: 화상 6 → 10/초, 착탄 지점 60틱 장판
      lv4: stage(CANNON_3, {
        cost: COST[3], damage: 40, splash: 1200, element: ELEMENT.FIRE,
        status: [{ status: STATUS.BURN, value: 6, ticks: BURN_TICKS }],
      }),
      lv5: stage(CANNON_3, {
        cost: COST[4], damage: 60, splash: 1200, element: ELEMENT.FIRE,
        status: [{ status: STATUS.BURN, value: 10, ticks: BURN_TICKS }],
        specials: [{ kind: SPECIAL.FIRE_ZONE, ticks: 60, radius: FIRE_ZONE_RADIUS, status: { status: STATUS.BURN, value: 10, ticks: BURN_TICKS } }],
      }),
    },
    {
      // 공성포 → 철갑포탄: 엘리트·보스 +50%, 3발째마다 파쇄 300‰ 150틱
      lv4: stage(CANNON_3, {
        cost: COST[3], damage: 110, periodTicks: 75, splash: 600,
        specials: [{ kind: SPECIAL.RANK_BONUS, value: 500 }],
      }),
      lv5: stage(CANNON_3, {
        cost: COST[4], damage: 170, periodTicks: 75, splash: 600,
        specials: [
          { kind: SPECIAL.RANK_BONUS, value: 500 },
          { kind: SPECIAL.EVERY_NTH_STATUS, every: 3, status: { status: STATUS.SHRED, value: 300, ticks: 150 } },
        ],
      }),
    },
  ],
};

// ==================== 마법탑 — 마법·지공 즉발 볼트 ====================

const MAGE_1: TowerStage = {
  cost: COST[0], damage: 15, periodTicks: 33, range: 2600, attack: ATTACK.INSTANT, splash: 0,
  chainCount: 0, chainFalloff: 0, chainRange: 0, element: ELEMENT.NONE, hitsGround: true, hitsAir: true,
  status: NO_STATUS, specials: NO_SPECIALS,
};
const MAGE_3 = stage(MAGE_1, { cost: COST[2], damage: 37 });
const CURSE = { status: STATUS.VULNERABLE, value: 150, ticks: 90 };

const MAGE: TowerKind = {
  id: TOWER_ID.MAGE,
  damageType: DAMAGE.MAG,
  projectileSpeed: 0,
  levels: [MAGE_1, stage(MAGE_1, { cost: COST[1], damage: 24 }), MAGE_3],
  branches: [
    {
      // 비전 광선 → 붕괴 광선: 같은 대상 유지 시 초당 +25%, 최대 ×2 → ×3
      lv4: stage(MAGE_3, {
        cost: COST[3], damage: 41, periodTicks: 30, attack: ATTACK.BEAM,
        specials: [{ kind: SPECIAL.BEAM_RAMP, value: 250, max: 2000 }],
      }),
      lv5: stage(MAGE_3, {
        cost: COST[4], damage: 55, periodTicks: 30, attack: ATTACK.BEAM,
        specials: [{ kind: SPECIAL.BEAM_RAMP, value: 250, max: 3000 }],
      }),
    },
    {
      // 저주 → 저주 폭발: 취약 150‰ 90틱, 저주받은 적 사망 시 최대 HP 15% 범위 마법 피해
      lv4: stage(MAGE_3, { cost: COST[3], damage: 45, periodTicks: 30, status: [CURSE] }),
      lv5: stage(MAGE_3, {
        cost: COST[4], damage: 65, periodTicks: 30, status: [CURSE],
        specials: [{ kind: SPECIAL.CURSE_EXPLODE, value: 150, radius: CURSE_EXPLODE_RADIUS }],
      }),
    },
  ],
};

// ==================== 서리탑 — 마법·지공 자기 주변 펄스 + 감속 ====================

const FROST_1: TowerStage = {
  cost: COST[0], damage: 5, periodTicks: 30, range: 2000, attack: ATTACK.PULSE, splash: 0,
  chainCount: 0, chainFalloff: 0, chainRange: 0, element: ELEMENT.ICE, hitsGround: true, hitsAir: true,
  status: [{ status: STATUS.SLOW, value: 300, ticks: 45 }], specials: NO_SPECIALS,
};
const FROST_SLOW_3 = { status: STATUS.SLOW, value: 400, ticks: 45 };
const FROST_3 = stage(FROST_1, { cost: COST[2], damage: 12, range: 2200, status: [FROST_SLOW_3] });

const FROST: TowerKind = {
  id: TOWER_ID.FROST,
  damageType: DAMAGE.MAG,
  projectileSpeed: 0,
  levels: [FROST_1, stage(FROST_1, { cost: COST[1], damage: 8, status: [{ status: STATUS.SLOW, value: 350, ticks: 45 }] }), FROST_3],
  branches: [
    {
      // 빙결 → 눈보라: 4번째 펄스마다 기절 30틱, 궁극 300틱마다 반경 3.5칸 감속 600‰ 90틱
      lv4: stage(FROST_3, {
        cost: COST[3], damage: 18,
        specials: [{ kind: SPECIAL.EVERY_NTH_STATUS, every: 4, status: { status: STATUS.STUN, value: 0, ticks: 30 } }],
      }),
      lv5: stage(FROST_3, {
        cost: COST[4], damage: 28,
        specials: [
          { kind: SPECIAL.EVERY_NTH_STATUS, every: 4, status: { status: STATUS.STUN, value: 0, ticks: 30 } },
          { kind: SPECIAL.PERIODIC_PULSE, every: 300, radius: 3500, status: { status: STATUS.SLOW, value: 600, ticks: 90 } },
        ],
      }),
    },
    {
      // 서리 취약 → 산산조각: 취약 150 → 200‰, 감속·기절 중 처치 시 주변 2칸 파편 30
      lv4: stage(FROST_3, {
        cost: COST[3], damage: 18, status: [FROST_SLOW_3, { status: STATUS.VULNERABLE, value: 150, ticks: FROST_VULN_TICKS }],
      }),
      lv5: stage(FROST_3, {
        cost: COST[4], damage: 28, status: [FROST_SLOW_3, { status: STATUS.VULNERABLE, value: 200, ticks: FROST_VULN_TICKS }],
        specials: [{ kind: SPECIAL.SHATTER, radius: 2000, value: 30 }],
      }),
    },
  ],
};

// ==================== 대공 석궁 — 물리·공중만 단일 고피해 ====================

const CROSSBOW_1: TowerStage = {
  cost: COST[0], damage: 32, periodTicks: 45, range: 3500, attack: ATTACK.PROJECTILE, splash: 0,
  chainCount: 0, chainFalloff: 0, chainRange: 0, element: ELEMENT.NONE, hitsGround: false, hitsAir: true,
  status: NO_STATUS, specials: NO_SPECIALS,
};
const CROSSBOW_3 = stage(CROSSBOW_1, { cost: COST[2], damage: 78 });

const CROSSBOW: TowerKind = {
  id: TOWER_ID.CROSSBOW,
  damageType: DAMAGE.PHY,
  projectileSpeed: 400,
  levels: [CROSSBOW_1, stage(CROSSBOW_1, { cost: COST[1], damage: 50 }), CROSSBOW_3],
  branches: [
    {
      // 산탄 → 탄막: 공중 범위 1.0 → 1.2칸
      lv4: stage(CROSSBOW_3, { cost: COST[3], damage: 70, splash: 1000 }),
      lv5: stage(CROSSBOW_3, { cost: COST[4], damage: 115, splash: 1200 }),
    },
    {
      // 철갑 볼트 → 용사냥꾼: 관통 3(표적 포함 — count 2는 추가 수) + 파쇄 200‰ / 공중 엘리트·보스 +100%
      lv4: stage(CROSSBOW_3, {
        cost: COST[3], damage: 120, element: ELEMENT.POISON,
        status: [{ status: STATUS.SHRED, value: 200, ticks: SHRED_TICKS }],
        specials: [{ kind: SPECIAL.PIERCE, count: 2, radius: 1000 }],
      }),
      lv5: stage(CROSSBOW_3, {
        cost: COST[4], damage: 190, element: ELEMENT.POISON,
        status: [{ status: STATUS.SHRED, value: 200, ticks: SHRED_TICKS }],
        specials: [
          { kind: SPECIAL.PIERCE, count: 2, radius: 1000 },
          { kind: SPECIAL.RANK_BONUS, value: 1000, airOnly: true },
        ],
      }),
    },
  ],
};

// ==================== 테슬라 — 마법·지공 연쇄 ====================

const TESLA_1: TowerStage = {
  cost: COST[0], damage: 9, periodTicks: 30, range: 2200, attack: ATTACK.CHAIN, splash: 0,
  chainCount: 3, chainFalloff: 250, chainRange: CHAIN_RANGE, element: ELEMENT.LIGHTNING, hitsGround: true, hitsAir: true,
  status: NO_STATUS, specials: NO_SPECIALS,
};
const TESLA_3 = stage(TESLA_1, { cost: COST[2], damage: 21 });

const TESLA: TowerKind = {
  id: TOWER_ID.TESLA,
  damageType: DAMAGE.MAG,
  projectileSpeed: 0,
  levels: [TESLA_1, stage(TESLA_1, { cost: COST[1], damage: 14 }), TESLA_3],
  branches: [
    {
      // 과부하 → 폭풍 코일: 연쇄 5(−15%), 궁극 240틱마다 10연쇄
      lv4: stage(TESLA_3, { cost: COST[3], damage: 25, chainCount: 5, chainFalloff: 150 }),
      lv5: stage(TESLA_3, {
        cost: COST[4], damage: 38, chainCount: 5, chainFalloff: 150,
        specials: [{ kind: SPECIAL.PERIODIC_CHAIN, every: 240, count: 10 }],
      }),
    },
    {
      // 감전 → 전자기 펄스: 3타째마다 기절 10틱, 궁극 360틱마다 반경 2.5칸 기절 45틱
      lv4: stage(TESLA_3, {
        cost: COST[3], damage: 33,
        specials: [{ kind: SPECIAL.EVERY_NTH_STATUS, every: 3, status: { status: STATUS.STUN, value: 0, ticks: 10 } }],
      }),
      lv5: stage(TESLA_3, {
        cost: COST[4], damage: 50,
        specials: [
          { kind: SPECIAL.EVERY_NTH_STATUS, every: 3, status: { status: STATUS.STUN, value: 0, ticks: 10 } },
          { kind: SPECIAL.PERIODIC_PULSE, every: 360, radius: 2500, status: { status: STATUS.STUN, value: 0, ticks: 45 } },
        ],
      }),
    },
  ],
};

/** 인덱스 = 타워 id */
export const TOWERS: readonly TowerKind[] = [ARCHER, CANNON, MAGE, FROST, CROSSBOW, TESLA];

/** 레벨(1~5)·분기(0 = 분기 전, 1·2)의 단계 수치 */
export function towerStage(kind: TowerKind, level: number, branch: number): TowerStage {
  if (level <= 3) return kind.levels[level - 1];
  const b = kind.branches[branch - 1];
  return level === 4 ? b.lv4 : b.lv5;
}

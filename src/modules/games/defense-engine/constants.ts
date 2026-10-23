/**
 * 타워 디펜스 엔진 상수 — 백엔드 리플레이 검증과 공유하는 계약 값 (defense DESIGN §E)
 *
 * 원본: next-bun/src/app/games/defense/engine/ → 사본: bun/src/modules/games/defense-engine/
 * 사본은 직접 수정하지 않는다. 동기화는 매니페스트(engine-dev/ENGINE_MANIFEST.json)로 검사한다
 * 이 폴더(data 포함)는 외부 import 없음·DOM·Date·Math.random·부동소수·Map/Set 순회 금지·ES2020 문법만 쓴다(§E1)
 * 비트 연산은 random.ts(PRNG·해시) 안에서만. 나눗셈은 Math.floor(a / b) — 피제수·제수는 음수가 아니다
 * 규칙·데이터(타워·적·스테이지 수치 포함)를 바꾸면 ENGINE_VERSION을 올리고 골든 픽스처·매니페스트를 다시 만든다
 */

export const ENGINE_VERSION = 3;

// ==================== 시간·좌표 ====================

export const TICKS_PER_SECOND = 30;
/** 1칸 = 1000 밀리타일 */
export const TILE = 1000;
/** ‰ 기준 */
export const PERMILLE = 1000;

// ==================== 상한 (§E5 — 서버 CPU·DoS 보호) ====================

/** 90분 */
export const MAX_TICKS = 162000;
export const MAX_WAVE = 80;
/** 넘으면 스폰을 다음 틱으로 미룬다 */
export const MAX_ALIVE_ENEMIES = 200;
/** 넘으면 그 틱 발사를 보류한다 */
export const MAX_PROJECTILES = 400;
export const MAX_INPUT_LENGTH = 20000;
export const SEED_MAX = 4294967295;
/** 적 한 마리 HP 상한 — 킬 보상 중간값(HP × 5 × G × K‰)이 2⁵³ 안에 들도록 (데이터 테스트가 확인) */
export const MAX_ENEMY_HP = 1000000000;

// ==================== 판 ====================

export const START_LIVES = 20;
/** 웨이브 간 카운트다운 — 현재 웨이브 스폰이 끝난 시점부터 (§L4) */
export const WAVE_COUNTDOWN_TICKS = 600;
/** 판매 환급 (같은 준비 단계에 지은 타워는 100%) */
export const SELL_REFUND_PERMILLE = 700;
/** 저항 상한 (§C0 — 피해 0 면역 금지) */
export const RESIST_CAP_PERMILLE = 800;
/** 킬 보상 G — 캠페인 (골드 per 1000 EHP, §L4) */
export const KILL_REWARD_G_CAMPAIGN = 110;
/** 킬 보상 G — 무한·주간 (§L4) */
export const KILL_REWARD_G_ENDLESS = 45;
/** 무한 램프(31웨이브 이후) 킬 보상 감쇠 K ‰ (§L6) */
export const RAMP_REWARD_DECAY_PERMILLE = 300;
/** 무한·주간 시작 골드 (§L6) */
export const ENDLESS_START_GOLD = 400;

// ==================== 명령 (§E3) ====================

export const OP = {
  CALL_WAVE: 0,
  BUILD: 1,
  UPGRADE: 2,
  BRANCH: 3,
  SELL: 4,
  SET_TARGET: 5,
  PICK_AUGMENT: 6,
} as const;

/** op별 인자 수 — 인덱스 = op */
export const OP_ARG_COUNTS: readonly number[] = [0, 2, 1, 2, 1, 2, 1];
export const OP_MAX = 6;

/** 인자 형식 범위 (INVALID_INPUT 판정) — 그 시점에 수행 가능한지는 INVALID_COMMAND */
export const MAX_SLOT_ID = 31;
export const MAX_TOWER_KIND = 15;
export const BRANCH_COUNT = 2;
export const AUGMENT_CHOICES = 3;

/** 타게팅 — 선두·후미·최강(현재 HP)·최근접 (§C2) */
export const TARGET = {
  FIRST: 0,
  LAST: 1,
  STRONGEST: 2,
  NEAREST: 3,
} as const;
export const TARGET_MODE_COUNT = 4;

// ==================== 피해 (§C1) ====================

export const DAMAGE = {
  PHY: 0,
  MAG: 1,
  PURE: 2,
} as const;

/** 원소 태그 — 렌더러 색·파티클, 증강 시너지 (§C1) */
export const ELEMENT = {
  NONE: 0,
  FIRE: 1,
  ICE: 2,
  LIGHTNING: 3,
  POISON: 4,
} as const;

// ==================== 전투 (§C) ====================

/** 적 등급 — 공성포·용사냥꾼 추가 피해, 보스 공통 규칙 */
export const RANK = {
  NORMAL: 0,
  ELITE: 1,
  BOSS: 2,
} as const;

/** 공격 형태 (§C2·§C4) */
export const ATTACK = {
  /** 유도 투사체 — 비행 시간 뒤 명중, splash가 있으면 범위 */
  PROJECTILE: 0,
  /** 즉발 — 같은 틱 적용 (마법 볼트) */
  INSTANT: 1,
  /** 자기 주변 펄스 — 반경 안 전부 (서리탑) */
  PULSE: 2,
  /** 연쇄 — 표적에서 가까운 적으로 튄다 (테슬라) */
  CHAIN: 3,
  /** 지속 광선 — 같은 대상 유지 시 피해가 오른다 (비전 광선) */
  BEAM: 4,
} as const;

/** 상태효과 (§C3) — 비트는 렌더 표시용 */
export const STATUS = {
  SLOW: 0,
  STUN: 1,
  BURN: 2,
  POISON: 3,
  SHRED: 4,
  VULNERABLE: 5,
} as const;
export const STATUS_COUNT = 6;

/** 감속 후 이동 속도 하한 ‰ */
export const SLOW_FLOOR_PERMILLE = 300;
/** 파쇄 합계 상한 ‰ */
export const SHRED_CAP_PERMILLE = 500;
/** 화상 최대 스택(출처 타워당 1스택) */
export const BURN_STACK_LIMIT = 3;
/** 지속 피해 주기 — 30틱마다 */
export const DOT_INTERVAL_TICKS = 30;
/** 기절 점감 창 — 이 틱 안 연속 적용이면 1·2·3·4회째 지속 100·50·25·0% */
export const STUN_DIMINISH_WINDOW_TICKS = 120;
export const STUN_DIMINISH_PERMILLE: readonly number[] = [1000, 500, 250, 0];

/** 타워 특수 능력 종류 — 데이터(towers.ts)의 specials 항목 */
export const SPECIAL = {
  /** every번째 공격마다 피해 × mult‰ (헤드샷) */
  EVERY_NTH_DAMAGE: 0,
  /** 중독된 적 사망 시 반경 radius 안에 중독 전염 (역병) */
  PLAGUE: 1,
  /** 착탄 지점에 ticks 동안 화염 장판 — 화상을 계속 건다 (화염지대) */
  FIRE_ZONE: 2,
  /** 엘리트·보스에 피해 +value‰ (airOnly면 공중만) */
  RANK_BONUS: 3,
  /** every번째 공격마다 상태효과 status (철갑포탄 파쇄·빙결 기절·감전 기절) */
  EVERY_NTH_STATUS: 4,
  /** 이 타워가 건 취약(저주)을 가진 적이 죽으면 최대 HP value‰ 범위 마법 피해 (저주 폭발) */
  CURSE_EXPLODE: 5,
  /** 감속·기절 중 처치하면 반경 radius에 파편 피해 value (산산조각) */
  SHATTER: 6,
  /** 표적 근처 count마리를 더 맞힌다 (철갑 볼트 관통) */
  PIERCE: 7,
  /** 같은 대상 유지 시 초당 +value‰, 최대 max‰ (비전·붕괴 광선) */
  BEAM_RAMP: 8,
  /** 궁극: every틱마다 반경 radius 전체에 status (눈보라·전자기 펄스) */
  PERIODIC_PULSE: 9,
  /** 궁극: every틱마다 count연쇄 (폭풍 코일) */
  PERIODIC_CHAIN: 10,
} as const;

/** 적 능력 종류 — 데이터(enemies.ts)의 ability */
export const ABILITY = {
  NONE: 0,
  /** 사망 시 새끼 count마리 (각 최대 HP value‰) */
  SPLIT: 1,
  /** every틱마다 졸개 count마리 소환 (각 최대 HP value‰) */
  SUMMON: 2,
  /** every틱마다 반경 radius 안 아군 최대 HP value‰ 회복 */
  HEAL: 3,
  /** HP 50% 이하에서 물리·마법 저항을 맞바꾸고 박쥐 떼 count묶음 소환 (용) */
  PHASE_SWAP: 4,
} as const;

// ==================== 효과 엔진 (§C6 — 증강·주간 규칙 공통) ====================

/** 효과가 걸리는 범위 — target은 범위별 값(타워 id·원소·적 id, 나머지는 0) */
export const SCOPE = {
  TOWER: 0,
  TOWER_TAG: 1,
  ALL_TOWERS: 2,
  ENEMY: 3,
  ALL_ENEMIES: 4,
  ECONOMY: 5,
  RULES: 6,
} as const;

/** 효과 연산 — 수치는 곱(‰) → 더하기 → 덮어쓰기 순, 목록 순서대로 */
export const EFFECT_OP = {
  MUL: 0,
  ADD: 1,
  SET: 2,
  /** 규칙 켬 — value는 규칙 인자(예: 금지 타워 id) */
  FLAG: 3,
} as const;

/** 효과가 바꾸는 값 */
export const STAT = {
  // 타워
  DAMAGE: 0,
  RANGE: 1,
  SPLASH: 2,
  COST: 3,
  CHAIN_COUNT: 4,
  CHAIN_FALLOFF: 5,
  SLOW_POWER: 6,
  BURN_TICKS: 7,
  BURN_STACKS: 8,
  POISON_STACKS: 9,
  VULNERABLE_TICKS: 10,
  SHRED_TICKS: 11,
  // 적
  ENEMY_SPEED: 20,
  ENEMY_HP: 21,
  ENEMY_COUNT: 22,
  // 경제
  KILL_GOLD: 30,
  CLEAR_BONUS: 31,
  EARLY_CALL_BONUS: 32,
  COUNTDOWN: 33,
  SELL_REFUND: 34,
  START_GOLD: 35,
  LIVES: 36,
  // 규칙
  MAX_LEVEL: 40,
  AUGMENT_EVERY: 41,
  SLOTS_UNLOCK: 42,
  SLOTS_REMOVE: 43,
} as const;

/** 규칙 켬(op FLAG)의 종류 — stat 자리에 쓴다 */
export const FLAG = {
  ARCHER_PIERCE_THIRD: 100,
  CANNON_AFTERSHOCK: 101,
  MAGE_RESONANCE: 102,
  SLOW_SHRED: 103,
  CROSSBOW_GROUND: 104,
  SUPERCONDUCT: 105,
  ELEMENT_FUSION: 106,
  NO_SELL: 107,
  /** value = 금지 타워 id */
  BANNED_TOWER: 108,
  SPLIT_ON_DEATH: 109,
  /** 웨이브 생성 단계 규칙(S1) — 엔진은 표시만 */
  AIR_DOUBLE: 110,
  BOSS_ESCORT: 111,
} as const;

// ==================== 렌더 이벤트 (step의 events 버퍼 — 해시·결과에 영향 없음) ====================

/** 이벤트 1개 = [종류, a, b, c] 4칸 */
export const EVENT_STRIDE = 4;
export const EVENT = {
  /** a = 타워 id, b = 투사체 id, c = 표적 적 id */
  FIRE: 0,
  /** a = 적 id, b = 피해, c = 투사체 id */
  HIT: 1,
  /** a = 적 id, b = x, c = y */
  DEATH: 2,
  /** a = 적 id, b = 종류 */
  SPAWN: 3,
  /** a = 적 id, b = 깎인 목숨 */
  LEAK: 4,
  /** a = 웨이브 번호(1부터) */
  WAVE_START: 5,
  /** a = 웨이브 번호, b = 보너스 골드 */
  WAVE_CLEAR: 6,
  /** a = 적 id, b = STATUS, c = 값 */
  STATUS: 7,
  /** a = 타워 id, b = 반경 (펄스·궁극 펄스·폭발 — 렌더 충격파) */
  PULSE: 8,
  /** a = 앞 적 id, b = 다음 적 id, c = 타워 id (연쇄 번개 선) */
  CHAIN: 9,
  /** a = 적 id, b = ABILITY (소환·회복·페이즈 전환) */
  ABILITY: 10,
  /** a = 장판 id, b = x, c = y */
  ZONE: 11,
  /** a = 증강 카드 id, b = 고른 순서(0부터) */
  AUGMENT: 12,
} as const;

// ==================== PRNG 스트림 (§E1 — 용도별 독립) ====================

export const RNG_PURPOSE = {
  WAVE: 1,
  AUGMENT: 2,
  COMBAT: 3,
  /** 주간 판 구성(규칙 변형·금지 타워) — 상태에 두지 않고 판 시작 때 한 번 쓴다 */
  WEEKLY: 4,
} as const;

// ==================== 증강 (§L10) ====================

export const RARITY = {
  COMMON: 0,
  RARE: 1,
  LEGENDARY: 2,
} as const;
/** 희귀도 가중치 (정수) */
export const RARITY_WEIGHTS: readonly number[] = [70, 25, 5];
/** 전설은 이 웨이브 이후 제시부터 */
export const LEGENDARY_FROM_WAVE = 15;
/** 희귀 이상이 이 횟수 연속 안 나오면 다음 제시에 1장 보장 */
export const RARE_PITY_OFFERS = 3;
/** 기본 제시 주기 (웨이브) — R15는 4 */
export const AUGMENT_EVERY_DEFAULT = 5;

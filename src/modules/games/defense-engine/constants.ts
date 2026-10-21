/**
 * 타워 디펜스 엔진 상수 — 백엔드 리플레이 검증과 공유하는 계약 값 (defense DESIGN §E)
 *
 * 원본: next-bun/src/app/games/defense/engine/ → 사본: bun/src/modules/games/defense-engine/
 * 사본은 직접 수정하지 않는다. 동기화는 매니페스트(engine-dev/ENGINE_MANIFEST.json)로 검사한다
 * 이 폴더(data 포함)는 외부 import 없음·DOM·Date·Math.random·부동소수·Map/Set 순회 금지·ES2020 문법만 쓴다(§E1)
 * 비트 연산은 random.ts(PRNG·해시) 안에서만. 나눗셈은 Math.floor(a / b) — 피제수·제수는 음수가 아니다
 * 규칙·데이터(타워·적·스테이지 수치 포함)를 바꾸면 ENGINE_VERSION을 올리고 골든 픽스처·매니페스트를 다시 만든다
 */

export const ENGINE_VERSION = 1;

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
} as const;

// ==================== PRNG 스트림 (§E1 — 용도별 독립) ====================

export const RNG_PURPOSE = {
  WAVE: 1,
  AUGMENT: 2,
  COMBAT: 3,
} as const;

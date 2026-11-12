/**
 * 포트리스 엔진 상수 — 서버 권위 턴 판정과 공유하는 계약 값 (fortress DESIGN §10 엔진 계약 v1, D-008)
 *
 * 원본: next-bun/src/app/games/fortress/engine/ → 사본: bun/src/modules/fortress/engine/
 * 사본은 직접 수정하지 않는다. 동기화는 매니페스트(engine-dev/ENGINE_MANIFEST.json)로 검사한다
 * 이 폴더는 외부 import 없음·DOM·Date·Math.random·부동소수·삼각함수·Map/Set·typed array·ArrayBuffer 금지·ES2020 문법만 쓴다
 * 비트 연산은 random.ts(PRNG·해시) 안에서만. 나눗셈은 Math.floor(a / b) — 음수 피제수도 floor(−∞ 방향)로 같은 값이 나온다
 * state는 순수 JSON(정수·짧은 문자열·중첩 배열) — 서버가 Redis 스냅샷으로 그대로 저장한다
 * 규칙·데이터(탱크·무기·맵 수치 포함)를 바꾸면 ENGINE_VERSION을 올리고 골든 픽스처·매니페스트를 다시 만든다
 */

/** v2(D-023): 2인 시작 간격 축소(DUEL_SPAN) · 바람 최대 10 → 6 */
export const ENGINE_VERSION = 2;

// ==================== 시간·좌표 ====================

export const TICKS_PER_SECOND = 30;
/** 탄 좌표·속도 척도 — 1px = 1000 (탱크·지형은 px 정수) */
export const SUB = 1000;
/** SIN 표 척도 */
export const TRIG_SCALE = 10000;

// ==================== 월드 ====================

export const WORLD_WIDTH = 2048;
/** y는 아래로 증가 — 0 = 월드 위, WORLD_HEIGHT = 바닥 밖 경계 */
export const WORLD_HEIGHT = 1024;
/** 열당 고체 구간 상한 — 넘으면 가장 좁은 빈틈부터 메운다 */
export const MAX_SPAN_PAIRS = 8;

// ==================== 상한 (서버 CPU·DoS 보호) ====================

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
/** 경기 턴 상한 = 라운드 상한 × 시작 인원 */
export const MAX_ROUNDS = 30;
/** 한 턴 시뮬 틱 상한(이동 + 비행 + 정착) — 60초 */
export const MAX_TICKS_PER_TURN = 1800;
/** 한 턴 동시 비행 탄 상한 — 넘는 탄은 만들지 않는다 */
export const MAX_PROJECTILES = 16;
export const MAX_ACTIONS = MAX_ROUNDS * MAX_PLAYERS * 4;
export const SEED_MAX = 4294967295;

// ==================== 턴 ====================

export const ANGLE_MAX = 180;
export const POWER_MAX = 100;
/** v2: 10 → 6 — 맞바람이 센 판에서 최대 파워로도 닿지 않던 경우를 줄인다 */
export const WIND_MAX = 6;
/** 연속 스킵 이 횟수면 탈락 (D-004) */
export const MAX_SKIPS = 3;

// ==================== 물리 (틱당, SUB 단위) ====================

/** 파워 1당 발사 속도 — 파워 100 = 틱당 36px(바람 없이 45도 최대 사거리 약 2,160px — 월드 끝에서 끝까지) */
export const SPEED_PER_POWER = 360;
export const GRAVITY = 600;
/** 바람 1당 가로 가속 */
export const WIND_ACCEL = 30;
/** 탄이 한 번에 나아가는 충돌 검사 간격 상한(px) */
export const COLLISION_STEP_PX = 3;
/** 포구 높이 — 발사 지점 = 탱크 위치에서 위로 */
export const MUZZLE_HEIGHT = 12;

// ==================== 탱크 ====================

/** 탱크 판정 원 반지름(px) — 중심은 (x, y − TANK_RADIUS) */
export const TANK_RADIUS = 9;
/** 한 걸음(1px)에 오를 수 있는 높이 */
export const MAX_CLIMB = 4;
/** 이동 연출 속도 — 이벤트 틱 표시용 */
export const MOVE_PX_PER_TICK = 3;
/** 이 높이까지는 낙하 피해 없음 */
export const FALL_SAFE_PX = 24;
/** 안전 높이를 넘은 4px당 피해 1 */
export const FALL_PX_PER_DAMAGE = 4;
/** 스폰 위치 흔들림(px) */
export const SPAWN_JITTER = 48;
/** 스폰은 월드 가장자리에서 이만큼 안쪽 */
export const SPAWN_MARGIN = 160;
/** 2인 경기 시작 간격(px, 월드 폭의 55%) — 가운데 기준 좌우 대칭. 3~4인은 SPAWN_MARGIN 사이를 고르게 (v2: 끝과 끝(약 1,700px)은 최대 사거리 근처라 첫 턴에 못 맞히는 판이 많았다) */
export const DUEL_SPAN = 1126;

// ==================== 실패 사유 ====================

export const REASON = {
  NOT_RUNNING: 'NOT_RUNNING',
  BAD_KIND: 'BAD_KIND',
  MOVE_RANGE: 'MOVE_RANGE',
  ANGLE_RANGE: 'ANGLE_RANGE',
  POWER_RANGE: 'POWER_RANGE',
  WEAPON_UNKNOWN: 'WEAPON_UNKNOWN',
  WEAPON_COOLDOWN: 'WEAPON_COOLDOWN',
  SLOT_NOT_ALIVE: 'SLOT_NOT_ALIVE',
} as const;
export type ActionReason = (typeof REASON)[keyof typeof REASON];

/** createMatch·simulateMatch 설정 오류 */
export const CONFIG_REASON = {
  BAD_SEED: 'BAD_SEED',
  BAD_MAP: 'BAD_MAP',
  BAD_MODE: 'BAD_MODE',
  BAD_PLAYERS: 'BAD_PLAYERS',
  BAD_TEAMS: 'BAD_TEAMS',
  BAD_TANK: 'BAD_TANK',
  TOO_MANY_ACTIONS: 'TOO_MANY_ACTIONS',
} as const;
export type ConfigReason = (typeof CONFIG_REASON)[keyof typeof CONFIG_REASON];

// ==================== 난수 스트림 용도 ====================

export const STREAM = {
  MAP: 1,
  SPAWN: 2,
  MATCH: 3,
} as const;

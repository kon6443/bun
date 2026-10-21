/**
 * 테트리스 엔진 상수 — 백엔드 리플레이 검증과 공유하는 계약 값
 *
 * 원본: next-bun/src/app/games/tetris/engine/ → 사본: bun/src/modules/games/tetris-engine/
 * 이 폴더는 외부 import 없음·DOM·Date·Math.random·부동소수 금지·ES2020 문법만 쓴다.
 * 규칙(아래 값 포함)을 바꾸면 ENGINE_VERSION을 올리고 골든 픽스처를 다시 만든다.
 */

export const ENGINE_VERSION = 1;

// ==================== 판 ====================

export const BOARD_WIDTH = 10;
/** 위쪽 숨은 줄 수 — 판 좌표는 y가 아래로 증가, 0~19행이 숨은 줄 */
export const HIDDEN_ROWS = 20;
export const VISIBLE_ROWS = 20;
export const BOARD_ROWS = HIDDEN_ROWS + VISIBLE_ROWS;

/** 생성 위치 — 블록 상자 왼쪽 위 (JLSTZ 3×3은 3~5열, I·O 4×4는 3~6열) */
export const SPAWN_X = 3;
export const SPAWN_Y = 18;

export const PREVIEW_COUNT = 5;

// ==================== 시간 (프레임 = 1/60초) ====================

export const FRAMES_PER_SECOND = 60;
export const LOCK_DELAY_FRAMES = 30;
export const LOCK_RESET_LIMIT = 15;
/** 줄 삭제 없이 고정된 뒤 다음 블록까지 */
export const SPAWN_DELAY_FRAMES = 6;
/** 줄 삭제 연출 — 이 프레임이 지나면 줄을 지우고 다음 블록이 나온다 */
export const LINE_CLEAR_DELAY_FRAMES = 20;
/** 지연 중 누른 회전·하드드롭·홀드·이동을 다음 블록에 적용할 최대 개수 */
export const PENDING_ACTION_LIMIT = 16;

// ==================== 낙하 (프레임당 1/65536칸 고정소수점) ====================

export const GRAVITY_UNIT = 65536;
/** 20G — 한 프레임에 바닥까지 */
export const MAX_GRAVITY = 20 * GRAVITY_UNIT;
export const SOFT_DROP_FACTOR = 20;

/**
 * 레벨 1~20 중력 — 가이드라인 공식 (0.8 − (L−1)×0.007)^(L−1)초/칸을 미리 계산해 반올림한 값
 * 실행 중 부동소수 계산을 하지 않기 위해 상수로 둔다. 20G 초과분은 MAX_GRAVITY로 자른다
 */
export const GRAVITY_TABLE: readonly number[] = [
  1092, 1377, 1768, 2311, 3075, 4169, 5759, 8107, 11634, 17026,
  25416, 38709, 60169, 95483, 154742, 256187, 433425, 749597, 1325716, 2398490,
];

// ==================== 레벨·점수 ====================

export const MAX_LEVEL = 20;
export const LINES_PER_LEVEL = 10;

/** 줄 수(0~4) → 기본 점수 (× 레벨) */
export const LINE_CLEAR_SCORES: readonly number[] = [0, 100, 300, 500, 800];
/** T-스핀 줄 수(0~3) → 기본 점수 (× 레벨) */
export const T_SPIN_SCORES: readonly number[] = [400, 800, 1200, 1600];
/** T-스핀 미니 줄 수(0~2) → 기본 점수 (× 레벨) */
export const T_SPIN_MINI_SCORES: readonly number[] = [100, 200, 400];
export const COMBO_SCORE = 50;
export const SOFT_DROP_SCORE = 1;
export const HARD_DROP_SCORE = 2;

// ==================== 입력 ====================

/** 동작 코드 — 리플레이 입력 로그의 값. 바꾸면 ENGINE_VERSION을 올린다 */
export const ACTION = {
  LEFT_PRESS: 0,
  LEFT_RELEASE: 1,
  RIGHT_PRESS: 2,
  RIGHT_RELEASE: 3,
  SOFT_DROP_PRESS: 4,
  SOFT_DROP_RELEASE: 5,
  ROTATE_CW: 6,
  ROTATE_CCW: 7,
  HARD_DROP: 8,
  HOLD: 9,
} as const;

export const ACTION_CODE_MAX = 9;

// ==================== 리플레이 허용 범위 ====================

export const SEED_MAX = 4294967295;
export const DAS_MIN = 4;
export const DAS_MAX = 20;
export const ARR_MIN = 0;
export const ARR_MAX = 5;
export const DEFAULT_DAS = 10;
export const DEFAULT_ARR = 2;
/** 60분 */
export const MAX_FRAMES = 216000;
/** [deltaFrame, code] 쌍 6만 개 (60분 기준 초당 16.7회) */
export const MAX_INPUT_LENGTH = 120000;

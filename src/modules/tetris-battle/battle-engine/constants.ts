/**
 * 대전 래퍼 상수 — 백엔드 대전 검증과 공유하는 계약 값 (DESIGN §4·§5·§15)
 *
 * 원본: next-bun/src/app/games/tetris/battle-engine/ → 사본: bun/src/modules/tetris-battle/battle-engine/
 * 엔진 폴더와 같은 규칙: 외부 import 없음(엔진은 engine.ts로만)·DOM·Date·Math.random·부동소수 금지·ES2020 문법만.
 * 규칙(아래 값 포함)을 바꾸면 BATTLE_ENGINE_VERSION을 올리고 골든 픽스처를 다시 만든다.
 */

import { BOARD_WIDTH, MAX_FRAMES } from './engine';

export const BATTLE_ENGINE_VERSION = 1;

export const MAX_PLAYERS = 4;

// ==================== 공격 (DESIGN §4) ====================

/** 줄 수(0~4) → 공격 줄 — 싱글 0 · 더블 1 · 트리플 2 · 테트리스 4 */
export const LINE_ATTACK: readonly number[] = [0, 0, 1, 2, 4];
/** T-스핀 줄 수(0~3) → 공격 줄 */
export const T_SPIN_ATTACK: readonly number[] = [0, 2, 4, 6];
/** T-스핀 미니 줄 수(0~2) → 공격 줄 */
export const T_SPIN_MINI_ATTACK: readonly number[] = [0, 0, 1];
export const BACK_TO_BACK_BONUS = 1;
export const PERFECT_CLEAR_ATTACK = 10;
/**
 * LockEvent.combo(0 = 첫 삭제) → 추가 줄. 표의 "연속 삭제 n번째" n = combo + 1 (D-013)
 * 0→0 · 1~2→1 · 3~4→2 · 5~6→3 · 7~9→4 · 10 이상→5 (마지막 값이 상한)
 */
export const COMBO_ATTACK: readonly number[] = [0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];

/** 한 번의 공격이 낼 수 있는 최대 줄 — T-스핀 트리플 + B2B + 최대 콤보 + 퍼펙트 클리어 */
export const MAX_ATTACK = 6 + BACK_TO_BACK_BONUS + 5 + PERFECT_CLEAR_ATTACK;

// ==================== 가비지 (DESIGN §5) ====================

/** 가비지 칸 값 — 블록 값 1~7과 구분 (렌더러는 회색으로 그린다) */
export const GARBAGE_CELL = 8;
/** 받은 뒤 이 프레임이 지나야 판에 들어올 수 있다 (0.5초) */
export const GARBAGE_DELAY_FRAMES = 30;
/** 블록 하나가 고정될 때 들어오는 최대 줄 */
export const GARBAGE_CAP_PER_PIECE = 8;
export const GARBAGE_HOLE_MAX = BOARD_WIDTH - 1;

// ==================== 리플레이 허용 범위 ====================

export const MAX_BATTLE_FRAMES = MAX_FRAMES;
/** 받은 가비지 이벤트 수 상한 — 60분 동안 초당 1회를 넘지 않는다고 본다 */
export const MAX_GARBAGE_EVENTS = 3600;
/** 가비지 이벤트 id 상한 (받는 플레이어 기준 단조 증가 정수) */
export const GARBAGE_ID_MAX = 2147483647;

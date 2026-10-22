/**
 * 대전 래퍼 — 엔진 stepFrame을 감싸 공격 계산·가비지 상쇄·가비지 삽입을 한다 (DESIGN §5·§15)
 * 엔진 상태는 블록 고정 직후 지연 구간(active=false)에만 판을 바꾼다. 엔진 규칙·ENGINE_VERSION은 그대로다
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import {
  BACK_TO_BACK_BONUS,
  COMBO_ATTACK,
  GARBAGE_CAP_PER_PIECE,
  GARBAGE_CELL,
  GARBAGE_DELAY_FRAMES,
  GARBAGE_HOLE_MAX,
  GARBAGE_ID_MAX,
  LINE_ATTACK,
  MAX_ATTACK,
  MAX_GARBAGE_EVENTS,
  PERFECT_CLEAR_ATTACK,
  T_SPIN_ATTACK,
  T_SPIN_MINI_ATTACK,
} from './constants';
import { BOARD_ROWS, BOARD_WIDTH, type GameState, type LockEvent, createGame, stepFrame } from './engine';

/** 받은 가비지 — 서버가 정한 값 + 도착 프레임 */
export type GarbageEvent = {
  /** 받는 플레이어 기준 단조 증가 정수 */
  id: number;
  lines: number;
  /** 구멍 열 (0 ~ BOARD_WIDTH-1) */
  hole: number;
  /** 도착 프레임 = 받은 순간의 game.frame (그 프레임을 처리하기 전) */
  frame: number;
};

/** 대기열 항목 — 상쇄·일부 삽입으로 lines가 줄어든다 */
export type PendingGarbage = {
  id: number;
  lines: number;
  hole: number;
  /** 이 프레임부터 판에 들어올 수 있다 */
  activeAt: number;
};

/** 블록 하나 고정의 공격 결과 */
export type BattleLock = {
  /** 고정 순번 = 고정 직후 game.pieces */
  seq: number;
  frame: number;
  /** 공격표로 계산한 줄 */
  attack: number;
  /** 대기열을 상쇄하고 남아 상대에게 보낼 줄 */
  sent: number;
  /** 대기열 상쇄에 쓴 줄 */
  cancelled: number;
  perfectClear: boolean;
  /** 이 고정 뒤 판에 넣은 가비지 줄 */
  garbageApplied: number;
};

export type BattleState = {
  /** 라운드 시드 — 리플레이 기록용 (game.rng는 진행하며 바뀐다) */
  seed: number;
  game: GameState;
  queue: PendingGarbage[];
  /** 받은 순서대로 — 리플레이 기록 */
  received: GarbageEvent[];
  /** 공격이 있었던 고정만 */
  sentLog: BattleLock[];
  /** 판에 넣은 가비지 줄 합계 */
  garbageReceived: number;
  /** 가비지에 밀려 끝났는지 (블록 아웃·락 아웃은 엔진이 판정) */
  toppedOut: boolean;
};

export type StepBattleResult = { applied: number; lock: BattleLock | null };

// ==================== 공격 계산 ====================

function tableValue(table: readonly number[], index: number): number {
  return table[index < table.length ? index : table.length - 1];
}

/** 공격표(DESIGN §4) — 싱글 0, B2B +1, 콤보는 LockEvent.combo 기준, 퍼펙트 클리어 +10 */
export function computeAttack(lock: LockEvent, perfectClear: boolean): number {
  if (lock.lines === 0) return 0;
  let attack: number;
  if (lock.tSpin === 'full') attack = tableValue(T_SPIN_ATTACK, lock.lines);
  else if (lock.tSpin === 'mini') attack = tableValue(T_SPIN_MINI_ATTACK, lock.lines);
  else attack = tableValue(LINE_ATTACK, lock.lines);
  if (lock.backToBack) attack += BACK_TO_BACK_BONUS;
  if (lock.combo > 0) attack += tableValue(COMBO_ATTACK, lock.combo);
  if (perfectClear) attack += PERFECT_CLEAR_ATTACK;
  return attack;
}

/** 고정 직후(줄 제거 전) 비어 있지 않은 칸이 전부 지울 줄에 있으면 퍼펙트 클리어 */
export function isPerfectClear(board: Uint8Array, rows: readonly number[]): boolean {
  if (rows.length === 0) return false;
  for (let row = 0; row < BOARD_ROWS; row++) {
    if (rows.indexOf(row) !== -1) continue;
    for (let col = 0; col < BOARD_WIDTH; col++) {
      if (board[row * BOARD_WIDTH + col] !== 0) return false;
    }
  }
  return true;
}

// ==================== 생성·수신 ====================

export function createBattle(options: { seed: number; das: number; arr: number }): BattleState {
  return {
    seed: options.seed,
    game: createGame(options),
    queue: [],
    received: [],
    sentLog: [],
    garbageReceived: 0,
    toppedOut: false,
  };
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** 가비지 이벤트 하나가 올바른지 — id는 직전에 받은 id보다 커야 한다(재연결 중복 수신 방지). 실시간 수신과 리플레이 검증이 같은 기준을 쓴다 */
export function isValidGarbageEvent(lastId: number, id: unknown, lines: unknown, hole: unknown): boolean {
  return isIntInRange(id, lastId + 1, GARBAGE_ID_MAX) && isIntInRange(lines, 1, MAX_ATTACK) && isIntInRange(hole, 0, GARBAGE_HOLE_MAX);
}

/**
 * 가비지를 받은 즉시 부른다(다음 stepBattle 전) — 도착 프레임을 기록하고 대기열 뒤에 넣는다
 * 게임이 끝난 뒤 받은 것, 이벤트 수 상한을 넘는 것, 이미 받은 id, 범위를 벗어난 값은 버린다(false) — 기록에 남으면 경기 후 검증에서 무효가 된다
 */
export function receiveGarbage(bs: BattleState, ev: { id: number; lines: number; hole: number }): boolean {
  if (bs.game.over || bs.received.length >= MAX_GARBAGE_EVENTS) return false;
  const lastId = bs.received.length > 0 ? bs.received[bs.received.length - 1].id : -1;
  if (!isValidGarbageEvent(lastId, ev.id, ev.lines, ev.hole)) return false;
  const frame = bs.game.frame;
  bs.received.push({ id: ev.id, lines: ev.lines, hole: ev.hole, frame });
  bs.queue.push({ id: ev.id, lines: ev.lines, hole: ev.hole, activeAt: frame + GARBAGE_DELAY_FRAMES });
  return true;
}

/** 대기열에 남은 줄 합계 (화면 게이지·서버 보고용) */
export function pendingGarbageLines(bs: BattleState): number {
  let total = 0;
  for (let i = 0; i < bs.queue.length; i++) total += bs.queue[i].lines;
  return total;
}

// ==================== 상쇄·삽입 ====================

/** 대기열 앞에서부터 attack만큼 지운다 — 쓴 줄 수 */
function cancelGarbage(bs: BattleState, attack: number): number {
  let left = attack;
  while (left > 0 && bs.queue.length > 0) {
    const head = bs.queue[0];
    if (head.lines <= left) {
      left -= head.lines;
      bs.queue.shift();
    } else {
      head.lines -= left;
      left = 0;
    }
  }
  return attack - left;
}

function topOut(bs: BattleState): void {
  const game = bs.game;
  game.over = true;
  game.active = false;
  game.endFrame = game.frame;
  bs.toppedOut = true;
}

/** 판을 n줄 위로 밀고 아래 n줄을 가비지로 채운다 — 맨 위 n줄에 블록이 있으면 탑아웃(false) */
function pushGarbageRows(bs: BattleState, lines: number, hole: number): boolean {
  const board = bs.game.board;
  for (let i = 0; i < lines * BOARD_WIDTH; i++) {
    if (board[i] !== 0) return false;
  }
  board.copyWithin(0, lines * BOARD_WIDTH);
  for (let row = BOARD_ROWS - lines; row < BOARD_ROWS; row++) {
    for (let col = 0; col < BOARD_WIDTH; col++) board[row * BOARD_WIDTH + col] = col === hole ? 0 : GARBAGE_CELL;
  }
  return true;
}

/** 활성(activeAt ≤ lockFrame)인 대기열 항목을 앞에서부터 고정 1회당 최대 GARBAGE_CAP_PER_PIECE줄 넣는다 — 넣은 줄 수 */
function applyGarbage(bs: BattleState, lockFrame: number): number {
  let room = GARBAGE_CAP_PER_PIECE;
  let applied = 0;
  while (room > 0 && bs.queue.length > 0 && bs.queue[0].activeAt <= lockFrame) {
    const head = bs.queue[0];
    const lines = head.lines < room ? head.lines : room;
    if (!pushGarbageRows(bs, lines, head.hole)) {
      topOut(bs);
      break;
    }
    applied += lines;
    room -= lines;
    head.lines -= lines;
    if (head.lines === 0) bs.queue.shift();
  }
  bs.garbageReceived += applied;
  return applied;
}

// ==================== 프레임 ====================

/**
 * 한 프레임 — 엔진 stepFrame + 고정 처리. 고정은 stepFrame당 최대 1회라 game.pieces 증가로 감지한다
 * 고정 처리 순서: 공격 계산(퍼펙트 클리어는 줄 제거 전 판으로) → 대기열 상쇄 → 줄을 못 지웠으면 가비지 삽입(콤보 중 차단)
 */
export function stepBattle(bs: BattleState, actions: ArrayLike<number>, count: number): StepBattleResult {
  const game = bs.game;
  const piecesBefore = game.pieces;
  const applied = stepFrame(game, actions, count);
  const lock = game.lastLock;
  if (game.pieces === piecesBefore || lock === null) return { applied, lock: null };

  const perfectClear = isPerfectClear(game.board, lock.rows);
  const attack = computeAttack(lock, perfectClear);
  const cancelled = attack > 0 ? cancelGarbage(bs, attack) : 0;
  const result: BattleLock = {
    seq: game.pieces,
    frame: lock.frame,
    attack,
    sent: attack - cancelled,
    cancelled,
    perfectClear,
    garbageApplied: 0,
  };
  // 락 아웃으로 이미 끝났으면 가비지를 넣지 않는다
  if (lock.lines === 0 && !game.over) result.garbageApplied = applyGarbage(bs, lock.frame);
  if (attack > 0) bs.sentLog.push(result);
  return { applied, lock: result };
}

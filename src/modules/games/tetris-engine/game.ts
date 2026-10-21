/**
 * 게임 상태와 틱 함수 — 실시간 플레이와 리플레이 검증이 같은 stepFrame을 쓴다 (플레이 결과 = 리플레이 결과)
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import {
  ACTION,
  BOARD_ROWS,
  BOARD_WIDTH,
  COMBO_SCORE,
  GRAVITY_TABLE,
  GRAVITY_UNIT,
  HARD_DROP_SCORE,
  HIDDEN_ROWS,
  LINE_CLEAR_DELAY_FRAMES,
  LINE_CLEAR_SCORES,
  LINES_PER_LEVEL,
  LOCK_DELAY_FRAMES,
  LOCK_RESET_LIMIT,
  MAX_GRAVITY,
  MAX_LEVEL,
  PENDING_ACTION_LIMIT,
  PREVIEW_COUNT,
  SOFT_DROP_FACTOR,
  SOFT_DROP_SCORE,
  SPAWN_DELAY_FRAMES,
  SPAWN_X,
  SPAWN_Y,
  T_SPIN_MINI_SCORES,
  T_SPIN_SCORES,
} from './constants';
import {
  PIECE,
  PIECE_CELLS,
  PIECE_COUNT,
  T_CORNERS,
  T_FRONT_CORNERS,
  T_SPIN_UPGRADE_KICK_INDEX,
  getKicks,
} from './pieces';
import { fnv1aHex, shuffleBag } from './random';

export type TSpinKind = 'none' | 'mini' | 'full';

/** 블록 고정 결과 — 렌더러 연출·통계용 */
export type LockEvent = {
  frame: number;
  piece: number;
  lines: number;
  /** 지운 줄 번호 (판 좌표, 위→아래) — 줄 삭제 지연 동안 렌더러가 연출한다 */
  rows: number[];
  tSpin: TSpinKind;
  backToBack: boolean;
  /** 0 = 첫 삭제, 1 이상 = 연속 삭제 */
  combo: number;
  points: number;
};

export type GameState = {
  das: number;
  arr: number;
  rng: number;
  /** BOARD_ROWS × BOARD_WIDTH, 칸 값 0 = 빈칸·1~7 = 블록 종류 + 1 */
  board: Uint8Array;
  queue: number[];

  /** 조작 중인 블록이 있는지 (지연 중이면 false) */
  active: boolean;
  piece: number;
  rotation: number;
  x: number;
  y: number;
  /** -1 = 비어 있음 */
  hold: number;
  holdUsed: boolean;

  gravityAcc: number;
  lockTimer: number;
  lockResets: number;
  lowestY: number;
  /** 마지막 성공 동작이 회전인지 (T-스핀 판정) */
  lastMoveRotation: boolean;
  lastKickIndex: number;

  /** 다음 블록까지 남은 프레임 */
  delay: number;
  /** 지연 중 지울 줄 */
  clearingRows: number[];
  /** 지연 중 누른 즉시 동작 — 다음 블록이 나오면 순서대로 적용 */
  pending: number[];

  leftHeld: boolean;
  rightHeld: boolean;
  softDropHeld: boolean;
  /** -1 왼쪽 · 0 없음 · 1 오른쪽 */
  shiftDirection: number;
  shiftCharge: number;
  shiftPressFrame: number;

  /** 다음에 처리할 프레임 번호 = 지금까지 처리한 프레임 수 */
  frame: number;
  over: boolean;
  /** 게임 오버가 난 프레임까지의 프레임 수 (over일 때만 의미) */
  endFrame: number;

  score: number;
  lines: number;
  level: number;
  pieces: number;
  tSpins: number;
  tetrises: number;
  /** -1 = 직전 고정에서 줄을 지우지 못함 */
  combo: number;
  maxCombo: number;
  backToBack: boolean;
  lastLock: LockEvent | null;
};

// ==================== 생성 ====================

export function createGame(options: { seed: number; das: number; arr: number }): GameState {
  const state: GameState = {
    das: options.das,
    arr: options.arr,
    rng: options.seed | 0,
    board: new Uint8Array(BOARD_ROWS * BOARD_WIDTH),
    queue: [],
    active: false,
    piece: 0,
    rotation: 0,
    x: 0,
    y: 0,
    hold: -1,
    holdUsed: false,
    gravityAcc: 0,
    lockTimer: 0,
    lockResets: 0,
    lowestY: 0,
    lastMoveRotation: false,
    lastKickIndex: 0,
    delay: 0,
    clearingRows: [],
    pending: [],
    leftHeld: false,
    rightHeld: false,
    softDropHeld: false,
    shiftDirection: 0,
    shiftCharge: 0,
    shiftPressFrame: -1,
    frame: 0,
    over: false,
    endFrame: 0,
    score: 0,
    lines: 0,
    level: 1,
    pieces: 0,
    tSpins: 0,
    tetrises: 0,
    combo: -1,
    maxCombo: 0,
    backToBack: false,
    lastLock: null,
  };
  fillQueue(state);
  spawnPiece(state, takeNextPiece(state));
  return state;
}

function fillQueue(state: GameState): void {
  while (state.queue.length <= PREVIEW_COUNT) {
    const [rng, bag] = shuffleBag(state.rng, PIECE_COUNT);
    state.rng = rng;
    for (let i = 0; i < bag.length; i++) state.queue.push(bag[i]);
  }
}

function takeNextPiece(state: GameState): number {
  const piece = state.queue.shift() as number;
  fillQueue(state);
  return piece;
}

// ==================== 판 조회 ====================

export function getCell(board: Uint8Array, x: number, y: number): number {
  return board[y * BOARD_WIDTH + x];
}

function isBlocked(board: Uint8Array, x: number, y: number): boolean {
  if (x < 0 || x >= BOARD_WIDTH || y < 0 || y >= BOARD_ROWS) return true;
  return board[y * BOARD_WIDTH + x] !== 0;
}

export function collides(board: Uint8Array, piece: number, rotation: number, x: number, y: number): boolean {
  const cells = PIECE_CELLS[piece][rotation];
  for (let i = 0; i < 8; i += 2) {
    if (isBlocked(board, x + cells[i], y + cells[i + 1])) return true;
  }
  return false;
}

/** 지금 블록을 그대로 떨어뜨렸을 때의 y (고스트) */
export function getDropY(state: GameState): number {
  let y = state.y;
  while (!collides(state.board, state.piece, state.rotation, state.x, y + 1)) y++;
  return y;
}

function isGrounded(state: GameState): boolean {
  return collides(state.board, state.piece, state.rotation, state.x, state.y + 1);
}

// ==================== 블록 생성·이동 ====================

function endGame(state: GameState): void {
  state.over = true;
  state.active = false;
  state.endFrame = state.frame + 1;
}

/** 블록을 생성 위치에 놓는다 — 겹치면 블록 아웃(게임 오버). 비어 있으면 한 칸 바로 내려온다 */
function spawnPiece(state: GameState, piece: number): void {
  state.piece = piece;
  state.rotation = 0;
  state.x = SPAWN_X;
  state.y = SPAWN_Y;
  state.gravityAcc = 0;
  state.lockTimer = 0;
  state.lockResets = 0;
  state.lastMoveRotation = false;
  state.lastKickIndex = 0;
  if (collides(state.board, piece, 0, SPAWN_X, SPAWN_Y)) {
    endGame(state);
    return;
  }
  if (!collides(state.board, piece, 0, SPAWN_X, SPAWN_Y + 1)) state.y = SPAWN_Y + 1;
  state.lowestY = state.y;
  state.active = true;
}

/** 이동·회전 성공 — 바닥에 닿아 고정 대기 중이면 대기를 처음부터 (최대 LOCK_RESET_LIMIT회) */
function onMoveSucceeded(state: GameState): void {
  if (state.lockTimer > 0 && state.lockResets < LOCK_RESET_LIMIT) {
    state.lockTimer = 0;
    state.lockResets++;
  }
}

/** 더 낮은 줄에 처음 닿으면 고정 대기·리셋 횟수를 새로 시작 */
function onMovedDown(state: GameState): void {
  state.lastMoveRotation = false;
  if (state.y > state.lowestY) {
    state.lowestY = state.y;
    state.lockResets = 0;
    state.lockTimer = 0;
  }
}

function tryShift(state: GameState, dx: number): boolean {
  if (collides(state.board, state.piece, state.rotation, state.x + dx, state.y)) return false;
  state.x += dx;
  state.lastMoveRotation = false;
  onMoveSucceeded(state);
  return true;
}

function tryRotate(state: GameState, clockwise: boolean): boolean {
  if (state.piece === PIECE.O) return false;
  const to = (state.rotation + (clockwise ? 1 : 3)) % 4;
  const kicks = getKicks(state.piece, state.rotation, clockwise);
  for (let k = 0; k < 5; k++) {
    const nx = state.x + kicks[k * 2];
    const ny = state.y + kicks[k * 2 + 1];
    if (!collides(state.board, state.piece, to, nx, ny)) {
      state.x = nx;
      state.y = ny;
      state.rotation = to;
      state.lastMoveRotation = true;
      state.lastKickIndex = k;
      onMoveSucceeded(state);
      if (state.y > state.lowestY) {
        state.lowestY = state.y;
        state.lockResets = 0;
        state.lockTimer = 0;
      }
      return true;
    }
  }
  return false;
}

function hardDrop(state: GameState): void {
  const dropY = getDropY(state);
  const distance = dropY - state.y;
  if (distance > 0) {
    state.y = dropY;
    state.lastMoveRotation = false;
  }
  state.score += distance * HARD_DROP_SCORE;
  lockPiece(state);
}

function holdPiece(state: GameState): void {
  if (state.holdUsed) return;
  const current = state.piece;
  const next = state.hold === -1 ? takeNextPiece(state) : state.hold;
  state.hold = current;
  spawnPiece(state, next);
  state.holdUsed = true;
}

// ==================== 고정·점수 ====================

function detectTSpin(state: GameState): TSpinKind {
  if (state.piece !== PIECE.T || !state.lastMoveRotation) return 'none';
  const occupied: boolean[] = [];
  let count = 0;
  for (let i = 0; i < 4; i++) {
    const blocked = isBlocked(state.board, state.x + T_CORNERS[i * 2], state.y + T_CORNERS[i * 2 + 1]);
    occupied.push(blocked);
    if (blocked) count++;
  }
  if (count < 3) return 'none';
  const front = T_FRONT_CORNERS[state.rotation];
  if ((occupied[front[0]] && occupied[front[1]]) || state.lastKickIndex === T_SPIN_UPGRADE_KICK_INDEX) {
    return 'full';
  }
  return 'mini';
}

function lockPiece(state: GameState): void {
  const tSpin = detectTSpin(state);
  const cells = PIECE_CELLS[state.piece][state.rotation];
  const value = state.piece + 1;
  let lockOut = true;
  for (let i = 0; i < 8; i += 2) {
    const cy = state.y + cells[i + 1];
    state.board[cy * BOARD_WIDTH + state.x + cells[i]] = value;
    if (cy >= HIDDEN_ROWS) lockOut = false;
  }
  state.pieces++;
  state.active = false;

  const rows: number[] = [];
  for (let row = 0; row < BOARD_ROWS; row++) {
    let full = true;
    for (let col = 0; col < BOARD_WIDTH; col++) {
      if (state.board[row * BOARD_WIDTH + col] === 0) {
        full = false;
        break;
      }
    }
    if (full) rows.push(row);
  }
  const lines = rows.length;

  // 점수는 줄을 지우기 전 레벨로 계산한다
  const level = state.level;
  let base: number;
  let difficult = false;
  if (tSpin === 'full') {
    base = T_SPIN_SCORES[lines < 3 ? lines : 3];
    difficult = lines > 0;
  } else if (tSpin === 'mini') {
    base = T_SPIN_MINI_SCORES[lines < 2 ? lines : 2];
    difficult = lines > 0;
  } else {
    base = LINE_CLEAR_SCORES[lines];
    difficult = lines === 4;
  }
  let points = base * level;
  let backToBack = false;
  if (lines > 0) {
    if (difficult) {
      if (state.backToBack) {
        points = (points * 3) >> 1;
        backToBack = true;
      }
      state.backToBack = true;
    } else {
      state.backToBack = false;
    }
    state.combo++;
    if (state.combo > 0) points += COMBO_SCORE * state.combo * level;
    if (state.combo > state.maxCombo) state.maxCombo = state.combo;
  } else {
    state.combo = -1;
  }
  state.score += points;
  if (tSpin !== 'none') state.tSpins++;
  if (lines === 4) state.tetrises++;
  state.lines += lines;
  const nextLevel = 1 + (state.lines - (state.lines % LINES_PER_LEVEL)) / LINES_PER_LEVEL;
  state.level = nextLevel < MAX_LEVEL ? nextLevel : MAX_LEVEL;

  state.lastLock = {
    frame: state.frame,
    piece: state.piece,
    lines,
    rows,
    tSpin,
    backToBack,
    combo: lines > 0 ? state.combo : -1,
    points,
  };

  // 락 아웃: 줄을 지우지 못했고 블록 전체가 숨은 줄에 있으면 게임 오버
  if (lines === 0 && lockOut) {
    endGame(state);
    return;
  }

  state.holdUsed = false;
  state.clearingRows = rows;
  state.delay = lines > 0 ? LINE_CLEAR_DELAY_FRAMES : SPAWN_DELAY_FRAMES;
}

function removeRows(state: GameState, rows: number[]): void {
  const board = state.board;
  let write = BOARD_ROWS - 1;
  for (let read = BOARD_ROWS - 1; read >= 0; read--) {
    if (rows.indexOf(read) !== -1) continue;
    if (write !== read) board.copyWithin(write * BOARD_WIDTH, read * BOARD_WIDTH, (read + 1) * BOARD_WIDTH);
    write--;
  }
  board.fill(0, 0, (write + 1) * BOARD_WIDTH);
}

// ==================== 입력 ====================

function shiftOnce(state: GameState, direction: number): void {
  if (state.active) tryShift(state, direction);
}

function pressShift(state: GameState, direction: number): void {
  state.shiftDirection = direction;
  state.shiftCharge = 0;
  state.shiftPressFrame = state.frame;
  if (state.active) {
    tryShift(state, direction);
  } else if (state.pending.length < PENDING_ACTION_LIMIT) {
    state.pending.push(direction < 0 ? ACTION.LEFT_PRESS : ACTION.RIGHT_PRESS);
  }
}

/** 누르고 있던 방향을 놓았을 때 — 반대쪽이 눌려 있으면 그쪽으로 DAS를 새로 충전 */
function releaseShift(state: GameState, direction: number, otherHeld: boolean): void {
  if (state.shiftDirection !== direction) return;
  if (otherHeld) {
    state.shiftDirection = -direction;
    state.shiftCharge = 0;
    state.shiftPressFrame = state.frame;
  } else {
    state.shiftDirection = 0;
  }
}

function applyInstant(state: GameState, code: number): void {
  switch (code) {
    case ACTION.LEFT_PRESS:
      shiftOnce(state, -1);
      break;
    case ACTION.RIGHT_PRESS:
      shiftOnce(state, 1);
      break;
    case ACTION.ROTATE_CW:
      tryRotate(state, true);
      break;
    case ACTION.ROTATE_CCW:
      tryRotate(state, false);
      break;
    case ACTION.HARD_DROP:
      hardDrop(state);
      break;
    case ACTION.HOLD:
      holdPiece(state);
      break;
  }
}

function applyAction(state: GameState, code: number): void {
  switch (code) {
    case ACTION.LEFT_PRESS:
      state.leftHeld = true;
      pressShift(state, -1);
      return;
    case ACTION.LEFT_RELEASE:
      state.leftHeld = false;
      releaseShift(state, -1, state.rightHeld);
      return;
    case ACTION.RIGHT_PRESS:
      state.rightHeld = true;
      pressShift(state, 1);
      return;
    case ACTION.RIGHT_RELEASE:
      state.rightHeld = false;
      releaseShift(state, 1, state.leftHeld);
      return;
    case ACTION.SOFT_DROP_PRESS:
      state.softDropHeld = true;
      return;
    case ACTION.SOFT_DROP_RELEASE:
      state.softDropHeld = false;
      return;
  }
  if (state.active) {
    applyInstant(state, code);
  } else if (state.pending.length < PENDING_ACTION_LIMIT) {
    state.pending.push(code);
  }
}

// ==================== 프레임 단계 ====================

function runPending(state: GameState): void {
  const pending = state.pending;
  state.pending = [];
  for (let i = 0; i < pending.length && state.active; i++) applyInstant(state, pending[i]);
}

function autoShift(state: GameState): void {
  if (state.shiftDirection === 0) return;
  if (state.shiftPressFrame !== state.frame) state.shiftCharge++;
  if (!state.active || state.shiftCharge < state.das) return;
  if (state.arr === 0) {
    while (tryShift(state, state.shiftDirection)) {
      // 벽이나 블록에 닿을 때까지
    }
  } else if ((state.shiftCharge - state.das) % state.arr === 0) {
    tryShift(state, state.shiftDirection);
  }
}

function applyGravity(state: GameState): void {
  const base = GRAVITY_TABLE[state.level - 1];
  const normal = base < MAX_GRAVITY ? base : MAX_GRAVITY;
  const soft = normal * SOFT_DROP_FACTOR;
  const gravity = state.softDropHeld ? (soft < MAX_GRAVITY ? soft : MAX_GRAVITY) : normal;
  state.gravityAcc += gravity;
  while (state.gravityAcc >= GRAVITY_UNIT) {
    if (isGrounded(state)) {
      state.gravityAcc = 0;
      break;
    }
    state.y++;
    state.gravityAcc -= GRAVITY_UNIT;
    if (state.softDropHeld) state.score += SOFT_DROP_SCORE;
    onMovedDown(state);
  }
}

function updateLock(state: GameState): void {
  if (!isGrounded(state)) {
    state.lockTimer = 0;
    return;
  }
  state.lockTimer++;
  if (state.lockTimer >= LOCK_DELAY_FRAMES) lockPiece(state);
}

/**
 * 한 프레임을 진행한다 — 실시간 플레이와 리플레이가 공유하는 유일한 틱
 * 순서: 지연 카운트다운·생성 → 이 프레임 입력(순서대로) → DAS/ARR → 중력 → 고정 대기
 * @returns 적용한 입력 수 — count보다 작으면 중간에 게임 오버가 났다(남은 입력은 게임 오버 이후)
 */
export function stepFrame(state: GameState, actions: ArrayLike<number>, count: number): number {
  if (state.over) return 0;

  if (!state.active) {
    state.delay--;
    if (state.delay <= 0) {
      if (state.clearingRows.length > 0) {
        removeRows(state, state.clearingRows);
        state.clearingRows = [];
      }
      spawnPiece(state, takeNextPiece(state));
      if (state.active) runPending(state);
    }
  }

  let applied = 0;
  for (; applied < count && !state.over; applied++) applyAction(state, actions[applied]);

  if (!state.over) {
    autoShift(state);
    if (state.active) applyGravity(state);
    if (state.active) updateLock(state);
  }

  state.frame++;
  return applied;
}

/** 최종 판 해시 — 리플레이 결과 비교용 */
export function getBoardHash(state: GameState): string {
  return fnv1aHex(state.board);
}

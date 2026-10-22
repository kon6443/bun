// jest 이식 — 원본 `battle-engine/battle.test.ts`와 이 import 줄만 다르다(vitest → jest 전역)
import { ACTION, BOARD_WIDTH, type GameState, type LockEvent, PIECE, getDropY } from './engine';
import {
  type BattleState,
  GARBAGE_CAP_PER_PIECE,
  GARBAGE_CELL,
  GARBAGE_DELAY_FRAMES,
  MAX_GARBAGE_EVENTS,
  computeAttack,
  createBattle,
  isPerfectClear,
  pendingGarbageLines,
  receiveGarbage,
  stepBattle,
} from './index';

const lock = (patch: Partial<LockEvent>): LockEvent => ({
  frame: 0,
  piece: PIECE.I,
  lines: 0,
  rows: [],
  tSpin: 'none',
  backToBack: false,
  combo: -1,
  points: 0,
  ...patch,
});

const newBattle = () => createBattle({ seed: 12345, das: 10, arr: 2 });

const step = (bs: BattleState, ...actions: number[]) => stepBattle(bs, actions, actions.length);

/** 판의 한 줄을 채운다 (holes 열은 비움) — y는 판 좌표(0 = 맨 위 숨은 줄, 39 = 맨 아래) */
function fillRow(game: GameState, y: number, holes: number[] = []): void {
  for (let x = 0; x < BOARD_WIDTH; x++) game.board[y * BOARD_WIDTH + x] = holes.includes(x) ? 0 : 7;
}

function setPiece(game: GameState, piece: number, rotation: number, x: number, y: number): void {
  game.piece = piece;
  game.rotation = rotation;
  game.x = x;
  game.y = y;
  game.lowestY = y;
  game.lockTimer = 0;
  game.lockResets = 0;
  game.lastMoveRotation = false;
  game.active = true;
}

/** 세로 I를 9열에 떨어뜨린다 */
function dropVerticalI(bs: BattleState) {
  setPiece(bs.game, PIECE.I, 1, 7, 20);
  bs.game.y = getDropY(bs.game);
  return step(bs, ACTION.HARD_DROP);
}

/** 줄을 지우지 않는 고정 — 왼쪽 위에 가로 I */
function dropNoClear(bs: BattleState) {
  setPiece(bs.game, PIECE.I, 0, 0, 20);
  return step(bs, ACTION.HARD_DROP);
}

/** 다음 블록이 나올 때까지 입력 없이 */
function waitActive(bs: BattleState): void {
  for (let i = 0; i < 100 && !bs.game.active && !bs.game.over; i++) step(bs);
}

function countGarbageRows(game: GameState): number {
  let rows = 0;
  for (let y = 0; y < 40; y++) {
    let garbage = 0;
    for (let x = 0; x < BOARD_WIDTH; x++) if (game.board[y * BOARD_WIDTH + x] === GARBAGE_CELL) garbage++;
    if (garbage === BOARD_WIDTH - 1) rows++;
  }
  return rows;
}

describe('공격표 (DESIGN §4)', () => {
  it('줄 수: 싱글 0 · 더블 1 · 트리플 2 · 테트리스 4, 줄 없음 0', () => {
    expect([0, 1, 2, 3, 4].map((lines) => computeAttack(lock({ lines, combo: lines > 0 ? 0 : -1 }), false))).toEqual([0, 0, 1, 2, 4]);
  });

  it('T-스핀 싱글/더블/트리플 2/4/6, 미니 싱글/더블 0/1, 줄 없는 T-스핀 0', () => {
    expect([1, 2, 3].map((lines) => computeAttack(lock({ lines, tSpin: 'full', combo: 0 }), false))).toEqual([2, 4, 6]);
    expect([1, 2].map((lines) => computeAttack(lock({ lines, tSpin: 'mini', combo: 0 }), false))).toEqual([0, 1]);
    expect(computeAttack(lock({ tSpin: 'full' }), false)).toBe(0);
    expect(computeAttack(lock({ tSpin: 'mini' }), false)).toBe(0);
  });

  it('B2B +1, 퍼펙트 클리어 +10', () => {
    expect(computeAttack(lock({ lines: 4, backToBack: true, combo: 0 }), false)).toBe(5);
    expect(computeAttack(lock({ lines: 2, tSpin: 'full', backToBack: true, combo: 0 }), false)).toBe(5);
    expect(computeAttack(lock({ lines: 1, combo: 0 }), true)).toBe(10);
    expect(computeAttack(lock({ lines: 4, combo: 0 }), true)).toBe(14);
  });

  it('콤보: lock.combo 0→0 · 1~2→1 · 3~4→2 · 5~6→3 · 7~9→4 · 10 이상→5 (싱글 기준)', () => {
    const bonus = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 30].map((combo) => computeAttack(lock({ lines: 1, combo }), false));
    expect(bonus).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 5]);
  });
});

describe('퍼펙트 클리어 판정', () => {
  it('지울 줄 밖에 칸이 없으면 true, 하나라도 있으면 false, 지울 줄이 없으면 false', () => {
    const bs = newBattle();
    fillRow(bs.game, 39);
    fillRow(bs.game, 38);
    expect(isPerfectClear(bs.game.board, [38, 39])).toBe(true);
    bs.game.board[37 * BOARD_WIDTH] = 3;
    expect(isPerfectClear(bs.game.board, [38, 39])).toBe(false);
    expect(isPerfectClear(new Uint8Array(400), [])).toBe(false);
  });

  it('실제 고정: 3줄 + 세로 I 테트리스로 판이 비면 PC — 4 + 10', () => {
    const bs = newBattle();
    for (let i = 0; i < 4; i++) fillRow(bs.game, 39 - i, [9]);
    const { lock: result } = dropVerticalI(bs);
    expect(result).toMatchObject({ attack: 14, sent: 14, perfectClear: true });
  });
});

describe('가비지 수신·상쇄', () => {
  it('받으면 도착 프레임 + 30에 활성되는 대기열 항목이 된다', () => {
    const bs = newBattle();
    step(bs);
    step(bs);
    expect(receiveGarbage(bs, { id: 1, lines: 3, hole: 4 })).toBe(true);
    expect(bs.received).toEqual([{ id: 1, lines: 3, hole: 4, frame: 2 }]);
    expect(bs.queue).toEqual([{ id: 1, lines: 3, hole: 4, activeAt: 2 + GARBAGE_DELAY_FRAMES }]);
    expect(pendingGarbageLines(bs)).toBe(3);
  });

  it('이미 받은 id·범위를 벗어난 값은 버린다 (리플레이 검증과 같은 기준)', () => {
    const bs = newBattle();
    expect(receiveGarbage(bs, { id: 3, lines: 2, hole: 1 })).toBe(true);
    expect(receiveGarbage(bs, { id: 3, lines: 2, hole: 1 })).toBe(false); // 재연결 중복
    expect(receiveGarbage(bs, { id: 2, lines: 2, hole: 1 })).toBe(false);
    expect(receiveGarbage(bs, { id: 4, lines: 0, hole: 1 })).toBe(false);
    expect(receiveGarbage(bs, { id: 4, lines: -2, hole: 1 })).toBe(false);
    expect(receiveGarbage(bs, { id: 4, lines: 23, hole: 1 })).toBe(false);
    expect(receiveGarbage(bs, { id: 4, lines: 2, hole: 10 })).toBe(false);
    expect(receiveGarbage(bs, { id: 4, lines: 1.5, hole: 1 })).toBe(false);
    expect(receiveGarbage(bs, { id: 4, lines: 22, hole: 9 })).toBe(true);
    expect(bs.received.map((r) => r.id)).toEqual([3, 4]);
  });

  it('이벤트 수 상한을 넘으면 버린다 (리플레이 검증 상한과 같다)', () => {
    const bs = newBattle();
    for (let id = 0; id < MAX_GARBAGE_EVENTS; id++) expect(receiveGarbage(bs, { id, lines: 1, hole: 0 })).toBe(true);
    expect(receiveGarbage(bs, { id: MAX_GARBAGE_EVENTS, lines: 1, hole: 0 })).toBe(false);
  });

  it('공격은 대기열 앞에서부터 상쇄하고 남은 만큼만 보낸다 — 판에는 들어오지 않는다', () => {
    const bs = newBattle();
    receiveGarbage(bs, { id: 1, lines: 1, hole: 0 });
    receiveGarbage(bs, { id: 2, lines: 2, hole: 5 });
    for (let i = 0; i < 4; i++) fillRow(bs.game, 39 - i, [9]);
    bs.game.board[35 * BOARD_WIDTH] = 3; // PC가 되지 않게
    const { lock: result } = dropVerticalI(bs);
    expect(result).toMatchObject({ attack: 4, cancelled: 3, sent: 1, garbageApplied: 0 });
    expect(bs.queue).toEqual([]);
    expect(bs.sentLog).toHaveLength(1);
  });

  it('공격이 대기열보다 작으면 앞 항목 줄만 줄고 구멍은 그대로', () => {
    const bs = newBattle();
    receiveGarbage(bs, { id: 1, lines: 5, hole: 2 });
    for (let i = 0; i < 2; i++) fillRow(bs.game, 39 - i, [9]);
    bs.game.board[30 * BOARD_WIDTH] = 3;
    const { lock: result } = dropVerticalI(bs); // 더블 = 1
    expect(result).toMatchObject({ attack: 1, cancelled: 1, sent: 0 });
    expect(bs.queue).toEqual([{ id: 1, lines: 4, hole: 2, activeAt: GARBAGE_DELAY_FRAMES }]);
  });
});

describe('가비지 삽입', () => {
  it('지연 30프레임이 지나지 않은 가비지는 들어오지 않는다', () => {
    const bs = newBattle();
    receiveGarbage(bs, { id: 1, lines: 2, hole: 3 }); // activeAt 30
    const { lock: result } = dropNoClear(bs); // 0프레임 고정
    expect(result?.garbageApplied).toBe(0);
    expect(pendingGarbageLines(bs)).toBe(2);
  });

  it('활성 가비지는 줄을 못 지운 고정 직후 판 아래로 들어오고 구멍 열만 빈다', () => {
    const bs = newBattle();
    receiveGarbage(bs, { id: 1, lines: 2, hole: 3 });
    for (let i = 0; i < GARBAGE_DELAY_FRAMES; i++) step(bs);
    const { lock: result } = dropNoClear(bs);
    expect(result?.garbageApplied).toBe(2);
    expect(bs.garbageReceived).toBe(2);
    for (const y of [38, 39]) {
      for (let x = 0; x < BOARD_WIDTH; x++) expect(bs.game.board[y * BOARD_WIDTH + x]).toBe(x === 3 ? 0 : GARBAGE_CELL);
    }
    // 가로 I는 2줄 위로 밀렸다 (원래 39행 → 37행)
    expect(bs.game.board[37 * BOARD_WIDTH]).toBe(PIECE.I + 1);
  });

  it('콤보 중(줄을 지운 고정)에는 활성 가비지도 들어오지 않는다', () => {
    const bs = newBattle();
    receiveGarbage(bs, { id: 1, lines: 2, hole: 3 });
    for (let i = 0; i < GARBAGE_DELAY_FRAMES; i++) step(bs);
    fillRow(bs.game, 39, [9]);
    fillRow(bs.game, 38, [9]);
    fillRow(bs.game, 37, [9]);
    bs.game.board[30 * BOARD_WIDTH] = 3;
    const { lock: result } = dropVerticalI(bs); // 트리플 = 2 → 상쇄
    expect(result).toMatchObject({ attack: 2, cancelled: 2, garbageApplied: 0 });
    expect(countGarbageRows(bs.game)).toBe(0);
  });

  it('고정 1회에 최대 8줄 — 남은 줄은 대기열에 남아 다음 고정에 들어온다', () => {
    const bs = newBattle();
    receiveGarbage(bs, { id: 1, lines: 5, hole: 1 });
    receiveGarbage(bs, { id: 2, lines: 6, hole: 7 });
    for (let i = 0; i < GARBAGE_DELAY_FRAMES; i++) step(bs);
    expect(dropNoClear(bs).lock?.garbageApplied).toBe(GARBAGE_CAP_PER_PIECE);
    expect(bs.queue).toEqual([{ id: 2, lines: 3, hole: 7, activeAt: GARBAGE_DELAY_FRAMES }]);
    waitActive(bs);
    expect(dropNoClear(bs).lock?.garbageApplied).toBe(3);
    expect(bs.queue).toEqual([]);
    expect(countGarbageRows(bs.game)).toBe(11);
  });

  it('밀린 블록이 맨 위(숨은 줄 포함)를 넘으면 탑아웃 — 게임 오버, endFrame = 진행한 프레임 수', () => {
    const bs = newBattle();
    bs.game.board[2 * BOARD_WIDTH + 5] = 3; // 맨 위에서 3번째 줄에 칸
    receiveGarbage(bs, { id: 1, lines: 3, hole: 0 });
    for (let i = 0; i < GARBAGE_DELAY_FRAMES; i++) step(bs);
    const { lock: result } = dropNoClear(bs);
    expect(result?.garbageApplied).toBe(0);
    expect(bs.toppedOut).toBe(true);
    expect(bs.game.over).toBe(true);
    expect(bs.game.active).toBe(false);
    expect(bs.game.endFrame).toBe(bs.game.frame);
    // 게임이 끝나면 더 받지 않고 진행하지 않는다
    expect(receiveGarbage(bs, { id: 2, lines: 1, hole: 0 })).toBe(false);
    expect(step(bs, ACTION.HARD_DROP).applied).toBe(0);
  });
});

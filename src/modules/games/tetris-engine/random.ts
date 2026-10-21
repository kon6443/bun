/**
 * 시드 난수(mulberry32)·7-bag·판 해시 — 32비트 정수 연산만 쓴다
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

/** mulberry32 한 단계 — [다음 상태(int32), 0 ~ 2³²−1 정수] */
export function nextRandom(state: number): [number, number] {
  const next = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [next, (t ^ (t >>> 14)) >>> 0];
}

/** 7종을 한 벌로 섞는다 (Fisher–Yates) — [다음 난수 상태, 블록 7개] */
export function shuffleBag(state: number, pieceCount: number): [number, number[]] {
  const bag: number[] = [];
  for (let i = 0; i < pieceCount; i++) bag.push(i);
  let rng = state;
  for (let i = pieceCount - 1; i > 0; i--) {
    const [nextState, value] = nextRandom(rng);
    rng = nextState;
    const j = value % (i + 1);
    const tmp = bag[i];
    bag[i] = bag[j];
    bag[j] = tmp;
  }
  return [rng, bag];
}

/** FNV-1a 32비트 → 소문자 hex 8자 */
export function fnv1aHex(values: ArrayLike<number>): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < values.length; i++) {
    hash ^= values[i] & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

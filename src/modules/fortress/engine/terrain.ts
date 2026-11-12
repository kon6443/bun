/**
 * 지형 = 열별 고체 구간(span) (§10) — cols[x] = [top0, bottom0, top1, bottom1, …], top 포함·bottom 제외, 오름차순
 * 0 ≤ top < bottom ≤ WORLD_HEIGHT. 열 배열은 바꾸지 않는다 — 바뀐 열만 새 배열로 바꾸고 나머지는 공유한다(구조 공유)
 */

import { MAX_SPAN_PAIRS, WORLD_HEIGHT, WORLD_WIDTH } from './constants';
import { isqrt } from './math';

export type Column = readonly number[];
export type Terrain = { cols: readonly Column[] };

export function isSolid(terrain: Terrain, x: number, y: number): boolean {
  if (x < 0 || x >= WORLD_WIDTH || y < 0 || y >= WORLD_HEIGHT) return false;
  const col = terrain.cols[x];
  for (let i = 0; i < col.length; i += 2) {
    if (y < col[i]) return false;
    if (y < col[i + 1]) return true;
  }
  return false;
}

/**
 * y에 선 탱크가 디딜 땅 — y 아래(같은 높이 포함)에서 가장 가까운 구간의 top, 없으면 −1(바닥 밖으로 떨어진다)
 * y가 구간 안이면(파묻힘) 그 구간 top으로 올린다
 */
export function groundAt(col: Column, y: number): number {
  for (let i = 0; i < col.length; i += 2) {
    if (col[i + 1] > y) return col[i];
  }
  return -1;
}

/** 걸어 올라갈 수 없는 벽인가 — 위쪽 기준선 y가 구간 안(top < y < bottom)이면 막힌다 */
export function blocksAt(col: Column, y: number): boolean {
  for (let i = 0; i < col.length; i += 2) {
    if (col[i] < y && y < col[i + 1]) return true;
  }
  return false;
}

/** 가장 좁은 빈틈부터 메워 구간 수를 상한 안으로 */
function capSpans(col: number[]): number[] {
  while (col.length > MAX_SPAN_PAIRS * 2) {
    let best = 1;
    for (let i = 3; i < col.length - 1; i += 2) {
      if (col[i + 1] - col[i] < col[best + 1] - col[best]) best = i;
    }
    col.splice(best, 2);
  }
  return col;
}

/** [a, b) 빼기 — 바뀌지 않으면 같은 배열을 돌려준다 */
export function subtractRange(col: Column, a: number, b: number): Column {
  let changed = false;
  const out: number[] = [];
  for (let i = 0; i < col.length; i += 2) {
    const top = col[i];
    const bottom = col[i + 1];
    if (bottom <= a || top >= b) {
      out.push(top, bottom);
      continue;
    }
    changed = true;
    if (top < a) out.push(top, a);
    if (bottom > b) out.push(b, bottom);
  }
  return changed ? capSpans(out) : col;
}

export type Carve = { terrain: Terrain; x0: number; x1: number };

/** 원(중심 cx, cy, 반지름 r — px) 파내기 — 바뀐 열 범위 [x0, x1], 아무것도 안 바뀌면(반지름 0 포함) null */
export function carveCircle(terrain: Terrain, cx: number, cy: number, r: number): Carve | null {
  if (r <= 0) return null;
  const from = Math.max(0, cx - r);
  const to = Math.min(WORLD_WIDTH - 1, cx + r);
  let cols: Column[] | null = null;
  let x0 = -1;
  let x1 = -1;
  for (let x = from; x <= to; x++) {
    const dx = x - cx;
    const dy = isqrt(r * r - dx * dx);
    const before = terrain.cols[x];
    const after = subtractRange(before, Math.max(0, cy - dy), Math.min(WORLD_HEIGHT, cy + dy + 1));
    if (after === before) continue;
    if (!cols) cols = terrain.cols.slice();
    cols[x] = after;
    if (x0 < 0) x0 = x;
    x1 = x;
  }
  return cols ? { terrain: { cols }, x0, x1 } : null;
}

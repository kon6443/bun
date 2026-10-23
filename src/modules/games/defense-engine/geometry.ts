/**
 * 정수 기하 — 경로 위치·거리 (§E1: sqrt·부동소수 없음, 나눗셈은 Math.floor, 피제수 음수 없음)
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

/** a → b 구간에서 길이 len 중 d만큼 간 좌표 — 감소 방향도 피제수가 음수가 되지 않게 나눠 계산한다 */
export function lerpCoord(a: number, b: number, d: number, len: number): number {
  return a <= b ? a + Math.floor(((b - a) * d) / len) : a - Math.floor(((a - b) * d) / len);
}

/** 0 이상 정수의 정수 제곱근(내림) — 뉴턴법, 정수 연산만 */
export function isqrt(n: number): number {
  if (n < 2) return n;
  let x = n;
  let y = Math.floor((x + 1) / 2);
  while (y < x) {
    x = y;
    y = Math.floor((x + Math.floor(n / x)) / 2);
  }
  return x;
}

export function distanceSquared(x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return dx * dx + dy * dy;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 정수 수학 — 제곱근·삼각함수 표·난수 범위. 부동소수·Math.sin 없이 백엔드 사본과 같은 값을 낸다
 */

import { TRIG_SCALE } from './constants';
import { nextRandom } from './random';

/** 0 ~ 90도 sin × 10000 (반올림) */
const SIN_TABLE: readonly number[] = [
  0, 175, 349, 523, 698, 872, 1045, 1219, 1392, 1564, 1736, 1908, 2079, 2250, 2419, 2588, 2756, 2924, 3090, 3256, 3420, 3584, 3746,
  3907, 4067, 4226, 4384, 4540, 4695, 4848, 5000, 5150, 5299, 5446, 5592, 5736, 5878, 6018, 6157, 6293, 6428, 6561, 6691, 6820, 6947,
  7071, 7193, 7314, 7431, 7547, 7660, 7771, 7880, 7986, 8090, 8192, 8290, 8387, 8480, 8572, 8660, 8746, 8829, 8910, 8988, 9063, 9135,
  9205, 9272, 9336, 9397, 9455, 9511, 9563, 9613, 9659, 9703, 9744, 9781, 9816, 9848, 9877, 9903, 9925, 9945, 9962, 9976, 9986, 9994,
  9998, TRIG_SCALE,
];

/** sin(deg) × 10000 — deg 0 ~ 180 정수 */
export function sinDeg(deg: number): number {
  return deg <= 90 ? SIN_TABLE[deg] : SIN_TABLE[180 - deg];
}

/** cos(deg) × 10000 — deg 0 ~ 180 정수 (90 넘으면 음수) */
export function cosDeg(deg: number): number {
  return deg <= 90 ? SIN_TABLE[90 - deg] : -SIN_TABLE[deg - 90];
}

/** 정수 제곱근(내림) — 뉴턴법, 디펜스 geometry.isqrt와 같다 */
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

/** [다음 rng 상태, 0 ~ n−1] */
export function randomBelow(rng: number, n: number): [number, number] {
  const [next, value] = nextRandom(rng);
  return [next, value % n];
}

/** [다음 rng 상태, min ~ max] */
export function randomRange(rng: number, min: number, max: number): [number, number] {
  const [next, value] = randomBelow(rng, max - min + 1);
  return [next, min + value];
}

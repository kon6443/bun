/**
 * 시드 난수(mulberry32)·FNV-1a 해시 — 32비트 정수 연산만 쓴다. 엔진에서 비트 연산은 이 파일 안에서만
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

/** mulberry32 한 단계 — [다음 상태(0 ~ 2³²−1), 0 ~ 2³²−1 정수]. 상태를 부호 없이 두어 상태 해시에 음수가 없다 */
export function nextRandom(state: number): [number, number] {
  const next = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [next >>> 0, (t ^ (t >>> 14)) >>> 0];
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const TWO_POW_32 = 4294967296;

/** 해시 진행 중 상태에 바이트 하나 */
function mixByte(hash: number, byte: number): number {
  return Math.imul(hash ^ (byte & 0xff), FNV_PRIME) >>> 0;
}

/** 해시 진행 중 상태에 0 ~ 2³²−1 정수 하나(리틀 엔디언 4바이트) */
function mixUint32(hash: number, value: number): number {
  let h = mixByte(hash, value);
  h = mixByte(h, value >>> 8);
  h = mixByte(h, value >>> 16);
  return mixByte(h, value >>> 24);
}

/**
 * 0 ~ 2⁵³ 정수 목록의 FNV-1a 32비트 — 값마다 하위·상위 32비트를 차례로 넣는다
 * 음수는 넣지 않는다(엔진 상태 값은 모두 0 이상 — 없음은 −1 대신 별도 표기)
 */
export function fnv1a(values: readonly number[]): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const high = Math.floor(value / TWO_POW_32);
    hash = mixUint32(hash, value - high * TWO_POW_32);
    hash = mixUint32(hash, high);
  }
  return hash;
}

/** 32비트 해시 → 소문자 hex 8자 */
export function toHex32(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 용도별 스트림 시드 = FNV-1a(seed, 용도 상수) (§E1) — 0 ~ 2³²−1 */
export function streamSeed(seed: number, purpose: number): number {
  return fnv1a([seed, purpose]);
}

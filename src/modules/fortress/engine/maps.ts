/**
 * 맵 생성 — seed로 높이 함수를 만든다 (§2). 같은 seed·mapId면 백엔드 사본과 같은 지형
 * - hills: 사인파 3개를 겹친 언덕
 * - canyon: 양쪽 고원 + 가운데 바닥까지 뚫린 협곡(빠지면 즉사) + 왼쪽 고원 안 동굴(한 열에 구간 2개)
 */

import { TRIG_SCALE, WORLD_HEIGHT, WORLD_WIDTH } from './constants';
import type { MapId } from './data';
import { randomRange, sinDeg } from './math';
import type { Column, Terrain } from './terrain';

/** sin(deg) × 10000 — deg 0 ~ 359 */
function sin360(deg: number): number {
  return deg < 180 ? sinDeg(deg) : -sinDeg(deg - 180);
}

type Wave = { amp: number; periodPx: number; phase: number };

function waveHeight(waves: readonly Wave[], x: number): number {
  let h = 0;
  for (const w of waves) {
    const deg = (Math.floor((x * 360) / w.periodPx) + w.phase) % 360;
    h += Math.floor((w.amp * sin360(deg)) / TRIG_SCALE);
  }
  return h;
}

function makeWaves(rng: number, specs: readonly [number, number, number, number][]): [number, Wave[]] {
  const waves: Wave[] = [];
  let r = rng;
  for (const [ampMin, ampMax, periodMin, periodMax] of specs) {
    let amp: number;
    let periodPx: number;
    let phase: number;
    [r, amp] = randomRange(r, ampMin, ampMax);
    [r, periodPx] = randomRange(r, periodMin, periodMax);
    [r, phase] = randomRange(r, 0, 359);
    waves.push({ amp, periodPx, phase });
  }
  return [r, waves];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function hills(rng: number): Terrain {
  const [, waves] = makeWaves(rng, [
    [80, 140, 900, 1400],
    [30, 60, 300, 500],
    [6, 14, 60, 110],
  ]);
  const cols: Column[] = [];
  for (let x = 0; x < WORLD_WIDTH; x++) {
    cols.push([clamp(640 + waveHeight(waves, x), 260, 960), WORLD_HEIGHT]);
  }
  return { cols };
}

const CANYON_HALF = 56;

function canyon(rng: number): Terrain {
  const [r1, waves] = makeWaves(rng, [
    [20, 40, 500, 800],
    [5, 12, 70, 120],
  ]);
  const mid = Math.floor(WORLD_WIDTH / 2);
  const [r2, center] = randomRange(r1, mid - 120, mid + 120);
  const [, caveX] = randomRange(r2, 300, 620);
  const cols: Column[] = [];
  for (let x = 0; x < WORLD_WIDTH; x++) {
    const fromEdge = Math.abs(x - center);
    if (fromEdge < CANYON_HALF) {
      cols.push([]);
      continue;
    }
    // 협곡 가장자리 120px는 비탈로 내려간다
    const slope = fromEdge < CANYON_HALF + 120 ? (CANYON_HALF + 120 - fromEdge) * 2 : 0;
    const top = clamp(480 + waveHeight(waves, x) + slope, 300, 900);
    const caveDx = Math.abs(x - caveX);
    if (caveDx < 140) {
      // 동굴: 지표 아래 80px에서 시작하는 타원 모양 빈 공간
      const halfH = Math.floor(((140 - caveDx) * 50) / 140);
      const caveTop = top + 80 + 50 - halfH;
      const caveBottom = top + 80 + 50 + halfH;
      if (halfH > 0) {
        cols.push([top, caveTop, caveBottom, WORLD_HEIGHT]);
        continue;
      }
    }
    cols.push([top, WORLD_HEIGHT]);
  }
  return { cols };
}

export function generateTerrain(mapId: MapId, rng: number): Terrain {
  return mapId === 'hills' ? hills(rng) : canyon(rng);
}

/**
 * 한 턴 시뮬 — 이동 → 발사(탄 비행·폭발·지형 파괴) → 낙하 정착 (§2·§10)
 * applyAction과 previewShot이 같은 함수(runFire)를 쓴다 — previewShot은 첫 폭발에서 멈추고 아무것도 확정하지 않는다
 * 낙하는 모든 탄이 끝난 뒤 한 번(settle) — 비행 중 발밑이 파여도 탱크는 턴 끝까지 제자리(뒤따르는 탄도 옛 위치 기준)
 * 탱크는 호출 쪽이 복사해 넘긴다(여기서 hp·위치를 바꾼다). 지형은 바뀐 열만 새 배열(구조 공유)
 */

import {
  COLLISION_STEP_PX,
  FALL_PX_PER_DAMAGE,
  FALL_SAFE_PX,
  GRAVITY,
  MAX_CLIMB,
  MAX_PROJECTILES,
  MAX_TICKS_PER_TURN,
  MOVE_PX_PER_TICK,
  MUZZLE_HEIGHT,
  SPEED_PER_POWER,
  SUB,
  TANK_RADIUS,
  TRIG_SCALE,
  WIND_ACCEL,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from './constants';
import type { Weapon } from './data';
import { cosDeg, isqrt, sinDeg } from './math';
import type { Tank } from './state';
import { type Terrain, blocksAt, carveCircle, groundAt, isSolid } from './terrain';

/** 렌더러 연출용 (해시 대상 아님, 서버는 무시). t = 턴 안 틱 */
export type DeathCause = 'hp' | 'out' | 'resign' | 'skips';
export type MatchEvent =
  | { type: 'move'; t: number; slot: number; path: number[] }
  /** samples = [x0, y0, x1, y1, …] 틱마다 px(위로 벗어나면 y < 0). end = 끝난 이유 */
  | { type: 'shot'; t: number; projectileId: number; samples: number[]; end: 'explode' | 'out' | 'split' | 'timeout' }
  | { type: 'explode'; t: number; x: number; y: number; r: number }
  | { type: 'terrain'; t: number; x0: number; x1: number }
  | { type: 'damage'; t: number; slot: number; amount: number }
  | { type: 'fall'; t: number; slot: number; path: number[] }
  | { type: 'death'; t: number; slot: number; cause: DeathCause };

/**
 * 행동 하나의 마지막 틱 (§11 마감 — 서버 turnMs의 연출 시간, 렌더러 연출 끝의 기준). 연출 꼬리(폭발·낙하 보간·여운)는 넣지 않는다
 * shot = 시작 틱 + 비행 틱(샘플은 시작점 1개 + 틱마다 1개), move = 1px 걸음을 MOVE_PX_PER_TICK씩 올림, 나머지 = t. 이벤트가 없으면 0
 * 이동은 연출(걸음을 끝까지 보여 줌) 기준이다 — 이동 중 협곡 추락사면 walk의 반환(내림)보다 1 클 수 있고, 그 밖의 경로는 엔진 틱과 같다
 */
export function eventsEndTick(events: readonly MatchEvent[]): number {
  let end = 0;
  for (const e of events) {
    if (e.type === 'shot') end = Math.max(end, e.t + Math.floor(e.samples.length / 2) - 1);
    else if (e.type === 'move') end = Math.max(end, Math.floor((Math.floor(e.path.length / 2) - 1 + MOVE_PX_PER_TICK - 1) / MOVE_PX_PER_TICK));
    else end = Math.max(end, e.t);
  }
  return end;
}

type Projectile = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  /** 갈라지거나 폭격을 부르는 탄이면 그 무기 */
  spawner: Weapon | null;
  startTick: number;
  samples: number[];
  /** 쏜 탱크 판정 원을 한 번 벗어났나 — 그 전엔 자기 탱크에 안 맞는다 */
  armed: boolean;
};

export type Impact = { x: number; y: number; t: number };

type FireCtx = {
  terrain: Terrain;
  tanks: Tank[];
  events: MatchEvent[];
  shooter: number;
  wind: number;
  /** 미리보기: 첫 폭발에서 멈추고 지형·탱크를 바꾸지 않는다 */
  preview: boolean;
  firstImpact: Impact | null;
  /** 미리보기 첫 폭발의 예상 피해(인덱스 = slot) */
  previewDamage: number[];
  nextId: number;
  tick: number;
};

const toPx = (v: number) => Math.floor(v / SUB);

function kill(ctx: { events: MatchEvent[] }, tank: Tank, t: number, cause: DeathCause): void {
  tank.alive = false;
  tank.hp = 0;
  ctx.events.push({ type: 'death', t, slot: tank.slot, cause });
}

function fallDamage(dist: number): number {
  return dist > FALL_SAFE_PX ? Math.floor((dist - FALL_SAFE_PX) / FALL_PX_PER_DAMAGE) : 0;
}

/** 피해 — 이벤트 amount는 실제로 깎인 HP(남은 HP를 넘지 않는다) */
function hurt(ctx: { events: MatchEvent[] }, tank: Tank, amount: number, t: number): void {
  if (amount <= 0 || !tank.alive) return;
  const dealt = Math.min(amount, tank.hp);
  tank.hp -= dealt;
  ctx.events.push({ type: 'damage', t, slot: tank.slot, amount: dealt });
  if (tank.hp === 0) kill(ctx, tank, t, 'hp');
}

/** 1px씩 걸어 이동 — 벽(오를 수 있는 높이 초과)·월드 끝에서 멈추고, 협곡에 빠지면 즉사. 걸린 틱 수를 돌려준다 */
export function walk(terrain: Terrain, tank: Tank, move: number, events: MatchEvent[]): number {
  if (move === 0) return 0;
  const dir = move < 0 ? -1 : 1;
  const path: number[] = [tank.x, tank.y];
  let steps = 0;
  for (let i = 0; i < Math.abs(move); i++) {
    const nx = tank.x + dir;
    if (nx < 0 || nx >= WORLD_WIDTH) break;
    const col = terrain.cols[nx];
    const climbLine = tank.y - MAX_CLIMB;
    if (blocksAt(col, climbLine)) break;
    const ground = groundAt(col, climbLine);
    tank.x = nx;
    tank.fuel -= 1;
    steps++;
    if (ground < 0) {
      tank.y = WORLD_HEIGHT;
      path.push(nx, WORLD_HEIGHT);
      events.push({ type: 'move', t: 0, slot: tank.slot, path });
      kill({ events }, tank, Math.floor(steps / MOVE_PX_PER_TICK), 'out');
      return Math.floor(steps / MOVE_PX_PER_TICK);
    }
    const drop = ground - tank.y;
    tank.y = ground;
    path.push(nx, ground);
    if (drop > MAX_CLIMB) hurt({ events }, tank, fallDamage(drop), Math.floor(steps / MOVE_PX_PER_TICK));
    if (!tank.alive) break;
  }
  if (steps > 0) events.push({ type: 'move', t: 0, slot: tank.slot, path });
  return Math.floor((steps + MOVE_PX_PER_TICK - 1) / MOVE_PX_PER_TICK);
}

function spawn(ctx: FireCtx, list: Projectile[], x: number, y: number, vx: number, vy: number, radius: number, damage: number, spawner: Weapon | null): void {
  if (list.length >= MAX_PROJECTILES) return;
  list.push({ id: ctx.nextId++, x, y, vx, vy, radius, damage, spawner, startTick: ctx.tick, samples: [toPx(x), toPx(y)], armed: false });
}

function endShot(ctx: FireCtx, p: Projectile, end: 'explode' | 'out' | 'split' | 'timeout'): void {
  if (!ctx.preview) ctx.events.push({ type: 'shot', t: p.startTick, projectileId: p.id, samples: p.samples, end });
}

/** 폭발 — 지형을 파내고 반경 안 탱크에 거리 비례 피해(탱크 판정 원 가장자리까지 거리). 미리보기면 피해만 계산 */
function explode(ctx: FireCtx, x: number, y: number, radius: number, damage: number): void {
  const t = ctx.tick;
  if (!ctx.firstImpact) ctx.firstImpact = { x, y, t };
  if (!ctx.preview) {
    ctx.events.push({ type: 'explode', t, x, y, r: radius });
    const carve = carveCircle(ctx.terrain, x, y, radius);
    if (carve) {
      ctx.terrain = carve.terrain;
      ctx.events.push({ type: 'terrain', t, x0: carve.x0, x1: carve.x1 });
    }
  }
  for (const tank of ctx.tanks) {
    if (!tank.alive) continue;
    const dx = tank.x - x;
    const dy = tank.y - TANK_RADIUS - y;
    const d = Math.max(0, isqrt(dx * dx + dy * dy) - TANK_RADIUS);
    if (d >= radius) continue;
    const amount = Math.floor((damage * (radius - d)) / radius);
    if (ctx.preview) ctx.previewDamage[tank.slot] += amount;
    else hurt(ctx, tank, amount, t);
  }
}

/** 탄 하나 터짐 — 폭격 탄이면 닿은 자리 위 꼭대기에서 폭탄을 떨어뜨린다 */
function detonate(ctx: FireCtx, list: Projectile[], p: Projectile, x: number, y: number): void {
  explode(ctx, x, y, p.radius, p.damage);
  const w = p.spawner;
  if (w && w.kind === 'strike' && !ctx.preview) {
    const half = Math.floor((w.count - 1) / 2);
    for (let k = 0; k < w.count; k++) {
      spawn(ctx, list, (x + (k - half) * w.spacing) * SUB, 0, 0, 0, w.childRadius, w.childDamage, null);
    }
  }
}

/** 탄 한 틱 — 바람·중력을 더하고 COLLISION_STEP_PX 간격으로 나눠 충돌 검사. 끝났으면 true */
function stepProjectile(ctx: FireCtx, list: Projectile[], p: Projectile): boolean {
  const prevVy = p.vy;
  p.vx += ctx.wind * WIND_ACCEL;
  p.vy += GRAVITY;
  const span = Math.max(Math.abs(p.vx), Math.abs(p.vy));
  const parts = Math.max(1, Math.floor((span + COLLISION_STEP_PX * SUB - 1) / (COLLISION_STEP_PX * SUB)));
  for (let k = 1; k <= parts; k++) {
    const x = p.x + Math.floor((p.vx * k) / parts);
    const y = p.y + Math.floor((p.vy * k) / parts);
    const px = toPx(x);
    const py = toPx(y);
    if (px < 0 || px >= WORLD_WIDTH || py >= WORLD_HEIGHT) {
      p.samples.push(px, py);
      endShot(ctx, p, 'out');
      return true;
    }
    for (const tank of ctx.tanks) {
      if (!tank.alive) continue;
      const dx = tank.x - px;
      const dy = tank.y - TANK_RADIUS - py;
      const inside = dx * dx + dy * dy <= TANK_RADIUS * TANK_RADIUS;
      if (tank.slot === ctx.shooter && !p.armed) {
        if (!inside) p.armed = true;
        continue;
      }
      if (inside) {
        p.samples.push(px, py);
        endShot(ctx, p, 'explode');
        detonate(ctx, list, p, px, py);
        return true;
      }
    }
    if (isSolid(ctx.terrain, px, py)) {
      p.samples.push(px, py);
      endShot(ctx, p, 'explode');
      detonate(ctx, list, p, px, py);
      return true;
    }
  }
  p.x += p.vx;
  p.y += p.vy;
  p.samples.push(toPx(p.x), toPx(p.y));
  const w = p.spawner;
  if (w && w.kind === 'split' && prevVy < 0 && p.vy >= 0) {
    endShot(ctx, p, 'split');
    const half = Math.floor((w.count - 1) / 2);
    for (let k = 0; k < w.count; k++) {
      spawn(ctx, list, p.x, p.y, p.vx + (k - half) * w.spacing, 0, w.childRadius, w.childDamage, null);
    }
    return true;
  }
  return false;
}

export type FireResult = { terrain: Terrain; tick: number; firstImpact: Impact | null; previewDamage: number[] };

/**
 * 발사부터 모든 탄이 끝날 때까지. 미리보기는 첫 폭발에서 멈춘다
 * 탄은 id 순서로 한 틱씩 — 같은 틱의 폭발은 앞 탄 것이 먼저 지형을 바꾼다
 */
export function runFire(
  terrain: Terrain,
  tanks: Tank[],
  events: MatchEvent[],
  shooter: Tank,
  angle: number,
  power: number,
  weapon: Weapon,
  wind: number,
  startTick: number,
  preview: boolean,
): FireResult {
  const ctx: FireCtx = {
    terrain,
    tanks,
    events,
    shooter: shooter.slot,
    wind,
    preview,
    firstImpact: null,
    previewDamage: [0, 0, 0, 0],
    nextId: 0,
    tick: startTick,
  };
  const list: Projectile[] = [];
  const speed = Math.floor((power * SPEED_PER_POWER * weapon.speedPermille) / 1000);
  const x = shooter.x * SUB;
  const y = (shooter.y - MUZZLE_HEIGHT) * SUB;
  // 파워 0 = 쏘지 않음 — 자발적 패스가 없어서(D-008 C) 이동만 하고 턴을 넘기는 방법
  const shells = power === 0 ? 0 : weapon.kind === 'shell' ? weapon.count : 1;
  const half = Math.floor((shells - 1) / 2);
  for (let k = 0; k < shells; k++) {
    const a = Math.max(0, Math.min(180, angle + (k - half) * weapon.spreadDeg));
    const vx = Math.floor((speed * cosDeg(a)) / TRIG_SCALE);
    const vy = -Math.floor((speed * sinDeg(a)) / TRIG_SCALE);
    spawn(ctx, list, x, y, vx, vy, weapon.radius, weapon.damage, weapon.kind === 'shell' ? null : weapon);
  }
  while (list.length > 0 && ctx.tick < MAX_TICKS_PER_TURN) {
    ctx.tick++;
    // 이번 틱에 생긴 탄은 다음 틱부터 움직인다
    const moving = list.length;
    let i = 0;
    let seen = 0;
    while (seen < moving && i < list.length) {
      seen++;
      if (stepProjectile(ctx, list, list[i])) list.splice(i, 1);
      else i++;
      if (preview && ctx.firstImpact) return { terrain, tick: ctx.tick, firstImpact: ctx.firstImpact, previewDamage: ctx.previewDamage };
    }
  }
  for (const p of list) endShot(ctx, p, 'timeout');
  return { terrain: ctx.terrain, tick: ctx.tick, firstImpact: ctx.firstImpact, previewDamage: ctx.previewDamage };
}

/** 낙하 정착 — 발밑이 파였으면 아래 땅까지(높이 비례 피해), 땅이 없으면 바닥 밖 즉사. slot 순서 */
export function settle(terrain: Terrain, tanks: Tank[], events: MatchEvent[], tick: number): void {
  for (const tank of tanks) {
    if (!tank.alive) continue;
    const ground = groundAt(terrain.cols[tank.x], tank.y);
    if (ground < 0) {
      events.push({ type: 'fall', t: tick, slot: tank.slot, path: [tank.x, tank.y, tank.x, WORLD_HEIGHT] });
      tank.y = WORLD_HEIGHT;
      kill({ events }, tank, tick, 'out');
      continue;
    }
    if (ground === tank.y) continue;
    const dist = ground - tank.y;
    events.push({ type: 'fall', t: tick, slot: tank.slot, path: [tank.x, tank.y, tank.x, ground] });
    tank.y = ground;
    if (dist > 0) hurt({ events }, tank, fallDamage(dist), tick);
  }
}

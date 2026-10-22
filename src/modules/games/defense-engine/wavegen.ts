/**
 * 웨이브 구성기 (defense DESIGN §L3·§L6) — 압력(초당 유입 EHP)과 역할로 웨이브 그룹을 만든다. 정수 연산만
 *   무한·주간: 판 시작 때 세션 seed(웨이브 스트림)로 80웨이브를 만든다 — 설계 웨이브 1~30은 정적 압력표, 31+는 램프식
 *   캠페인: 시뮬레이터가 같은 함수로 만든 결과를 정수 데이터(data/waves.ts)로 확정한다(사람이 다듬을 수 있게)
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import { MAX_ENEMY_HP, MAX_WAVE, PERMILLE, TICKS_PER_SECOND } from './constants';
import { ENEMIES, ENEMY_ID } from './data/enemies';
import type { Wave, WaveGroup } from './data/stages';
import { nextRandom } from './random';

/** 웨이브 역할 (§L3) — 주기 기본·기본+·러시·휴식·보스 */
export const ROLE = { BASIC: 0, PLUS: 1, RUSH: 2, REST: 3, BOSS: 4 } as const;
export const ROLE_COUNT = 5;
/** 역할별 스폰 간격(틱) */
export const ROLE_INTERVAL: readonly number[] = [24, 21, 10, 30, 30];
/** 보스 노출 시간(초) — 보스 EHP = 압력 × 9초 (§L3-4) */
export const BOSS_EXPOSURE_SECONDS = 9;
/** 호위 — 스폰 시간 절반 · 압력 60% */
const ESCORT_PRESSURE_PERMILLE = 600;
/** 기본+의 탱커 몫 ‰ */
const TANK_SHARE_PERMILLE = 250;
/** 치유형(사제) 웨이브당 상한 — 마리를 줄인 만큼 HP를 올려 예산은 지킨다 */
const HEALER_CAP = 3;
/** 공중 비율 상한 ‰ — 공중을 뽑으면 지상 1종을 섞는다(§L3-5, 첫 등장 단독 웨이브는 예외) */
const AIR_SHARE_PERMILLE = 400;
/** 보스 첫 스폰 지연(틱) — 호위가 먼저 나온다 */
const BOSS_DELAY_TICKS = 60;
/** 설계 웨이브 수 — 이후 램프 (§L6) */
export const DESIGNED_WAVES = 30;

/** n(1부터)번째 웨이브의 역할 — 주기 5. lastBoss면 마지막 웨이브는 보스(캠페인) */
export function roleOfWave(n: number, total: number, lastBoss: boolean): number {
  if (lastBoss && n === total) return ROLE.BOSS;
  return (n - 1) % ROLE_COUNT;
}

/** 스폰 시간(초) = min(36, 12 + 2(n − 1)) */
export function spawnSeconds(n: number): number {
  return Math.min(36, 12 + 2 * (n - 1));
}

/** 31웨이브 이후 램프 단계 — acc(w) = 1000 + Σ step(i) (§L6) */
function rampStep(i: number): number {
  if (i <= 20) return 20;
  if (i <= 40) return 50;
  if (i <= 60) return 150;
  return 350;
}

/**
 * 웨이브 n의 압력 — 설계표(1~30) 다음은 램프: ⌊마지막 설계 주기(26~30)의 같은 역할 압력 × acc(w) / 1000⌋
 * 역할 톱니는 설계표가 이미 실측으로 담고 있어(보스는 한 마리에 몰려 압력이 낮다) 같은 역할 압력에 acc만 곱한다
 * rampPermille = 램프 단계 배율(시뮬레이터가 기준 봇 붕괴 웨이브 목표로 맞춘다, §L6 "증강 포함 기준으로 재조정")
 */
export function endlessPressure(designed: readonly number[], n: number, rampPermille = PERMILLE): number {
  if (n <= designed.length) return designed[n - 1];
  let acc = PERMILLE;
  for (let i = 1; i <= n - designed.length; i++) acc += Math.floor((rampStep(i) * rampPermille) / PERMILLE);
  const role = (n - 1) % ROLE_COUNT;
  const base = designed[designed.length - ROLE_COUNT + role];
  return Math.min(MAX_ENEMY_HP, Math.floor((base * acc) / PERMILLE));
}

/** 역할별 후보 적 (id 목록) — 쓸 수 있는 적만 담아 넘긴다 */
export type WavePool = {
  main: readonly number[];
  tank: readonly number[];
  rush: readonly number[];
  rest: readonly number[];
  escort: readonly number[];
  boss: readonly number[];
};

export type ComposeOptions = {
  groundPaths: number;
  /** 공중 경로가 있는지 — 없으면 공중 적도 지상 경로(0)를 쓴다 */
  hasAirPath: boolean;
  /** R3 공중 비율 2배 — 공중 후보 뽑기 가중치 2 */
  airDouble: boolean;
  /** R4 보스 웨이브 엘리트(공성 거인) 동반 */
  bossEscort: boolean;
};

/** 웨이브 생성 전용 난수 — 상태를 객체에 담아 넘긴다 */
export type WaveRng = { state: number };

function draw(rng: WaveRng, n: number): number {
  const [next, value] = nextRandom(rng.state);
  rng.state = next;
  return value % n;
}

/** 후보에서 하나 — 공중 가중치(R3), 제외 목록 */
function pick(rng: WaveRng, pool: readonly number[], options: ComposeOptions, exclude: readonly number[]): number {
  let total = 0;
  for (const id of pool) if (exclude.indexOf(id) < 0) total += options.airDouble && ENEMIES[id].air ? 2 : 1;
  if (total === 0) return -1;
  let roll = draw(rng, total);
  for (const id of pool) {
    if (exclude.indexOf(id) >= 0) continue;
    const weight = options.airDouble && ENEMIES[id].air ? 2 : 1;
    if (roll < weight) return id;
    roll -= weight;
  }
  return -1;
}

/** 스폰 칸 slots를 kind로 채우는 그룹 — 위협 가중치만큼 마리 수가 준다, HP = 단위 EHP × hp‰ */
function group(kind: number, slots: number, unitEhp: number, durationTicks: number, delay: number, path: number): WaveGroup {
  const enemy = ENEMIES[kind];
  const individuals = Math.max(1, Math.floor((slots * PERMILLE) / Math.max(1, enemy.threat)));
  const spawns = Math.max(1, Math.floor(individuals / enemy.swarm));
  const count = kind === ENEMY_ID.PRIEST ? Math.min(spawns, HEALER_CAP) : spawns;
  const hp = Math.min(MAX_ENEMY_HP, Math.max(1, Math.floor((unitEhp * enemy.hpPermille * spawns) / (PERMILLE * count))));
  return { enemyId: kind, count, intervalTicks: Math.max(1, Math.floor(durationTicks / count)), delayTicks: delay, hp, path };
}

/**
 * 웨이브 하나 — 압력 pressure(초당 EHP)·역할·후보로 그룹을 만든다
 *   마리(칸) = 스폰 시간 × 30 / 간격 · 단위 EHP = 압력 × 간격 / 30 · 그룹끼리 스폰 시각을 엇갈린다
 *   보스: 보스 EHP = 압력 × 9초 + 호위(스폰 시간 절반·압력 60%)
 */
export function composeWave(n: number, role: number, pressure: number, pool: WavePool, options: ComposeOptions, rng: WaveRng): Wave {
  const seconds = spawnSeconds(n);
  const interval = ROLE_INTERVAL[role];
  const durationTicks = seconds * TICKS_PER_SECOND;
  const slots = Math.max(1, Math.floor(durationTicks / interval));
  const unitEhp = Math.max(1, Math.floor((pressure * interval) / TICKS_PER_SECOND));
  const kinds: number[] = [];
  const shares: number[] = [];

  if (role === ROLE.BOSS) {
    const groups: WaveGroup[] = [];
    const escortSlots = Math.max(1, Math.floor(slots / 2));
    const escortEhp = Math.max(1, Math.floor((unitEhp * ESCORT_PRESSURE_PERMILLE) / PERMILLE));
    const escort = pick(rng, pool.escort, options, kinds);
    if (escort >= 0) groups.push(group(escort, escortSlots, escortEhp, Math.floor(durationTicks / 2), 0, pathFor(escort, 0, n, options)));
    let boss = pick(rng, pool.boss, options, kinds);
    if (boss < 0) boss = pick(rng, pool.tank.length > 0 ? pool.tank : pool.main, options, kinds);
    if (boss >= 0) {
      const bossHp = Math.min(MAX_ENEMY_HP, Math.max(1, pressure * BOSS_EXPOSURE_SECONDS));
      groups.push({ enemyId: boss, count: 1, intervalTicks: 1, delayTicks: BOSS_DELAY_TICKS, hp: bossHp, path: pathFor(boss, 1, n, options) });
    }
    if (options.bossEscort) {
      // R4 — 보스 바로 뒤에 공성 거인 1 (HP = 단위 EHP × 거인 hp‰)
      const giant = ENEMIES[ENEMY_ID.GIANT];
      const hp = Math.min(MAX_ENEMY_HP, Math.max(1, Math.floor((unitEhp * giant.hpPermille) / PERMILLE)));
      groups.push({ enemyId: ENEMY_ID.GIANT, count: 1, intervalTicks: 1, delayTicks: BOSS_DELAY_TICKS + interval, hp, path: pathFor(ENEMY_ID.GIANT, 0, n, options) });
    }
    return { groups };
  }

  if (role === ROLE.PLUS) {
    const main = pick(rng, pool.main, options, kinds);
    if (main >= 0) kinds.push(main);
    const tank = pick(rng, pool.tank, options, kinds);
    if (tank >= 0) kinds.push(tank);
    // 주력이 공중이면 공중 몫은 상한(400‰)까지 — 나머지는 지상 탱커 (공중 비율 상한)
    const airMain = main >= 0 && ENEMIES[main].air && tank >= 0 && !ENEMIES[tank].air;
    if (main >= 0) shares.push(tank < 0 ? PERMILLE : airMain ? AIR_SHARE_PERMILLE : PERMILLE - TANK_SHARE_PERMILLE);
    if (tank >= 0) shares.push(main < 0 ? PERMILLE : airMain ? PERMILLE - AIR_SHARE_PERMILLE : TANK_SHARE_PERMILLE);
  } else {
    const source = role === ROLE.RUSH ? pool.rush : role === ROLE.REST ? pool.rest : pool.main;
    const wanted = role === ROLE.REST ? 1 : 1 + draw(rng, 2);
    for (let i = 0; i < wanted; i++) {
      // 공중은 한 웨이브에 한 종류까지 (공중 비율 상한 — §L3)
      const exclude = kinds.slice();
      if (kinds.length > 0 && ENEMIES[kinds[0]].air) for (const id of source) if (ENEMIES[id].air) exclude.push(id);
      const kind = pick(rng, source, options, exclude);
      if (kind < 0) break;
      kinds.push(kind);
    }
    // 공중만 뽑혔으면 지상 1종을 섞는다 (공중 비율 상한)
    if (kinds.length === 1 && ENEMIES[kinds[0]].air) {
      const ground: number[] = [];
      for (const id of pool.main) if (!ENEMIES[id].air) ground.push(id);
      for (const id of pool.rush) if (!ENEMIES[id].air && ground.indexOf(id) < 0) ground.push(id);
      const kind = pick(rng, ground, options, kinds);
      if (kind >= 0) kinds.push(kind);
    }
    for (let i = 0; i < kinds.length; i++) {
      if (kinds.length === 2 && ENEMIES[kinds[0]].air !== ENEMIES[kinds[1]].air) {
        shares.push(ENEMIES[kinds[i]].air ? AIR_SHARE_PERMILLE : PERMILLE - AIR_SHARE_PERMILLE);
      } else {
        shares.push(Math.floor(PERMILLE / kinds.length));
      }
    }
  }
  if (kinds.length === 0) return { groups: [] };

  const groups: WaveGroup[] = [];
  const stagger = Math.max(1, Math.floor(interval / kinds.length));
  for (let i = 0; i < kinds.length; i++) {
    const kindSlots = Math.max(1, Math.floor((slots * shares[i]) / PERMILLE));
    groups.push(group(kinds[i], kindSlots, unitEhp, durationTicks, i * stagger, pathFor(kinds[i], i, n, options)));
  }
  return { groups };
}

/** 지상 갈래는 웨이브 번호만큼 돌린다 — 한 종류 웨이브·호위가 늘 첫 갈래로만 오지 않게 (n ≥ 1이라 % 피연산자는 음이 아니다) */
function pathFor(kind: number, index: number, n: number, options: ComposeOptions): number {
  if (ENEMIES[kind].air && options.hasAirPath) return 0;
  return (index + n) % Math.max(1, options.groundPaths);
}

/** 무한·주간 후보 — 웨이브 n에서 쓸 수 있는 적 (등장 웨이브 — 캠페인 해금 순서를 따라 공중 고속·보스는 늦게) */
const ENDLESS_FROM_WAVE: readonly number[] = (() => {
  const from: number[] = [];
  from[ENEMY_ID.GRUNT] = 1;
  from[ENEMY_ID.RUNNER] = 1;
  from[ENEMY_ID.SHIELD] = 3;
  from[ENEMY_ID.SPLITTER] = 4;
  from[ENEMY_ID.BATS] = 4;
  from[ENEMY_ID.GHOST] = 8;
  from[ENEMY_ID.WYVERN] = 11;
  from[ENEMY_ID.PRIEST] = 10;
  from[ENEMY_ID.GIANT] = 12;
  from[ENEMY_ID.SUMMONER] = 10;
  from[ENEMY_ID.DRAGON] = 25;
  return from;
})();

function available(ids: readonly number[], n: number): number[] {
  const out: number[] = [];
  for (const id of ids) if (n >= ENDLESS_FROM_WAVE[id]) out.push(id);
  return out;
}

/**
 * 보스 후보 — 새 보스 종류가 열리는 웨이브에는 그 보스만(모든 seed 같은 첫 대면)
 * 섞어 뽑으면 첫 용(공중·누수 목숨 20)이 판마다 운으로 갈리고, 보정의 외톨이 제외에 걸려 그 판들만 그 웨이브에서 끝난다
 * 후보가 하나여도 뽑기는 난수 하나를 쓴다(pick) — 뒤 웨이브 구성은 그대로다
 */
function bossPool(n: number): number[] {
  const E = ENEMY_ID;
  if (n < ENDLESS_FROM_WAVE[E.SUMMONER]) return available([E.GIANT, E.SHIELD], n);
  const bosses = available([E.SUMMONER, E.DRAGON], n);
  const fresh: number[] = [];
  for (const id of bosses) if (ENDLESS_FROM_WAVE[id] === n) fresh.push(id);
  return fresh.length > 0 ? fresh : bosses;
}

/** 무한·주간 웨이브 n의 후보 */
export function endlessPool(n: number): WavePool {
  const E = ENEMY_ID;
  return {
    main: available([E.GRUNT, E.SHIELD, E.GHOST, E.WYVERN, E.PRIEST], n),
    tank: available([E.SHIELD, E.GIANT], n),
    rush: available([E.RUNNER, E.BATS, E.SPLITTER], n),
    rest: available([E.GRUNT, E.RUNNER], n),
    escort: available([E.GRUNT, E.RUNNER, E.SHIELD], n),
    // 소환사 전에는 그때 나온 탱커(방패병 — 공성 거인은 12웨이브부터)를 보스로
    boss: bossPool(n),
  };
}

/** 무한·주간 판의 웨이브 MAX_WAVE개 — 설계 압력표 + 램프, 구성은 seed 스트림 */
export function generateEndlessWaves(designed: readonly number[], rampPermille: number, options: ComposeOptions, rng: WaveRng): Wave[] {
  const waves: Wave[] = [];
  for (let n = 1; n <= MAX_WAVE; n++) {
    waves.push(composeWave(n, roleOfWave(n, MAX_WAVE, false), endlessPressure(designed, n, rampPermille), endlessPool(n), options, rng));
  }
  return waves;
}

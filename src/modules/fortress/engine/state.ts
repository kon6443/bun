/**
 * 경기 상태·설정 검증·턴 순서·승패 판정 (§10)
 * state는 순수 JSON — 클래스·typed array·undefined를 넣지 않는다(JSON 왕복 후 해시가 같아야 한다)
 */

import {
  CONFIG_REASON,
  type ConfigReason,
  ENGINE_VERSION,
  MAX_PLAYERS,
  MAX_ROUNDS,
  MIN_PLAYERS,
  SEED_MAX,
  DUEL_SPAN,
  SPAWN_JITTER,
  SPAWN_MARGIN,
  STREAM,
  WIND_MAX,
  WORLD_WIDTH,
} from './constants';
import { MAP_IDS, type MapId, TANKS } from './data';
import { generateTerrain } from './maps';
import { randomBelow, randomRange } from './math';
import { streamSeed } from './random';
import { type Terrain, groundAt } from './terrain';

export type MatchMode = 'ffa' | 'team';
export type PlayerConfig = { slot: number; team: number; tankId: number };
export type MatchConfig = { seed: number; mapId: MapId; mode: MatchMode; players: PlayerConfig[] };

/** x·y는 px — y는 탱크가 디딘 땅의 top(탱크 바닥) */
export type Tank = {
  slot: number;
  /** team 모드는 0|1, ffa는 slot과 같다 */
  team: number;
  tankId: number;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  /** 이번 턴 남은 이동 연료 — 자기 턴이 시작될 때 다시 채운다 */
  fuel: number;
  /** 필살기를 못 쓰는 남은 자기 턴 수 */
  cooldown: number;
  /** 연속 스킵 수 — 발사하면 0 */
  skips: number;
};

export type MatchResult = { kind: 'ongoing' } | { kind: 'win'; team?: number; slots: number[] } | { kind: 'draw' };

export type MatchState = {
  v: number;
  mode: MatchMode;
  mapId: MapId;
  /** no = 끝난 턴 수(0부터), round = floor(no / 시작 인원) + 1 */
  turn: { no: number; slot: number; round: number };
  /** 시작 인원 — 라운드·턴 상한 계산 */
  players: number;
  /** 턴 상한 = MAX_ROUNDS × 시작 인원 */
  maxTurns: number;
  /** team 모드: 팀마다 마지막으로 쏜 slot(−1 = 아직 없음) */
  lastByTeam: number[];
  /** 지금 턴의 바람 −WIND_MAX ~ +WIND_MAX */
  wind: number;
  rng: number;
  /** 인덱스 = slot, 빈 slot은 null */
  tanks: (Tank | null)[];
  terrain: Terrain;
  result: MatchResult;
};

const isInt = (v: unknown): v is number => Number.isInteger(v);

function validateConfig(config: MatchConfig): ConfigReason | null {
  if (typeof config !== 'object' || config === null) return CONFIG_REASON.BAD_PLAYERS;
  if (!isInt(config.seed) || config.seed < 0 || config.seed > SEED_MAX) return CONFIG_REASON.BAD_SEED;
  if (!MAP_IDS.includes(config.mapId)) return CONFIG_REASON.BAD_MAP;
  if (config.mode !== 'ffa' && config.mode !== 'team') return CONFIG_REASON.BAD_MODE;
  const players = config.players;
  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) return CONFIG_REASON.BAD_PLAYERS;
  const seen: boolean[] = [false, false, false, false];
  for (const p of players) {
    if (typeof p !== 'object' || p === null || !isInt(p.slot) || p.slot < 0 || p.slot >= MAX_PLAYERS || seen[p.slot]) return CONFIG_REASON.BAD_PLAYERS;
    seen[p.slot] = true;
    if (!isInt(p.tankId) || p.tankId < 0 || p.tankId >= TANKS.length) return CONFIG_REASON.BAD_TANK;
  }
  if (config.mode === 'team') {
    if (players.length !== 4) return CONFIG_REASON.BAD_TEAMS;
    let teamA = 0;
    for (const p of players) {
      if (p.team !== 0 && p.team !== 1) return CONFIG_REASON.BAD_TEAMS;
      if (p.team === 0) teamA++;
    }
    if (teamA !== 2) return CONFIG_REASON.BAD_TEAMS;
  }
  return null;
}

/** 땅이 있는 열 — 없으면(협곡) 가운데에서 멀어지는 쪽으로 8px씩 */
function spawnColumn(terrain: Terrain, x: number): number {
  const dir = x < Math.floor(WORLD_WIDTH / 2) ? -1 : 1;
  let cx = x;
  while (cx > 0 && cx < WORLD_WIDTH - 1 && groundAt(terrain.cols[cx], 0) < 0) cx += dir * 8;
  return cx;
}

export function createMatch(config: MatchConfig): { ok: true; state: MatchState } | { ok: false; reason: ConfigReason } {
  const invalid = validateConfig(config);
  if (invalid) return { ok: false, reason: invalid };
  const terrain = generateTerrain(config.mapId, streamSeed(config.seed, STREAM.MAP));
  const players = [...config.players].sort((a, b) => a.slot - b.slot);
  const n = players.length;

  // 스폰 순서: ffa는 섞고, team은 A·B가 번갈아 서게(어느 팀이 왼쪽인지는 seed)
  let rng = streamSeed(config.seed, STREAM.SPAWN);
  let order: PlayerConfig[];
  if (config.mode === 'team') {
    let leftTeam: number;
    [rng, leftTeam] = randomBelow(rng, 2);
    const a = players.filter((p) => p.team === leftTeam);
    const b = players.filter((p) => p.team !== leftTeam);
    order = [a[0], b[0], a[1], b[1]];
  } else {
    order = [...players];
    for (let i = order.length - 1; i > 0; i--) {
      let j: number;
      [rng, j] = randomBelow(rng, i + 1);
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
  }

  const tanks: (Tank | null)[] = [null, null, null, null];
  // 2인은 가운데 기준 DUEL_SPAN 간격, 3~4인은 가장자리 여백 사이를 고르게(흔들림·난수 소비 순서는 같다)
  const start = n === 2 ? Math.floor((WORLD_WIDTH - DUEL_SPAN) / 2) : SPAWN_MARGIN;
  const span = n === 2 ? DUEL_SPAN : WORLD_WIDTH - SPAWN_MARGIN * 2;
  for (let i = 0; i < n; i++) {
    let jitter: number;
    [rng, jitter] = randomRange(rng, -SPAWN_JITTER, SPAWN_JITTER);
    const x = spawnColumn(terrain, start + Math.floor((span * i) / (n - 1)) + jitter);
    const p = order[i];
    const kind = TANKS[p.tankId];
    tanks[p.slot] = {
      slot: p.slot,
      team: config.mode === 'team' ? p.team : p.slot,
      tankId: p.tankId,
      x,
      y: groundAt(terrain.cols[x], 0),
      hp: kind.hp,
      alive: true,
      fuel: kind.fuel,
      cooldown: 0,
      skips: 0,
    };
  }
  while (tanks.length > 0 && tanks[tanks.length - 1] === null) tanks.pop();

  const [afterFirst, first] = randomBelow(streamSeed(config.seed, STREAM.MATCH), n);
  const [match, wind] = randomRange(afterFirst, -WIND_MAX, WIND_MAX);
  const startSlot = players[first].slot;

  return {
    ok: true,
    state: {
      v: ENGINE_VERSION,
      mode: config.mode,
      mapId: config.mapId,
      turn: { no: 0, slot: startSlot, round: 1 },
      players: n,
      maxTurns: MAX_ROUNDS * n,
      lastByTeam: [-1, -1],
      wind,
      rng: match,
      tanks,
      terrain,
      result: { kind: 'ongoing' },
    },
  };
}

export function aliveTanks(tanks: readonly (Tank | null)[]): Tank[] {
  return tanks.filter((t): t is Tank => t !== null && t.alive);
}

/** 다음 턴 slot — ffa는 slot 오름차순 순환, team은 A·B 교대 + 팀 안 다음 생존자 순환 */
export function nextSlot(mode: MatchMode, tanks: readonly (Tank | null)[], current: number, lastByTeam: readonly number[]): number {
  if (mode === 'ffa') {
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      const t = tanks[(current + i) % MAX_PLAYERS];
      if (t && t.alive) return t.slot;
    }
    return current;
  }
  const team = 1 - (tanks[current] as Tank).team;
  const members = tanks.filter((t): t is Tank => t !== null && t.team === team);
  const last = lastByTeam[team];
  // last가 −1이면 첫 생존자부터
  const from = last < 0 ? -1 : members.findIndex((m) => m.slot === last);
  for (let i = 1; i <= members.length; i++) {
    const t = members[(from + i) % members.length];
    if (t.alive) return t.slot;
  }
  return current;
}

/** 생존 판정 — 남은 개인/팀이 1이면 승리, 0이면 무승부 */
export function judgeSurvivors(mode: MatchMode, tanks: readonly (Tank | null)[]): MatchResult {
  const alive = aliveTanks(tanks);
  if (alive.length === 0) return { kind: 'draw' };
  if (mode === 'ffa') return alive.length === 1 ? { kind: 'win', slots: [alive[0].slot] } : { kind: 'ongoing' };
  const team = alive[0].team;
  if (alive.some((t) => t.team !== team)) return { kind: 'ongoing' };
  return { kind: 'win', team, slots: tanks.filter((t): t is Tank => t !== null && t.team === team).map((t) => t.slot) };
}

/** 턴 상한 판정 — 남은 HP 합(team은 생존 팀원 합)이 가장 큰 개인/팀, 같으면 무승부 */
export function judgeByHp(mode: MatchMode, tanks: readonly (Tank | null)[]): MatchResult {
  const alive = aliveTanks(tanks);
  const sums: number[] = [0, 0, 0, 0];
  for (const t of alive) sums[t.team] += t.hp;
  let best = -1;
  let bestSum = -1;
  let tie = false;
  for (let g = 0; g < sums.length; g++) {
    if (!alive.some((t) => t.team === g)) continue;
    if (sums[g] > bestSum) {
      best = g;
      bestSum = sums[g];
      tie = false;
    } else if (sums[g] === bestSum) tie = true;
  }
  if (best < 0 || tie) return { kind: 'draw' };
  if (mode === 'ffa') return { kind: 'win', slots: [best] };
  return { kind: 'win', team: best, slots: tanks.filter((t): t is Tank => t !== null && t.team === best).map((t) => t.slot) };
}

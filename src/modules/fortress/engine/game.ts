/**
 * 행동 적용 (§10) — applyAction(state, action)은 입력 state를 바꾸지 않고 새 state를 돌려준다. 해시는 stateHash로 따로
 * previewShot은 같은 이동·탄도 코드(sim.walk·runFire)를 미리보기 모드로 돌린다
 */

import { ANGLE_MAX, MAX_SKIPS, POWER_MAX, REASON, type ActionReason, WIND_MAX } from './constants';
import { TANKS, WEAPONS, type Weapon } from './data';
import { randomRange } from './math';
import { type Impact, type MatchEvent, runFire, settle, walk } from './sim';
import { type MatchResult, type MatchState, type Tank, judgeByHp, judgeSurvivors, nextSlot } from './state';

export type FireInput = { kind: 'fire'; move: number; angle: number; power: number; weaponId: number };
export type Action = FireInput | { kind: 'skip' } | { kind: 'resign'; slot: number };

export type ActionOk = { ok: true; state: MatchState; events: MatchEvent[] };
export type ActionFail = { ok: false; reason: ActionReason };

const isInt = (v: unknown): v is number => Number.isInteger(v);

const copyTanks = (tanks: readonly (Tank | null)[]): (Tank | null)[] => tanks.map((t) => (t ? { ...t } : null));
const present = (tanks: readonly (Tank | null)[]): Tank[] => tanks.filter((t): t is Tank => t !== null);

/** 발사 입력 검증 — 통과하면 무기 */
function checkFire(state: MatchState, input: FireInput): Weapon | ActionReason {
  const tank = state.tanks[state.turn.slot] as Tank;
  if (!isInt(input.move) || Math.abs(input.move) > tank.fuel) return REASON.MOVE_RANGE;
  if (!isInt(input.angle) || input.angle < 0 || input.angle > ANGLE_MAX) return REASON.ANGLE_RANGE;
  if (!isInt(input.power) || input.power < 0 || input.power > POWER_MAX) return REASON.POWER_RANGE;
  if (!isInt(input.weaponId) || !TANKS[tank.tankId].weapons.includes(input.weaponId)) return REASON.WEAPON_UNKNOWN;
  const weapon = WEAPONS[input.weaponId];
  if (weapon.cooldown > 0 && tank.cooldown > 0) return REASON.WEAPON_COOLDOWN;
  return weapon;
}

/**
 * 판정·다음 턴 — 승패가 나면 턴은 그대로 두고 result만. 아니면 턴 수 +1, 턴 상한이면 HP 판정
 * endsTurn=false(남의 턴에 기권)면 턴·바람은 그대로
 */
function finish(state: MatchState, tanks: (Tank | null)[], terrain: MatchState['terrain'], endsTurn: boolean): MatchState {
  let result: MatchResult = judgeSurvivors(state.mode, tanks);
  if (result.kind !== 'ongoing' || !endsTurn) return { ...state, tanks, terrain, result };

  const no = state.turn.no + 1;
  if (no >= state.maxTurns) {
    result = judgeByHp(state.mode, tanks);
    return { ...state, turn: { ...state.turn, no }, tanks, terrain, result };
  }
  const current = state.turn.slot;
  const lastByTeam = [...state.lastByTeam];
  if (state.mode === 'team') lastByTeam[(tanks[current] as Tank).team] = current;
  const slot = nextSlot(state.mode, tanks, current, lastByTeam);
  const next = tanks[slot] as Tank;
  tanks[slot] = { ...next, fuel: TANKS[next.tankId].fuel };
  const [rng, wind] = randomRange(state.rng, -WIND_MAX, WIND_MAX);
  return {
    ...state,
    turn: { no, slot, round: Math.floor(no / state.players) + 1 },
    lastByTeam,
    wind,
    rng,
    tanks,
    terrain,
    result,
  };
}

export function applyAction(state: MatchState, action: Action): ActionOk | ActionFail {
  if (state.result.kind !== 'ongoing') return { ok: false, reason: REASON.NOT_RUNNING };
  if (typeof action !== 'object' || action === null) return { ok: false, reason: REASON.BAD_KIND };
  const events: MatchEvent[] = [];

  if (action.kind === 'resign') {
    const target = isInt(action.slot) ? state.tanks[action.slot] : null;
    if (!target || !target.alive) return { ok: false, reason: REASON.SLOT_NOT_ALIVE };
    const tanks = copyTanks(state.tanks);
    const tank = tanks[action.slot] as Tank;
    tank.alive = false;
    tank.hp = 0;
    events.push({ type: 'death', t: 0, slot: tank.slot, cause: 'resign' });
    return { ok: true, state: finish(state, tanks, state.terrain, action.slot === state.turn.slot), events };
  }

  if (action.kind === 'skip') {
    const tanks = copyTanks(state.tanks);
    const tank = tanks[state.turn.slot] as Tank;
    tank.skips += 1;
    tank.cooldown = Math.max(0, tank.cooldown - 1);
    if (tank.skips >= MAX_SKIPS) {
      tank.alive = false;
      tank.hp = 0;
      events.push({ type: 'death', t: 0, slot: tank.slot, cause: 'skips' });
    }
    return { ok: true, state: finish(state, tanks, state.terrain, true), events };
  }

  if (action.kind !== 'fire') return { ok: false, reason: REASON.BAD_KIND };
  const weapon = checkFire(state, action);
  if (typeof weapon === 'string') return { ok: false, reason: weapon };

  const tanks = copyTanks(state.tanks);
  const shooter = tanks[state.turn.slot] as Tank;
  const list = present(tanks);
  const moveTicks = walk(state.terrain, shooter, action.move, events);
  let terrain = state.terrain;
  let tick = moveTicks;
  if (shooter.alive) {
    const fire = runFire(terrain, list, events, shooter, action.angle, action.power, weapon, state.wind, moveTicks, false);
    terrain = fire.terrain;
    tick = fire.tick;
  }
  settle(terrain, list, events, tick);
  shooter.skips = 0;
  shooter.cooldown = weapon.cooldown > 0 && action.power > 0 ? weapon.cooldown : Math.max(0, shooter.cooldown - 1);
  return { ok: true, state: finish(state, tanks, terrain, true), events };
}

export type ShotPreview = {
  ok: true;
  /** 첫 폭발 지점(px)·틱 — 아무 데도 안 맞고 끝나면 null */
  impact: Impact | null;
  /** 첫 폭발의 예상 피해 — 인덱스 = slot */
  damage: number[];
  /** 이동 뒤 발사 위치 — 이동 중 즉사면 alive=false */
  from: { x: number; y: number; alive: boolean };
};

/** 지형·상태를 확정하지 않고 첫 탄의 착탄점·예상 피해만 (AI 탐색용, applyAction과 같은 탄도 코드) */
export function previewShot(state: MatchState, input: FireInput): ShotPreview | ActionFail {
  if (state.result.kind !== 'ongoing') return { ok: false, reason: REASON.NOT_RUNNING };
  const weapon = checkFire(state, input);
  if (typeof weapon === 'string') return { ok: false, reason: weapon };
  const tanks = copyTanks(state.tanks);
  const shooter = tanks[state.turn.slot] as Tank;
  const moveTicks = walk(state.terrain, shooter, input.move, []);
  const from = { x: shooter.x, y: shooter.y, alive: shooter.alive };
  if (!shooter.alive) return { ok: true, impact: null, damage: [0, 0, 0, 0], from };
  const fire = runFire(state.terrain, present(tanks), [], shooter, input.angle, input.power, weapon, state.wind, moveTicks, true);
  return { ok: true, impact: fire.firstImpact, damage: fire.previewDamage, from };
}

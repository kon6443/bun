/**
 * stateHash (§10) — FNV-1a 32비트, 고정 순서 정수열. 음수가 없게 오프셋을 더한다(없음 = 0, 있으면 값 + 1)
 * 순서: 버전·모드·턴(no·slot·round)·인원·턴 상한·팀별 마지막 slot·바람·rng·결과·탱크(slot 순)·열별 구간(길이, 값)
 * mapId는 넣지 않는다 — createMatch 뒤 판정에 쓰이지 않고 지형 자체가 해시에 들어간다
 */

import { WIND_MAX } from './constants';
import { fnv1a, toHex32 } from './random';
import type { MatchState } from './state';

export function stateValues(state: MatchState): number[] {
  const v: number[] = [
    state.v,
    state.mode === 'team' ? 1 : 0,
    state.turn.no,
    state.turn.slot,
    state.turn.round,
    state.players,
    state.maxTurns,
    state.lastByTeam[0] + 1,
    state.lastByTeam[1] + 1,
    state.wind + WIND_MAX,
    state.rng,
  ];
  const r = state.result;
  if (r.kind === 'ongoing') v.push(0);
  else if (r.kind === 'draw') v.push(2);
  else {
    v.push(1, r.team === undefined ? 0 : r.team + 1, r.slots.length);
    for (const s of r.slots) v.push(s);
  }
  v.push(state.tanks.length);
  for (const t of state.tanks) {
    if (!t) {
      v.push(0);
      continue;
    }
    v.push(1, t.slot, t.team, t.tankId, t.x, t.y, t.hp, t.alive ? 1 : 0, t.fuel, t.cooldown, t.skips);
  }
  const cols = state.terrain.cols;
  v.push(cols.length);
  for (const col of cols) {
    v.push(col.length);
    for (const value of col) v.push(value);
  }
  return v;
}

/** 상태 해시 — 소문자 hex 8자 */
export function stateHash(state: MatchState): string {
  return toHex32(fnv1a(stateValues(state)));
}

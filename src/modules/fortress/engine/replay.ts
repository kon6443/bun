/**
 * simulateMatch (§10) — 설정 + 행동 목록을 처음부터 다시 돌린다. 리플레이 재생·골든·서버 재검증에 쓴다
 * 리플레이 turns[] = 행동 목록(서버가 턴 로그로 갖고 있다 — 클라이언트 제출 없음)
 */

import { CONFIG_REASON, type ActionReason, type ConfigReason, MAX_ACTIONS } from './constants';
import { type Action, applyAction } from './game';
import { stateHash } from './hash';
import { type MatchConfig, type MatchState, createMatch } from './state';

export type SimulateOk = { ok: true; final: MatchState; hashes: string[] };
/** at = 실패한 행동 인덱스(설정 오류는 −1) */
export type SimulateFail = { ok: false; reason: ActionReason | ConfigReason; at: number };

export function simulateMatch(config: MatchConfig, actions: readonly Action[]): SimulateOk | SimulateFail {
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) return { ok: false, reason: CONFIG_REASON.TOO_MANY_ACTIONS, at: -1 };
  const created = createMatch(config);
  if (!created.ok) return { ok: false, reason: created.reason, at: -1 };
  let state = created.state;
  const hashes: string[] = [];
  for (let i = 0; i < actions.length; i++) {
    const next = applyAction(state, actions[i]);
    if (!next.ok) return { ok: false, reason: next.reason, at: i };
    state = next.state;
    hashes.push(stateHash(state));
  }
  return { ok: true, final: state, hashes };
}

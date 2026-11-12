import { type Action, type MatchEvent, type MatchState, TICKS_PER_SECOND } from './engine';

/**
 * 포트리스 턴 매치 규칙 — 엔진 밖에서 서버가 정하는 값 (docs/tasks/fortress DESIGN §11, D-012)
 *
 * 마감 시간·결과 집계·순위는 엔진 계약이 아니라 서버 규칙이다. 소켓·Redis와 무관한 순수 함수로 두고 매치 서비스가 쓴다.
 * 집계 기준은 프론트 F2 결과 화면과 같다 — 준 피해 = 자기 턴 fire에서 다른 팀에게 깎은 HP(damage amount 합),
 * KO = 자기 턴 fire에서 다른 팀 탱크가 hp·out으로 죽은 수. 기권·스킵 탈락·자기 팀 피해는 세지 않는다.
 */

/** 사람이 조준하는 시간(ms) — F5 플레이테스트의 턴당 사용 시간 분포로 재조정한다 */
export const TURN_AIM_MS = 20_000;
/**
 * 직전 행동 연출 시간 상한(초) — 엔진 이론 상한은 60초(MAX_TICKS_PER_TURN)라 막아 둔다.
 * 실측 최대 5.2초(AI 909턴)지만 정찰 탱크 최대 이동 + 폭격 고각 조합이 약 7.8초(234틱)까지 나와 9초로 둔다(D-013)
 */
export const TURN_PLAYBACK_MAX_SECONDS = 9;
/** 지연 여유(ms) — 화면 연출 꼬리(최대 약 1.1초)와 네트워크 지연 */
export const TURN_SLACK_MS = 2_000;

/**
 * 다음 턴 길이(ms) = 조준 20초 + 직전 행동 연출 시간 + 여유 2초.
 * `endTick`은 직전 행동 events의 엔진 마지막 틱(엔진 `eventsEndTick`), 첫 턴은 0
 */
export function turnDurationMs(endTick: number): number {
  const playbackSeconds = Math.min(Math.ceil(Math.max(0, endTick) / TICKS_PER_SECOND), TURN_PLAYBACK_MAX_SECONDS);
  return TURN_AIM_MS + playbackSeconds * 1000 + TURN_SLACK_MS;
}

/** 행동한 slot — fire·skip은 지금 턴 주인, resign은 기권한 slot */
export function actorOf(before: MatchState, action: Action): number {
  return action.kind === 'resign' ? action.slot : before.turn.slot;
}

/** slot별 누적 집계. `diedAt` = 죽은 행동의 seq(살아 있으면 null) — ffa 순위의 탈락 순서 */
export type SlotTally = { damage: number; kos: number; diedAt: number | null };
export type MatchTally = (SlotTally | null)[];

export function createTally(state: MatchState): MatchTally {
  return state.tanks.map((tank) => (tank ? { damage: 0, kos: 0, diedAt: null } : null));
}

/**
 * 행동 1개의 결과를 집계에 더한다(입력 불변, 새 배열 반환).
 * `before` = 행동 직전 state, `seq` = 이 행동의 actions 인덱스
 */
export function tallyAction(tally: MatchTally, before: MatchState, action: Action, events: readonly MatchEvent[], seq: number): MatchTally {
  const next = tally.map((entry) => (entry ? { ...entry } : null));
  const actor = actorOf(before, action);
  const actorTeam = before.tanks[actor]?.team;
  const isEnemy = (slot: number) => {
    const team = before.tanks[slot]?.team;
    return action.kind === 'fire' && team !== undefined && team !== actorTeam;
  };
  for (const event of events) {
    if (event.type === 'damage' && isEnemy(event.slot)) {
      const entry = next[actor];
      if (entry) entry.damage += event.amount;
    } else if (event.type === 'death') {
      const victim = next[event.slot];
      if (victim) victim.diedAt = seq;
      const entry = next[actor];
      if (entry && (event.cause === 'hp' || event.cause === 'out') && isEnemy(event.slot)) entry.kos += 1;
    }
  }
  return next;
}

/**
 * 최종 순위(slot별, 빈 slot은 null) — 같은 값이면 같은 순위, 다음 순위는 건너뛴다(1, 1, 3)
 * - team: 이긴 팀 1위·진 팀 2위, 무승부는 모두 1위
 * - ffa: 생존자는 승자 먼저, 그다음 HP 높은 순(턴 상한 판정) · 탈락자는 그 아래, 늦게 탈락할수록 위(같은 행동에서 함께 탈락하면 같은 순위)
 */
export function computePlaces(final: MatchState, tally: MatchTally): (number | null)[] {
  const { result } = final;
  if (final.mode === 'team') {
    return final.tanks.map((tank) => {
      if (!tank) return null;
      if (result.kind !== 'win') return 1;
      return tank.team === result.team ? 1 : 2;
    });
  }
  const winners = result.kind === 'win' ? result.slots : [];
  // 정렬 키가 클수록 높은 순위: [생존, 승자, HP 또는 탈락 seq]
  const keyOf = (slot: number): [number, number, number] => {
    const tank = final.tanks[slot];
    if (tank?.alive) return [1, winners.includes(slot) ? 1 : 0, tank.hp];
    return [0, 0, tally[slot]?.diedAt ?? -1];
  };
  const compare = (a: [number, number, number], b: [number, number, number]) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  const slots = final.tanks.flatMap((tank) => (tank ? [tank.slot] : []));
  return final.tanks.map((tank) => {
    if (!tank) return null;
    const mine = keyOf(tank.slot);
    return 1 + slots.filter((other) => compare(keyOf(other), mine) < 0).length;
  });
}

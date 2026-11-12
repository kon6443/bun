import golden from './engine/__fixtures__/golden-matches.json';
import { type Action, type MatchConfig, type MatchEvent, type MatchState, applyAction, createMatch, eventsEndTick } from './engine';
import { actorOf, computePlaces, createTally, tallyAction, turnDurationMs } from './fortress-match.rules';

type GoldenCase = { name: string; config: MatchConfig; actions: Action[]; expected: { ok: boolean } };

const ffa2: MatchConfig = {
  seed: 7,
  mapId: 'hills',
  mode: 'ffa',
  players: [
    { slot: 0, team: 0, tankId: 0 },
    { slot: 1, team: 0, tankId: 1 },
  ],
};
const team4: MatchConfig = {
  seed: 7,
  mapId: 'hills',
  mode: 'team',
  players: [
    { slot: 0, team: 0, tankId: 0 },
    { slot: 1, team: 1, tankId: 1 },
    { slot: 2, team: 0, tankId: 2 },
    { slot: 3, team: 1, tankId: 0 },
  ],
};

function start(config: MatchConfig): MatchState {
  const created = createMatch(config);
  if (!created.ok) throw new Error(created.reason);
  return created.state;
}

/** 지금 턴 주인이 `slot`인 state — 합성 이벤트 집계용(엔진을 거치지 않는다) */
const turnOf = (state: MatchState, slot: number): MatchState => ({ ...state, turn: { ...state.turn, slot } });

/** 탱크 일부 필드를 바꾼 최종 state */
function finalWith(state: MatchState, result: MatchState['result'], tanks: Record<number, { alive?: boolean; hp?: number }>): MatchState {
  return { ...state, result, tanks: state.tanks.map((tank) => (tank ? { ...tank, ...tanks[tank.slot] } : null)) };
}

const fire: Action = { kind: 'fire', move: 0, angle: 45, power: 50, weaponId: 0 };

describe('fortress-match.rules', () => {
  describe('turnDurationMs', () => {
    it.each([
      [0, 22_000],
      [-5, 22_000],
      [1, 23_000],
      [30, 23_000],
      [31, 24_000],
      [76, 25_000],
      [240, 30_000],
      [270, 31_000],
      [271, 31_000],
      [1800, 31_000],
    ])('엔진 마지막 틱 %i → %i ms (조준 20초 + 연출 올림·상한 9초 + 여유 2초)', (endTick, ms) => {
      expect(turnDurationMs(endTick)).toBe(ms);
    });
  });

  it('actorOf: fire·skip은 지금 턴 주인, resign은 기권한 slot', () => {
    const state = turnOf(start(ffa2), 1);
    expect(actorOf(state, fire)).toBe(1);
    expect(actorOf(state, { kind: 'skip' })).toBe(1);
    expect(actorOf(state, { kind: 'resign', slot: 0 })).toBe(0);
  });

  describe('tallyAction', () => {
    it('ffa: 상대 피해·KO만 세고 자기 피해는 빼며, 죽은 행동 seq를 남긴다', () => {
      const before = turnOf(start(ffa2), 0);
      const events: MatchEvent[] = [
        { type: 'damage', t: 10, slot: 1, amount: 30 },
        { type: 'damage', t: 10, slot: 0, amount: 12 },
        { type: 'death', t: 10, slot: 1, cause: 'hp' },
      ];
      const tally = tallyAction(createTally(before), before, fire, events, 4);
      expect(tally[0]).toEqual({ damage: 30, kos: 1, diedAt: null });
      expect(tally[1]).toEqual({ damage: 0, kos: 0, diedAt: 4 });
    });

    it('입력 집계는 바꾸지 않는다', () => {
      const before = turnOf(start(ffa2), 0);
      const tally = createTally(before);
      tallyAction(tally, before, fire, [{ type: 'damage', t: 1, slot: 1, amount: 5 }], 0);
      expect(tally[0]).toEqual({ damage: 0, kos: 0, diedAt: null });
    });

    it('추락(out)도 KO, 자기 자신 추락은 KO가 아니다', () => {
      const before = turnOf(start(ffa2), 0);
      const events: MatchEvent[] = [
        { type: 'death', t: 3, slot: 1, cause: 'out' },
        { type: 'death', t: 3, slot: 0, cause: 'out' },
      ];
      const tally = tallyAction(createTally(before), before, fire, events, 2);
      expect(tally[0]).toEqual({ damage: 0, kos: 1, diedAt: 2 });
      expect(tally[1]?.diedAt).toBe(2);
    });

    it('기권·스킵 탈락은 탈락 seq만 남기고 KO가 아니다', () => {
      const before = turnOf(start(ffa2), 0);
      const resigned = tallyAction(createTally(before), before, { kind: 'resign', slot: 1 }, [{ type: 'death', t: 0, slot: 1, cause: 'resign' }], 5);
      expect(resigned[0]?.kos).toBe(0);
      expect(resigned[1]?.diedAt).toBe(5);
      const skipped = tallyAction(createTally(before), before, { kind: 'skip' }, [{ type: 'death', t: 0, slot: 0, cause: 'skips' }], 6);
      expect(skipped[0]).toEqual({ damage: 0, kos: 0, diedAt: 6 });
    });

    it('team: 같은 팀 피해·사망은 세지 않는다', () => {
      const before = turnOf(start(team4), 0);
      const events: MatchEvent[] = [
        { type: 'damage', t: 5, slot: 2, amount: 20 },
        { type: 'damage', t: 5, slot: 1, amount: 15 },
        { type: 'death', t: 5, slot: 2, cause: 'hp' },
        { type: 'death', t: 5, slot: 3, cause: 'hp' },
      ];
      const tally = tallyAction(createTally(before), before, fire, events, 1);
      expect(tally[0]).toEqual({ damage: 15, kos: 1, diedAt: null });
    });
  });

  describe('computePlaces', () => {
    it('team: 이긴 팀 2명 1위·진 팀 2위, 무승부는 모두 1위', () => {
      const state = start(team4);
      const tally = createTally(state);
      expect(computePlaces(finalWith(state, { kind: 'win', team: 1, slots: [1, 3] }, { 3: { alive: false } }), tally)).toEqual([2, 1, 2, 1]);
      expect(computePlaces(finalWith(state, { kind: 'draw' }, {}), tally)).toEqual([1, 1, 1, 1]);
    });

    it('ffa: 승자 1위, 탈락자는 늦게 탈락할수록 위, 같은 행동 탈락은 같은 순위', () => {
      const state = start({ ...team4, mode: 'ffa' });
      const tally = createTally(state).map((entry, slot) => (entry ? { ...entry, diedAt: [null, 9, 4, 9][slot] ?? null } : null));
      const final = finalWith(state, { kind: 'win', slots: [0] }, { 1: { alive: false }, 2: { alive: false }, 3: { alive: false } });
      expect(computePlaces(final, tally)).toEqual([1, 2, 4, 2]);
    });

    it('ffa 턴 상한 판정: 승자 다음 생존자 HP 순, 탈락자는 그 아래', () => {
      const state = start({ ...team4, mode: 'ffa' });
      const tally = createTally(state).map((entry, slot) => (entry ? { ...entry, diedAt: slot === 3 ? 7 : null } : null));
      const final = finalWith(state, { kind: 'win', slots: [2] }, { 0: { hp: 40 }, 1: { hp: 55 }, 2: { hp: 80 }, 3: { alive: false, hp: 0 } });
      expect(computePlaces(final, tally)).toEqual([3, 2, 1, 4]);
    });

    it('ffa: 생존자 순위는 엔진 결과의 승자를 HP보다 먼저 본다', () => {
      const state = start(ffa2);
      expect(computePlaces(finalWith(state, { kind: 'win', slots: [1] }, { 0: { hp: 90 }, 1: { hp: 10 } }), createTally(state))).toEqual([2, 1]);
    });

    it('ffa 무승부: 최고 HP 동점 생존자 공동 1위, 함께 죽어 끝나면 함께 1위', () => {
      const state = start({ ...team4, mode: 'ffa' });
      const hpDraw = finalWith(state, { kind: 'draw' }, { 0: { hp: 50 }, 1: { hp: 50 }, 2: { hp: 20 }, 3: { alive: false } });
      const tally = createTally(state).map((entry, slot) => (entry ? { ...entry, diedAt: slot === 3 ? 2 : null } : null));
      expect(computePlaces(hpDraw, tally)).toEqual([1, 1, 3, 4]);

      const two = start(ffa2);
      const bothDead = createTally(two).map((entry) => (entry ? { ...entry, diedAt: 11 } : null));
      expect(computePlaces(finalWith(two, { kind: 'draw' }, { 0: { alive: false }, 1: { alive: false } }), bothDead)).toEqual([1, 1]);
    });
  });

  it('골든 경기의 모든 행동: 엔진 eventsEndTick으로 낸 턴 길이가 22~31초 안이다', () => {
    for (const c of (golden as unknown as GoldenCase[]).filter((x) => x.expected.ok)) {
      let state = start(c.config);
      for (const action of c.actions) {
        const out = applyAction(state, action);
        if (!out.ok) throw new Error(`${c.name}: ${out.reason}`);
        const ms = turnDurationMs(eventsEndTick(out.events));
        expect(ms).toBeGreaterThanOrEqual(22_000);
        expect(ms).toBeLessThanOrEqual(31_000);
        state = out.state;
      }
    }
  });

  it('골든 성공 경기: 엔진 결과의 승자가 1위이고, 준 피해 합은 적에게 들어간 damage 합과 같다', () => {
    const cases = (golden as unknown as GoldenCase[]).filter((c) => c.expected.ok);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      let state = start(c.config);
      let tally = createTally(state);
      let enemyDamage = 0;
      c.actions.forEach((action, seq) => {
        const out = applyAction(state, action);
        if (!out.ok) throw new Error(`${c.name}: ${out.reason}`);
        const actorTeam = state.tanks[actorOf(state, action)]?.team;
        if (action.kind === 'fire') {
          for (const e of out.events) if (e.type === 'damage' && state.tanks[e.slot]?.team !== actorTeam) enemyDamage += e.amount;
        }
        tally = tallyAction(tally, state, action, out.events, seq);
        state = out.state;
      });
      const places = computePlaces(state, tally);
      if (state.result.kind === 'win') for (const slot of state.result.slots) expect(places[slot]).toBe(1);
      expect(tally.reduce((sum, entry) => sum + (entry?.damage ?? 0), 0)).toBe(enemyDamage);
      expect(places.filter((p) => p !== null)).toHaveLength(c.config.players.length);
    }
  });
});

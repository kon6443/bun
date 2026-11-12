import golden from './engine/__fixtures__/golden-matches.json';
import { type Action, type MatchConfig, type MatchState, applyAction, createMatch } from './engine';
import {
  type BaseAward,
  type PointMatchFacts,
  type PointPlayerFacts,
  FORTRESS_POINTS,
  baseAwards,
  finalAward,
  fortressPointRefKey,
  playedTurns,
  realShotsBySlot,
  sameOpponentBonusPercent,
} from './fortress-points.rules';

type GoldenCase = { name: string; config: MatchConfig; actions: Action[] };
const cases = golden as unknown as GoldenCase[];
const goldenCase = (name: string): GoldenCase => {
  const found = cases.find((c) => c.name === name);
  if (!found) throw new Error(`골든 없음: ${name}`);
  return found;
};

const player = (over: Partial<PointPlayerFacts> & { slot: number }): PointPlayerFacts => ({
  playerId: `p${over.slot + 1}`,
  userId: null,
  kos: 0,
  realShots: 5,
  resigned: false,
  ...over,
});
const facts = (players: PointPlayerFacts[], over: Partial<PointMatchFacts> = {}): PointMatchFacts => ({
  matchId: 'M',
  turns: 10,
  result: { kind: 'win', slots: [0] },
  players,
  ...over,
});
const base = (over: Partial<BaseAward> = {}): BaseAward => ({
  userId: 7,
  playerId: 'p1',
  participation: 20_000,
  win: 30_000,
  ko: 20_000,
  others: [8],
  ...over,
});

/** 포트리스 포인트 규칙 (DESIGN §13, D-006·D-010) — 규칙 하나당 경계값을 고정한다 */
describe('fortress-points.rules', () => {
  it('수치는 D-006 그대로', () => {
    expect(FORTRESS_POINTS).toEqual({
      participation: 20_000,
      win: 30_000,
      ko: 10_000,
      maxKos: 3,
      minRealShots: 3,
      minTurns: 6,
      minLoggedInForBonus: 2,
      dailyCap: 500_000,
    });
  });

  describe('realShotsBySlot — 파워 1 이상 fire만, 쏜 사람은 그 fire 직전 턴 주인 (D-010)', () => {
    it('골든 경기: 엔진으로 독립 계산한 턴 주인별 발사 수와 같다', () => {
      for (const name of ['ffa 2인 canyon AI 하·상', 'ffa 4인 canyon AI 혼합', 'team 2:2 hills AI']) {
        const c = goldenCase(name);
        const expected = c.config.players.map(() => 0);
        const created = createMatch(c.config);
        if (!created.ok) throw new Error('골든 설정 실패');
        let state: MatchState = created.state;
        for (const action of c.actions) {
          if (action.kind === 'fire' && action.power > 0) expected[state.turn.slot] += 1;
          const next = applyAction(state, action);
          if (!next.ok) throw new Error('골든 실패');
          state = next.state;
        }
        expect(realShotsBySlot(c.config, c.actions)).toEqual(expected);
        expect(expected.reduce((a, b) => a + b, 0)).toBe(c.actions.length);
      }
    });

    it('파워 0 넘기기·skip·resign은 세지 않는다', () => {
      expect(realShotsBySlot(goldenCase('턴 상한 무승부').config, goldenCase('턴 상한 무승부').actions)).toEqual([0, 0]);
      const skips = goldenCase('스킵 3회 탈락');
      expect(realShotsBySlot(skips.config, skips.actions)).toEqual([0, 0]);
      const resign = goldenCase('기권 남의 턴·현재 턴');
      expect(realShotsBySlot(resign.config, resign.actions)).toEqual([0, 0, 0]);
    });

    it('엔진이 거부하는 행동을 만나면 그때까지만 센다(덜 세는 쪽)', () => {
      const c = goldenCase('ffa 2인 canyon AI 하·상');
      const broken: Action[] = [c.actions[0], { kind: 'fire', move: 0, angle: 999, power: 50, weaponId: 0 }, ...c.actions.slice(1)];
      const shots = realShotsBySlot(c.config, broken);
      // 거부된 행동은 세지 않고 멈춘다 — 정상 경기에서는 생기지 않는다(서버가 적용한 행동만 저장)
      expect(shots.reduce((a, b) => a + b, 0)).toBe(1);
    });
  });

  describe('playedTurns — 승패를 낸 턴까지 센다(리뷰 B2)', () => {
    const stateAt = (no: number, result: MatchState['result']): MatchState => {
      const created = createMatch(goldenCase('ffa 2인 canyon AI 하·상').config);
      if (!created.ok) throw new Error('골든 설정 실패');
      return { ...created.state, turn: { ...created.state.turn, no }, result };
    };

    it('6번째 턴(turn.no 5)에서 승패가 나면 6턴 — 유효 경기', () => {
      const state = stateAt(5, { kind: 'win', slots: [0] });
      expect(playedTurns(state)).toBe(6);
      const players = [player({ slot: 0, userId: 7 }), player({ slot: 1, userId: 8 })];
      expect(baseAwards(facts(players, { turns: playedTurns(state) }))).toHaveLength(2);
    });

    it('턴 상한 판정은 엔진이 turn.no를 올린 뒤 끝나므로 그대로 센다', () => {
      const ongoing = stateAt(0, { kind: 'ongoing' });
      expect(playedTurns(stateAt(ongoing.maxTurns, { kind: 'draw' }))).toBe(ongoing.maxTurns);
    });
  });

  describe('baseAwards', () => {
    const two = (over: Partial<PointPlayerFacts> = {}) => [
      player({ slot: 0, userId: 7, kos: 1, ...over }),
      player({ slot: 1, userId: 8 }),
    ];

    it('#1 참가 20,000 + 승리 30,000 + KO 10,000×n — 로그인 2명 유효 경기', () => {
      expect(baseAwards(facts(two()))).toEqual([
        { userId: 7, playerId: 'p1', participation: 20_000, win: 30_000, ko: 10_000, others: [8] },
        { userId: 8, playerId: 'p2', participation: 20_000, win: 0, ko: 0, others: [7] },
      ]);
    });

    it('#1 KO는 최대 3개까지(4 KO = 30,000)', () => {
      expect(baseAwards(facts(two({ kos: 4 })))[0].ko).toBe(30_000);
      expect(baseAwards(facts(two({ kos: 3 })))[0].ko).toBe(30_000);
    });

    it('#1 승리: 무승부는 아무도 없음 · 팀전은 이긴 팀 전원(result.slots — 죽은 팀원 포함)', () => {
      expect(baseAwards(facts(two(), { result: { kind: 'draw' } })).map((a) => a.win)).toEqual([0, 0]);
      const team = [player({ slot: 0, userId: 1 }), player({ slot: 1, userId: 2 }), player({ slot: 2, userId: 3 }), player({ slot: 3, userId: 4 })];
      const awards = baseAwards(facts(team, { result: { kind: 'win', team: 1, slots: [1, 3] } }));
      expect(awards.map((a) => [a.userId, a.win])).toEqual([
        [1, 0],
        [2, 30_000],
        [3, 0],
        [4, 30_000],
      ]);
    });

    it('#2 경기 6턴 미만이면 아무도 적립 없음 · 6턴이면 적립', () => {
      expect(baseAwards(facts(two(), { turns: 5 }))).toEqual([]);
      expect(baseAwards(facts(two(), { turns: 6 }))).toHaveLength(2);
    });

    it('#2 자기 실제 발사 3회 미만인 사람만 빠진다(2발 0 · 3발 적립)', () => {
      expect(baseAwards(facts(two({ realShots: 2 }))).map((a) => a.userId)).toEqual([8]);
      expect(baseAwards(facts(two({ realShots: 3 }))).map((a) => a.userId)).toEqual([7, 8]);
    });

    it('#3 로그인 1명(상대 게스트)이면 승리·KO 없이 참가만, 게스트는 대상 아님', () => {
      const awards = baseAwards(facts([player({ slot: 0, userId: 7, kos: 2 }), player({ slot: 1, userId: null })]));
      expect(awards).toEqual([{ userId: 7, playerId: 'p1', participation: 20_000, win: 0, ko: 0, others: [] }]);
    });

    it('#3 로그인 수는 서로 다른 userId로 센다 — 상대가 무효 경기(발사 부족)여도 로그인 2명이면 승리 보상', () => {
      const awards = baseAwards(facts([player({ slot: 0, userId: 7 }), player({ slot: 1, userId: 8, realShots: 0 })]));
      expect(awards).toEqual([{ userId: 7, playerId: 'p1', participation: 20_000, win: 30_000, ko: 0, others: [8] }]);
    });

    it('같은 userId가 두 자리면(생기지 않아야 함) 앞 slot만 — 두 번 적립하지 않는다', () => {
      const awards = baseAwards(facts([player({ slot: 0, userId: 7 }), player({ slot: 1, userId: 7 }), player({ slot: 2, userId: 8 })]));
      expect(awards.map((a) => [a.userId, a.playerId])).toEqual([
        [7, 'p1'],
        [8, 'p3'],
      ]);
    });

    it('기권(이탈·끊김 resign)한 사람은 0 — 보수적 해석(DESIGN §13 ⚖️)', () => {
      expect(baseAwards(facts(two({ resigned: true }))).map((a) => a.userId)).toEqual([8]);
    });

    it('#4 조합 키 others = 나 외 로그인 참가자(오름차순, 팀원 포함)', () => {
      const awards = baseAwards(facts([player({ slot: 0, userId: 9 }), player({ slot: 1, userId: 3 }), player({ slot: 2, userId: null }), player({ slot: 3, userId: 5 })]));
      expect(awards.map((a) => [a.userId, a.others])).toEqual([
        [9, [3, 5]],
        [3, [5, 9]],
        [5, [3, 9]],
      ]);
    });
  });

  describe('finalAward — 같은 상대 감쇠(#4)·일일 상한(#5)', () => {
    it('감쇠 비율: 1~3번째 100 · 4~5번째 50 · 6번째부터 0', () => {
      expect([1, 2, 3, 4, 5, 6, 10].map(sameOpponentBonusPercent)).toEqual([100, 100, 100, 50, 50, 0, 0]);
    });

    it('3번째는 그대로 70,000 · 4번째는 승리·KO 몫만 50% → 45,000 · 6번째는 참가만 20,000', () => {
      expect(finalAward('M', base(), 3, 0)).toEqual({ amount: 70_000, capped: false, memo: '포트리스 경기 M · 참가 20,000 · 승리 30,000 · KO 2×10,000' });
      expect(finalAward('M', base(), 4, 0)).toEqual({
        amount: 45_000,
        capped: false,
        memo: '포트리스 경기 M · 참가 20,000 · 승리 30,000 · KO 2×10,000 · 같은 상대 4번째 · 승리·KO 50%',
      });
      expect(finalAward('M', base(), 5, 0).amount).toBe(45_000);
      expect(finalAward('M', base(), 6, 0).amount).toBe(20_000);
    });

    it('50%는 내림(홀수 몫)', () => {
      expect(finalAward('M', base({ win: 0, ko: 10_001 }), 4, 0).amount).toBe(20_000 + 5_000);
    });

    it('로그인 상대가 없으면(others 빈 배열) 감쇠하지 않는다 — 이미 참가만', () => {
      expect(finalAward('M', base({ win: 0, ko: 0, others: [] }), 99, 0).amount).toBe(20_000);
    });

    it('일일 상한: 남은 한도로 잘라 적립 + 메모 "일일 상한 도달" · 꽉 차면 0(행 없음) · 정확히 남으면 잘리지 않음', () => {
      expect(finalAward('M', base(), 1, 490_000)).toMatchObject({ amount: 10_000, capped: true, memo: expect.stringContaining('일일 상한 도달') });
      expect(finalAward('M', base(), 1, 500_000)).toMatchObject({ amount: 0, capped: true });
      expect(finalAward('M', base(), 1, 600_000)).toMatchObject({ amount: 0, capped: true });
      expect(finalAward('M', base(), 1, 430_000)).toMatchObject({ amount: 70_000, capped: false });
    });

    it('감쇠 뒤 상한 — 4번째(45,000)에 남은 한도 30,000이면 30,000', () => {
      expect(finalAward('M', base(), 4, 470_000)).toMatchObject({ amount: 30_000, capped: true });
    });
  });

  it('REF_KEY = matchId:playerId', () => {
    expect(fortressPointRefKey('AbCdEfGhIjKlMnOp', 'p3')).toBe('AbCdEfGhIjKlMnOp:p3');
  });
});

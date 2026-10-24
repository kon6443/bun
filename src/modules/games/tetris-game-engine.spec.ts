import { createTetrisGameEngine } from './tetris-game-engine';
import { dailyBoardAt, dailySeed, kstDateOf } from './daily-board';

/**
 * 테트리스 엔진 항목 — 기본 보드 + 오늘의 테트리스(데일리 보드) 규칙 (docs/tasks/games-growth D-004).
 * 검증(simulateReplay) 자체는 tetris-engine.golden.spec이 고정한다.
 */
describe('createTetrisGameEngine — 보드·세션 규칙', () => {
  // 2026-10-22(목) 12:00 KST — 오늘 daily-2026-10-22, 어제 daily-2026-10-21
  const NOW = new Date('2026-10-22T03:00:00.000Z');
  const engineWith = (secret: string | undefined) => createTetrisGameEngine({ getDailySecret: () => secret });

  describe('dailyBoardAt', () => {
    it.each([
      ['낮', '2026-10-22T03:00:00.000Z', 'daily-2026-10-22'],
      ['23:59 KST (그날의 마지막)', '2026-10-22T14:59:59.999Z', 'daily-2026-10-22'],
      ['00:00 KST (다음 날 시작)', '2026-10-22T15:00:00.000Z', 'daily-2026-10-23'],
      ['연말 → 연초', '2026-12-31T15:00:00.000Z', 'daily-2027-01-01'],
    ])('%s → %s', (_name, iso, expected) => {
      expect(dailyBoardAt(new Date(iso)).boardKey).toBe(expected);
    });

    it('kstDateOf — UTC 15:00이 KST 날짜 경계', () => {
      expect(kstDateOf(new Date('2026-10-22T14:59:59.999Z'))).toBe('2026-10-22');
      expect(kstDateOf(new Date('2026-10-22T15:00:00.000Z'))).toBe('2026-10-23');
    });

    it('기간은 KST 00:00부터 하루', () => {
      expect(dailyBoardAt(NOW)).toEqual({
        boardKey: 'daily-2026-10-22',
        startsAt: new Date('2026-10-21T15:00:00.000Z'),
        endsAt: new Date('2026-10-22T15:00:00.000Z'),
      });
    });

    it('seed는 같은 날·같은 비밀값이면 같고, 날·비밀값이 다르면 다르다 (0 ~ 2^32−1)', () => {
      const seed = dailySeed('s', 'daily-2026-10-22');
      expect(dailySeed('s', 'daily-2026-10-22')).toBe(seed);
      expect(dailySeed('s', 'daily-2026-10-23')).not.toBe(seed);
      expect(dailySeed('t', 'daily-2026-10-22')).not.toBe(seed);
      expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true);
    });
  });

  describe('resolveSessionBoard', () => {
    it('board 생략 → 기본 보드, seed는 세션 서비스가 무작위로', () => {
      expect(engineWith('s').resolveSessionBoard(undefined, NOW)).toEqual({ boardKey: 'default', mode: null, seed: null });
    });

    it('daily → 오늘 보드 + 데일리 HMAC seed(전원 동일)', () => {
      expect(engineWith('secret-a').resolveSessionBoard('daily', NOW)).toEqual({
        boardKey: 'daily-2026-10-22',
        mode: 'daily',
        seed: dailySeed('secret-a', 'daily-2026-10-22'),
      });
    });

    it.each([undefined, ''])('비밀값이 %p면 daily만 503 GAME_DAILY_UNAVAILABLE', (secret) => {
      const engine = engineWith(secret);

      expect(() => engine.resolveSessionBoard('daily', NOW)).toThrow(expect.objectContaining({ code: 'GAME_DAILY_UNAVAILABLE', status: 503 }));
      expect(engine.resolveSessionBoard(undefined, NOW)).toMatchObject({ boardKey: 'default' });
    });

    it.each(['weekly', 'default', 'DAILY'])('모르는 방식 %s → null(422)', (board) => {
      expect(engineWith('s').resolveSessionBoard(board, NOW)).toBeNull();
    });
  });

  it.each([
    ['default', true],
    ['daily-2026-10-22', true],
    ['daily-2026-10-01', true],
    ['daily-2026-10-23', false], // 아직 오지 않은 날
    ['challenge-41', true], // 도전장 보드 (D-005)
    ['challenge-0', false],
    ['daily-2026-13-01', false],
    ['weekly-2026-w43', false],
    ['endless-s1', false],
  ])('isRankingBoard(%s) → %s', (boardKey, expected) => {
    expect(engineWith('s').isRankingBoard(boardKey, NOW)).toBe(expected);
  });

  it('기간 필터는 기본 보드만 — 데일리·도전장은 보드 자체가 단위', () => {
    const engine = engineWith('s');
    expect(engine.isPeriodRanking('default')).toBe(true);
    expect(engine.isPeriodRanking('daily-2026-10-22')).toBe(false);
    expect(engine.isPeriodRanking('challenge-41')).toBe(false);
    expect(engine.supportsChallenge).toBe(true);
  });

  describe('isReplayPublic — 데일리는 그날이 끝나고 세션 유효 시간(2시간)이 지나야 공개', () => {
    const engine = engineWith('s');

    it.each([
      ['기본 보드는 항상', 'default', '2026-10-22T03:00:00.000Z', true],
      ['진행 중인 오늘', 'daily-2026-10-22', '2026-10-22T03:00:00.000Z', false],
      ['다음 날 01:59 KST — 어제 마지막 세션이 아직 유효', 'daily-2026-10-22', '2026-10-22T16:59:59.999Z', false],
      ['다음 날 02:00 KST', 'daily-2026-10-22', '2026-10-22T17:00:00.000Z', true],
      ['지난 날', 'daily-2026-10-01', '2026-10-22T03:00:00.000Z', true],
      ['도전장 보드는 항상 — seed가 이미 공개', 'challenge-41', '2026-10-22T03:00:00.000Z', true],
    ])('%s', (_name, boardKey, iso, expected) => {
      expect(engine.isReplayPublic(boardKey, new Date(iso))).toBe(expected);
    });
  });

  describe('listBoards', () => {
    it('비밀값이 있으면 기본 + 오늘(current)·어제 데일리', () => {
      expect(engineWith('s').listBoards(NOW)).toEqual([
        { boardKey: 'default', mode: null, current: true, startsAt: null, endsAt: null },
        { ...dailyBoardAt(NOW), mode: 'daily', current: true },
        { ...dailyBoardAt(new Date('2026-10-21T03:00:00.000Z')), mode: 'daily', current: false },
      ]);
    });

    it('비밀값이 없으면 기본 보드만', () => {
      expect(engineWith(undefined).listBoards(NOW)).toEqual([{ boardKey: 'default', mode: null, current: true, startsAt: null, endsAt: null }]);
    });
  });

  describe('hallOfFamePeriods — 지난 8주(기본 보드) + 공개된 지난 데일리 7일 (games-growth D-010)', () => {
    it('목요일 낮: 지난주부터 8주, 어제부터 7일', () => {
      const periods = engineWith('s').hallOfFamePeriods(NOW);
      const weeks = periods.filter((p) => p.kind === 'weekly');
      const days = periods.filter((p) => p.kind === 'daily');

      expect(weeks).toHaveLength(8);
      expect(weeks[0]).toEqual({ kind: 'weekly', boardKey: 'default', startsAt: new Date('2026-10-11T15:00:00.000Z'), endsAt: new Date('2026-10-18T15:00:00.000Z') });
      expect(weeks[7].startsAt).toEqual(new Date('2026-08-23T15:00:00.000Z'));
      expect(days.map((p) => p.boardKey)).toEqual([
        'daily-2026-10-21',
        'daily-2026-10-20',
        'daily-2026-10-19',
        'daily-2026-10-18',
        'daily-2026-10-17',
        'daily-2026-10-16',
        'daily-2026-10-15',
      ]);
    });

    it('자정 직후 2시간은 어제 데일리가 아직 비공개라 빠진다', () => {
      const days = engineWith('s')
        .hallOfFamePeriods(new Date('2026-10-22T15:30:00.000Z')) // 10-23 00:30 KST
        .filter((p) => p.kind === 'daily');

      expect(days[0].boardKey).toBe('daily-2026-10-21');
      expect(days).toHaveLength(6);
    });
  });
});

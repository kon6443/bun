import { createDefenseGameEngine } from './defense-game-engine';
import { weeklySeed } from './weekly-board';

describe('createDefenseGameEngine — 보드·세션·형식 규칙', () => {
  // 2026-10-22(목) KST — 이번 주 weekly-2026-w43, 지난 주 w42
  const NOW = new Date('2026-10-22T03:00:00.000Z');
  const verify = jest.fn();
  const engineWith = (secret: string | undefined) =>
    createDefenseGameEngine({ getWeeklySecret: () => secret, verify });

  it('계약 상수 — 30틱·최대 3배속·판 상한 162,000틱·세션 4시간·기본 보드 endless-s1', () => {
    expect(engineWith('s')).toMatchObject({
      ticksPerSecond: 30,
      maxSpeed: 3,
      maxFrames: 162_000,
      maxInputLength: 20_000,
      sessionTtlSeconds: 4 * 60 * 60,
      defaultBoardKey: 'endless-s1',
      topLevelReplayParams: [],
    });
  });

  describe('resolveSessionBoard', () => {
    it.each([undefined, 'endless'])('board %s → 무한 보드, seed는 세션 서비스가 무작위로', board => {
      expect(engineWith('s').resolveSessionBoard(board, NOW)).toEqual({
        boardKey: 'endless-s1',
        mode: 'endless',
        seed: null,
      });
    });

    it('weekly → 이번 주 보드 + 주간 HMAC seed(전원 동일)', () => {
      expect(engineWith('secret-a').resolveSessionBoard('weekly', NOW)).toEqual({
        boardKey: 'weekly-2026-w43',
        mode: 'weekly',
        seed: weeklySeed('secret-a', 'weekly-2026-w43'),
      });
    });

    it.each([undefined, ''])('주간 비밀값이 %p면 weekly만 503 GAME_WEEKLY_UNAVAILABLE', secret => {
      const engine = engineWith(secret);

      expect(() => engine.resolveSessionBoard('weekly', NOW)).toThrow(
        expect.objectContaining({ code: 'GAME_WEEKLY_UNAVAILABLE', status: 503 }),
      );
      expect(engine.resolveSessionBoard('endless', NOW)).toMatchObject({ boardKey: 'endless-s1' });
    });

    it.each(['campaign', 'default', 'ENDLESS'])('모르는 방식 %s → null(422)', board => {
      expect(engineWith('s').resolveSessionBoard(board, NOW)).toBeNull();
    });
  });

  describe('isRankingBoard', () => {
    it.each([
      ['endless-s1', true],
      ['weekly-2026-w43', true],
      ['weekly-2026-w42', true],
      ['weekly-2025-w53', true],
      ['weekly-2026-w44', false], // 아직 오지 않은 주
      ['weekly-2027-w01', false],
      ['endless-s2', false], // 아직 없는 시즌
      ['endless-s0', false],
      ['weekly-2026-w54', false],
      ['weekly-2026-w4', false],
      ['default', false],
    ])('%s → %s', (boardKey, expected) => {
      expect(engineWith('s').isRankingBoard(boardKey, NOW)).toBe(expected);
    });
  });

  it.each([
    ['weekly-2026-w43', false], // 이번 주 — 진행 중
    ['weekly-2026-w44', false],
    ['weekly-2026-w42', true], // 끝난 주
    ['weekly-2025-w53', true],
    ['endless-s1', true],
  ])('리플레이 공개: %s → %s', (boardKey, expected) => {
    expect(engineWith('s').isReplayPublic(boardKey, NOW)).toBe(expected);
  });

  it('주간 보드만 기간 필터를 쓰지 않는다', () => {
    const engine = engineWith('s');
    expect(engine.isPeriodRanking('weekly-2026-w43')).toBe(false);
    expect(engine.isPeriodRanking('endless-s1')).toBe(true);
  });

  describe('listBoards', () => {
    it('현재 무한 시즌 + 이번 주(current)·지난 주 주간 보드', () => {
      expect(engineWith('s').listBoards(NOW)).toEqual([
        { boardKey: 'endless-s1', mode: 'endless', current: true, startsAt: null, endsAt: null },
        {
          boardKey: 'weekly-2026-w43',
          mode: 'weekly',
          current: true,
          startsAt: new Date('2026-10-18T15:00:00.000Z'),
          endsAt: new Date('2026-10-25T15:00:00.000Z'),
        },
        {
          boardKey: 'weekly-2026-w42',
          mode: 'weekly',
          current: false,
          startsAt: new Date('2026-10-11T15:00:00.000Z'),
          endsAt: new Date('2026-10-18T15:00:00.000Z'),
        },
      ]);
    });

    it('주간 비밀값이 없으면 주간 보드를 빼고 무한만', () => {
      expect(
        engineWith(undefined)
          .listBoards(NOW)
          .map(b => b.boardKey),
      ).toEqual(['endless-s1']);
    });
  });

  it('params는 비어 있어야 한다 — 디펜스 리플레이에는 게임별 설정이 없다', () => {
    const engine = engineWith('s');
    expect(engine.isValidParams({})).toBe(true);
    expect(engine.isValidParams({ das: 10, arr: 2 })).toBe(false);
  });

  it('verify는 주입한 실행기에 그대로 맡긴다', async () => {
    verify.mockResolvedValue({ ok: false, reason: 'NOT_ENDED' });
    const input = { seed: 1, boardKey: 'endless-s1', frames: 30, inputs: [], params: {} };

    await expect(engineWith('s').verify(input)).resolves.toEqual({ ok: false, reason: 'NOT_ENDED' });
    expect(verify).toHaveBeenCalledWith(input);
  });
});

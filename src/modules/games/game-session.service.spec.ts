import { GameSessionService } from './game-session.service';

/**
 * GameSessionService — Redis 1회용 게임 세션 (docs/tasks/games DESIGN §2).
 *
 * 레플리카 공유를 위해 Redis에만 두고, 제출 시 GETDEL로 한 번만 꺼낸다. Redis를 못 쓰면 503으로 알린다.
 */
describe('GameSessionService', () => {
  let service: GameSessionService;
  let redis: { status: string; set: jest.Mock; get: jest.Mock; getdel: jest.Mock; eval: jest.Mock; multi: jest.Mock };
  let multi: { incr: jest.Mock; expire: jest.Mock; exec: jest.Mock };

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    service = new GameSessionService();
    multi = { incr: jest.fn(), expire: jest.fn(), exec: jest.fn().mockResolvedValue([[null, 1], [null, 1]]) };
    multi.incr.mockReturnValue(multi);
    multi.expire.mockReturnValue(multi);
    redis = { status: 'ready', set: jest.fn().mockResolvedValue('OK'), get: jest.fn(), getdel: jest.fn(), eval: jest.fn(), multi: jest.fn(() => multi) };
    service.setRedisClient(redis as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('UUID 세션에 0~2^32−1 seed를 정하고 엔진별 TTL로 저장해야 함', async () => {
    const { sessionId, session, expiresAt } = await service.createSession({ gameType: 'TETRIS', boardKey: 'default', seed: null, engineVersion: 1, userId: 7, ttlSeconds: 7200 });

    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isInteger(session.seed) && session.seed >= 0 && session.seed < 2 ** 32).toBe(true);
    expect(session).toEqual(expect.objectContaining({ gameType: 'TETRIS', boardKey: 'default', engineVersion: 1, userId: 7 }));
    expect(redis.set).toHaveBeenCalledWith(`game:session:${sessionId}`, JSON.stringify(session), 'EX', 7200);
    expect(expiresAt.getTime()).toBe(session.startedAt + 7_200_000);
  });

  it('보드가 정한 seed가 있으면 무작위 대신 그 값을 써야 함 (주간 도전처럼 전원 동일)', async () => {
    const { session } = await service.createSession({ gameType: 'TETRIS', boardKey: 'weekly-2026-w43', seed: 42, engineVersion: 1, userId: null, ttlSeconds: 14400 });

    expect(session).toEqual(expect.objectContaining({ boardKey: 'weekly-2026-w43', seed: 42 }));
    expect(redis.set).toHaveBeenCalledWith(expect.any(String), JSON.stringify(session), 'EX', 14400);
  });

  it('getSession은 GET으로 읽기만 해야 함 (검증 전 — 지우지 않는다) — 없으면 null', async () => {
    redis.get.mockResolvedValueOnce(JSON.stringify({ gameType: 'TETRIS', seed: 1 })).mockResolvedValueOnce(null);

    await expect(service.getSession('a')).resolves.toEqual({ gameType: 'TETRIS', seed: 1 });
    await expect(service.getSession('a')).resolves.toBeNull();
    expect(redis.get).toHaveBeenCalledWith('game:session:a');
    expect(redis.getdel).not.toHaveBeenCalled();
  });

  it('consumeSession은 GETDEL로 꺼내야 함 (1회용) — 없으면 null', async () => {
    redis.getdel.mockResolvedValueOnce(JSON.stringify({ gameType: 'TETRIS', seed: 1 })).mockResolvedValueOnce(null);

    await expect(service.consumeSession('a')).resolves.toEqual({ gameType: 'TETRIS', seed: 1 });
    await expect(service.consumeSession('a')).resolves.toBeNull();
    expect(redis.getdel).toHaveBeenCalledWith('game:session:a');
  });

  describe('검증 가드·시간 초과 횟수·세션 복구 (games-polish P2)', () => {
    it('가드는 SET NX + TTL 60초, 잡으면 소유 토큰·못 잡으면 null (BD-01)', async () => {
      const token = await service.claimVerification('a');
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(redis.set).toHaveBeenCalledWith('game:session:a:verifying', token, 'EX', 60, 'NX');

      redis.set.mockResolvedValueOnce(null);
      await expect(service.claimVerification('a')).resolves.toBeNull();
    });

    it('해제는 내 토큰일 때만 지운다 — 만료 뒤 남이 잡은 가드를 지우지 않게(리뷰 Opus #1)', async () => {
      await service.releaseVerification('a', 'tok');
      expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"), 1, 'game:session:a:verifying', 'tok');
    });

    it('시간 초과 횟수는 INCR + 세션 TTL로 세고 그 값을 돌려준다 (BD-02)', async () => {
      multi.exec.mockResolvedValueOnce([[null, 2], [null, 1]]);
      await expect(service.recordVerifyTimeout('a', 14400)).resolves.toBe(2);
      expect(multi.incr).toHaveBeenCalledWith('game:session:a:timeouts');
      expect(multi.expire).toHaveBeenCalledWith('game:session:a:timeouts', 14400);
    });

    it('세션 복구는 남은 TTL만큼 NX로 — 만료가 지났으면 쓰지 않고 false (BD-03)', async () => {
      const now = Date.now();
      const session = { gameType: 'TETRIS' as const, boardKey: 'default', seed: 1, engineVersion: 1, startedAt: now - 3_600_000, userId: null };

      await expect(service.restoreSession('a', session, 7200)).resolves.toBe(true);
      const [, , , ttl, nx] = redis.set.mock.calls[0];
      expect(ttl).toBeGreaterThanOrEqual(3599);
      expect(ttl).toBeLessThanOrEqual(3600);
      expect(nx).toBe('NX');

      redis.set.mockClear();
      await expect(service.restoreSession('a', { ...session, startedAt: now - 7_300_000 }, 7200)).resolves.toBe(false);
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['클라이언트 미주입', () => service.setRedisClient(null as never)],
    ['연결 안 됨', () => (redis.status = 'reconnecting')],
  ])('%s이면 503 GAME_SESSION_UNAVAILABLE', async (_name, arrange) => {
    arrange();

    await expect(service.createSession({ gameType: 'TETRIS', boardKey: 'default', seed: null, engineVersion: 1, userId: null, ttlSeconds: 7200 })).rejects.toMatchObject({
      code: 'GAME_SESSION_UNAVAILABLE',
      status: 503,
    });
    await expect(service.getSession('a')).rejects.toMatchObject({ code: 'GAME_SESSION_UNAVAILABLE', status: 503 });
    await expect(service.consumeSession('a')).rejects.toMatchObject({ code: 'GAME_SESSION_UNAVAILABLE', status: 503 });
  });

  it('Redis 명령이 실패해도 503으로 바꿔야 함', async () => {
    redis.set.mockRejectedValue(new Error('NOAUTH'));
    redis.get.mockRejectedValue(new Error('NOAUTH'));

    await expect(service.createSession({ gameType: 'TETRIS', boardKey: 'default', seed: null, engineVersion: 1, userId: null, ttlSeconds: 7200 })).rejects.toMatchObject({
      code: 'GAME_SESSION_UNAVAILABLE',
      status: 503,
    });
    await expect(service.getSession('a')).rejects.toMatchObject({ code: 'GAME_SESSION_UNAVAILABLE', status: 503 });
  });
});

import { GameSessionService } from './game-session.service';

/**
 * GameSessionService — Redis 1회용 게임 세션 (docs/tasks/games DESIGN §2).
 *
 * 레플리카 공유를 위해 Redis에만 두고, 제출 시 GETDEL로 한 번만 꺼낸다. Redis를 못 쓰면 503으로 알린다.
 */
describe('GameSessionService', () => {
  let service: GameSessionService;
  let redis: { status: string; set: jest.Mock; getdel: jest.Mock };

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    service = new GameSessionService();
    redis = { status: 'ready', set: jest.fn().mockResolvedValue('OK'), getdel: jest.fn() };
    service.setRedisClient(redis as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('UUID 세션에 0~2^32−1 seed를 정하고 TTL 2시간으로 저장해야 함', async () => {
    const { sessionId, session, expiresAt } = await service.createSession({ gameType: 'TETRIS', engineVersion: 1, userId: 7 });

    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isInteger(session.seed) && session.seed >= 0 && session.seed < 2 ** 32).toBe(true);
    expect(session).toEqual(expect.objectContaining({ gameType: 'TETRIS', engineVersion: 1, userId: 7 }));
    expect(redis.set).toHaveBeenCalledWith(`game:session:${sessionId}`, JSON.stringify(session), 'EX', 7200);
    expect(expiresAt.getTime()).toBe(session.startedAt + 7_200_000);
  });

  it('consumeSession은 GETDEL로 꺼내야 함 (1회용) — 없으면 null', async () => {
    redis.getdel.mockResolvedValueOnce(JSON.stringify({ gameType: 'TETRIS', seed: 1 })).mockResolvedValueOnce(null);

    await expect(service.consumeSession('a')).resolves.toEqual({ gameType: 'TETRIS', seed: 1 });
    await expect(service.consumeSession('a')).resolves.toBeNull();
    expect(redis.getdel).toHaveBeenCalledWith('game:session:a');
  });

  it.each([
    ['클라이언트 미주입', () => service.setRedisClient(null as never)],
    ['연결 안 됨', () => (redis.status = 'reconnecting')],
  ])('%s이면 503 GAME_SESSION_UNAVAILABLE', async (_name, arrange) => {
    arrange();

    await expect(service.createSession({ gameType: 'TETRIS', engineVersion: 1, userId: null })).rejects.toMatchObject({
      code: 'GAME_SESSION_UNAVAILABLE',
      status: 503,
    });
    await expect(service.consumeSession('a')).rejects.toMatchObject({ code: 'GAME_SESSION_UNAVAILABLE', status: 503 });
  });

  it('Redis 명령이 실패해도 503으로 바꿔야 함', async () => {
    redis.set.mockRejectedValue(new Error('NOAUTH'));

    await expect(service.createSession({ gameType: 'TETRIS', engineVersion: 1, userId: null })).rejects.toMatchObject({
      code: 'GAME_SESSION_UNAVAILABLE',
      status: 503,
    });
  });
});

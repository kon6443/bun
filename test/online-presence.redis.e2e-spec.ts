import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Gauge } from 'prom-client';
import { OnlineUserService } from '../src/modules/team/online-user.service';
import { FishingOnlineService } from '../src/modules/fishing/fishing-online.service';

/**
 * 온라인 프레즌스의 등록·제거 Lua(`common/utils/presence-scripts.ts`)를 실제 Redis로 검증한다 — **opt-in**.
 *
 * CI·기본 E2E에는 Redis가 없으므로 `PRESENCE_REDIS_TEST_PORT`가 있을 때만 돈다.
 * 로컬: `PRESENCE_REDIS_TEST_PORT=6380 pnpm test:e2e -- --testPathPatterns online-presence`
 * (`team:9999…`·`fishing:map:probe-…` 키만 쓰고 끝에서 지운다. 운영 Redis를 가리키지 말 것.)
 *
 * mock 단위 테스트는 eval 인자만 본다 — 마지막 탭 판정·맵 해시 정리·다른 탭 보존이라는 **Lua 본문의 의미**는 여기서만 확인된다.
 */
const port = Number(process.env.PRESENCE_REDIS_TEST_PORT);
const describeIfRedis = port ? describe : describe.skip;

describeIfRedis('온라인 프레즌스 소켓 제거 — 실제 Redis', () => {
  let redis: Redis;
  const TEAM_ID = 9999;
  const MAP_ID = `probe-${Date.now()}`;
  const USER_ID = 77;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    redis = new Redis({ host: '127.0.0.1', port, lazyConnect: true });
    await redis.connect();
  });

  afterAll(async () => {
    const keys = [
      ...(await redis.keys(`team:${TEAM_ID}:*`)),
      ...(await redis.keys(`fishing:map:${MAP_ID}:*`)),
      ...(await redis.keys('socket:probe-*')),
      ...(await redis.keys('fishing:socket:probe-*')),
    ];
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
    jest.restoreAllMocks();
  });

  describe('팀 (OnlineUserService)', () => {
    const service = new OnlineUserService({ set: jest.fn(), remove: jest.fn() } as unknown as Gauge<string>);

    beforeAll(() => service.setRedisClient(redis));

    it('두 탭 중 하나를 닫으면 온라인을 유지하고, 마지막 탭을 닫으면 팀 온라인에서 빠진다', async () => {
      await service.addUserToOnline(TEAM_ID, USER_ID, '탐침', 'probe-a');
      await service.addUserToOnline(TEAM_ID, USER_ID, '탐침', 'probe-b');

      await expect(service.removeSocket('probe-a')).resolves.toMatchObject({ isFullyOffline: false });
      await expect(redis.hget(`team:${TEAM_ID}:online`, String(USER_ID))).resolves.toBe('탐침');
      await expect(redis.exists('socket:probe-a')).resolves.toBe(0);

      await expect(service.removeSocket('probe-b')).resolves.toMatchObject({ isFullyOffline: true });
      await expect(redis.hget(`team:${TEAM_ID}:online`, String(USER_ID))).resolves.toBeNull();
      await expect(redis.exists(`team:${TEAM_ID}:user:${USER_ID}:sockets`)).resolves.toBe(0);
    });

    it('두 탭이 동시에 닫혀도 마지막 판정은 정확히 한 번이다', async () => {
      await service.addUserToOnline(TEAM_ID, USER_ID, '탐침', 'probe-c');
      await service.addUserToOnline(TEAM_ID, USER_ID, '탐침', 'probe-d');

      const results = await Promise.all([service.removeSocket('probe-c'), service.removeSocket('probe-d')]);

      expect(results.filter((r) => r?.isFullyOffline)).toHaveLength(1);
    });

    it('같은 소켓을 leave와 disconnect가 동시에 정리해도 퇴장 판정은 한 번이다', async () => {
      await service.addUserToOnline(TEAM_ID, USER_ID, '탐침', 'probe-e');

      const results = await Promise.all([service.removeSocket('probe-e'), service.removeSocket('probe-e')]);

      expect(results.filter((r) => r?.isFullyOffline)).toHaveLength(1);
    });

    it('등록은 등록 전 소켓 수로 이미 온라인인지 판단한다', async () => {
      await expect(service.addUserToOnline(TEAM_ID, USER_ID, '탐침', 'probe-g')).resolves.toEqual({ wasAlreadyOnline: false });
      await expect(service.addUserToOnline(TEAM_ID, USER_ID, '탐침', 'probe-h')).resolves.toEqual({ wasAlreadyOnline: true });
      await expect(redis.hgetall('socket:probe-g')).resolves.toEqual({ teamId: String(TEAM_ID), userId: String(USER_ID), userName: '탐침' });
      expect(await redis.ttl(`team:${TEAM_ID}:online`)).toBeGreaterThan(3600);
      await service.removeSocket('probe-g');
      await service.removeSocket('probe-h');
    });
  });

  describe('낚시 (FishingOnlineService)', () => {
    const service = new FishingOnlineService();

    beforeAll(() => service.setRedisClient(redis));

    it('마지막 탭을 닫으면 온라인·위치·상태가 모두 지워지고, 다른 탭이 있으면 남는다', async () => {
      await service.addUserToOnline(MAP_ID, USER_ID, '탐침', 'probe-f1');
      await service.addUserToOnline(MAP_ID, USER_ID, '탐침', 'probe-f2');
      await redis.hset(`fishing:map:${MAP_ID}:positions`, String(USER_ID), JSON.stringify({ x: 100, y: 300, direction: 'left' }));
      await redis.hset(`fishing:map:${MAP_ID}:states`, String(USER_ID), 'idle');

      await expect(service.removeSocket('probe-f1')).resolves.toMatchObject({ isFullyOffline: false });
      await expect(redis.hexists(`fishing:map:${MAP_ID}:positions`, String(USER_ID))).resolves.toBe(1);

      await expect(service.removeSocket('probe-f2')).resolves.toMatchObject({ mapId: MAP_ID, isFullyOffline: true });
      for (const suffix of ['online', 'positions', 'states']) {
        await expect(redis.hexists(`fishing:map:${MAP_ID}:${suffix}`, String(USER_ID))).resolves.toBe(0);
      }
    });
  });
});

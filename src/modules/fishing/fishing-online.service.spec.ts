import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { FishingOnlineService } from './fishing-online.service';
import type { PlayerPosition } from './fishing.events';

const MAP_ID = 'lake-1';
const USER_ID = 42;
const SOCKET_ID = 'socket-abc';

const SOCKET_KEY = `fishing:socket:${SOCKET_ID}`;
const USER_SOCKETS_KEY = `fishing:map:${MAP_ID}:user:${USER_ID}:sockets`;
const ONLINE_KEY = `fishing:map:${MAP_ID}:online`;
const POSITIONS_KEY = `fishing:map:${MAP_ID}:positions`;
const STATES_KEY = `fishing:map:${MAP_ID}:states`;

const POSITION: PlayerPosition = { x: 100, y: 200, direction: 'left' };

/**
 * 낚시 맵의 멀티플레이 상태(접속·위치·낚시 상태)를 Redis에 보관한다.
 *
 * 팀 프레즌스(`OnlineUserService`)와 키 네임스페이스가 `fishing:` 프리픽스로 완전히 갈라져
 * 있고, 유저당 **세 종류의 상태**(온라인·위치·낚시상태)를 함께 다룬다는 점이 다르다.
 * 그래서 이 서비스에서 가장 깨지기 쉬운 곳은 **파이프라인 결과의 인덱스 계산**이다 —
 * 유저 1명당 3개 명령을 넣고 `i * 3`으로 꺼내므로, 오프바이원이 나면
 * **A의 위치·낚시상태가 B에게 표시된다**(예외도 로그도 없이).
 */
describe('FishingOnlineService', () => {
  let service: FishingOnlineService;
  let redis: {
    scard: jest.Mock;
    hgetall: jest.Mock;
    hlen: jest.Mock;
    exists: jest.Mock;
    pipeline: jest.Mock;
  };
  let pipeline: Record<string, jest.Mock>;
  /** pipeline() 호출마다 새 객체를 주는 대신, 호출 순서별로 결과를 다르게 주기 위한 큐 */
  let execResults: unknown[][];

  const buildService = async (): Promise<FishingOnlineService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FishingOnlineService],
    }).compile();
    return module.get(FishingOnlineService);
  };

  beforeEach(async () => {
    execResults = [];
    pipeline = {
      hset: jest.fn().mockReturnThis(),
      hget: jest.fn().mockReturnThis(),
      hdel: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      sadd: jest.fn().mockReturnThis(),
      srem: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      scard: jest.fn().mockReturnThis(),
      exec: jest.fn(() => Promise.resolve(execResults.shift() ?? [])),
    };
    redis = {
      scard: jest.fn().mockResolvedValue(0),
      hgetall: jest.fn().mockResolvedValue({}),
      hlen: jest.fn().mockResolvedValue(0),
      exists: jest.fn().mockResolvedValue(0),
      pipeline: jest.fn(() => pipeline),
    };

    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    service = await buildService();
    service.setRedisClient(redis as unknown as Redis);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('addUserToOnline', () => {
    it.each([
      ['기존 소켓이 없으면', 0, false],
      ['기존 소켓이 있으면', 2, true],
    ])('%s wasAlreadyOnline=%s여야 함', async (_desc, existing, expected) => {
      redis.scard.mockResolvedValue(existing);

      await expect(
        service.addUserToOnline(MAP_ID, USER_ID, '낚시왕', SOCKET_ID),
      ).resolves.toEqual({ wasAlreadyOnline: expected });
    });

    it('판정은 소켓을 추가하기 전의 개수로 해야 함', async () => {
      await service.addUserToOnline(MAP_ID, USER_ID, '낚시왕', SOCKET_ID);

      // 추가 후에 세면 항상 1 이상이 되어 첫 입장 알림이 영영 안 나간다
      expect(redis.scard.mock.invocationCallOrder[0]).toBeLessThan(
        pipeline.sadd.mock.invocationCallOrder[0],
      );
    });

    it('fishing: 프리픽스 키에만 기록해야 함 (팀 프레즌스와 분리)', async () => {
      await service.addUserToOnline(MAP_ID, USER_ID, '낚시왕', SOCKET_ID);

      // 프리픽스가 겹치면 팀 온라인 목록과 낚시 맵 목록이 서로를 덮어쓴다
      expect(pipeline.hset).toHaveBeenCalledWith(SOCKET_KEY, {
        mapId: MAP_ID,
        userId: String(USER_ID),
        userName: '낚시왕',
      });
      expect(pipeline.sadd).toHaveBeenCalledWith(USER_SOCKETS_KEY, SOCKET_ID);
      expect(pipeline.hset).toHaveBeenCalledWith(ONLINE_KEY, String(USER_ID), '낚시왕');
    });

    it('모든 키에 TTL을 걸어야 함', async () => {
      await service.addUserToOnline(MAP_ID, USER_ID, '낚시왕', SOCKET_ID);

      expect(pipeline.expire).toHaveBeenCalledWith(SOCKET_KEY, 3600);
      expect(pipeline.expire).toHaveBeenCalledWith(USER_SOCKETS_KEY, 3600);
      expect(pipeline.expire).toHaveBeenCalledWith(ONLINE_KEY, 7200);
    });

    it('Redis 오류는 삼키고 첫 입장으로 취급해야 함', async () => {
      redis.scard.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.addUserToOnline(MAP_ID, USER_ID, '낚시왕', SOCKET_ID),
      ).resolves.toEqual({ wasAlreadyOnline: false });
    });
  });

  describe('removeSocket', () => {
    const mapping = { mapId: MAP_ID, userId: String(USER_ID), userName: '낚시왕' };

    it('등록되지 않은 소켓이면 null을 반환해야 함', async () => {
      redis.hgetall.mockResolvedValue({});

      await expect(service.removeSocket(SOCKET_ID)).resolves.toBeNull();
      expect(pipeline.exec).not.toHaveBeenCalled();
    });

    it('마지막 연결이면 위치·낚시상태까지 함께 지워야 함', async () => {
      redis.hgetall.mockResolvedValue(mapping);
      redis.scard.mockResolvedValue(0);

      await expect(service.removeSocket(SOCKET_ID)).resolves.toEqual({
        mapId: MAP_ID,
        userId: USER_ID,
        userName: '낚시왕',
        isFullyOffline: true,
      });
      // 위치를 남기면 접속하지 않은 유령 캐릭터가 맵에 계속 서 있게 된다
      expect(pipeline.hdel).toHaveBeenCalledWith(ONLINE_KEY, String(USER_ID));
      expect(pipeline.hdel).toHaveBeenCalledWith(POSITIONS_KEY, String(USER_ID));
      expect(pipeline.hdel).toHaveBeenCalledWith(STATES_KEY, String(USER_ID));
      expect(pipeline.del).toHaveBeenCalledWith(USER_SOCKETS_KEY);
    });

    it('다른 탭이 남아 있으면 위치를 지우지 않아야 함', async () => {
      redis.hgetall.mockResolvedValue(mapping);
      redis.scard.mockResolvedValue(1);

      await expect(service.removeSocket(SOCKET_ID)).resolves.toMatchObject({
        isFullyOffline: false,
      });
      expect(pipeline.hdel).not.toHaveBeenCalled();
    });

    it('mapId는 문자열, userId는 숫자로 돌려줘야 함', async () => {
      redis.hgetall.mockResolvedValue(mapping);
      redis.scard.mockResolvedValue(0);

      const result = await service.removeSocket(SOCKET_ID);

      // mapId는 room 이름에, userId는 페이로드에 쓰인다 — 타입이 어긋나면 둘 다 깨진다
      expect(result?.mapId).toBe(MAP_ID);
      expect(result?.userId).toBe(USER_ID);
    });

    it('Redis 오류는 삼키고 null을 반환해야 함', async () => {
      redis.hgetall.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.removeSocket(SOCKET_ID)).resolves.toBeNull();
    });
  });

  describe('getOnlineUsersForMap — 파이프라인 인덱스 매핑', () => {
    it('아무도 없으면 빈 배열을 반환하고 파이프라인을 열지 않아야 함', async () => {
      redis.hgetall.mockResolvedValue({});

      await expect(service.getOnlineUsersForMap(MAP_ID)).resolves.toEqual([]);
      expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it('유저별 접속수·위치·낚시상태를 각자에게 맞게 매핑해야 함', async () => {
      redis.hgetall.mockResolvedValue({ '1': '김일', '2': '이이' });
      // 유저당 3개(scard, hget position, hget state)가 순서대로 쌓인다
      execResults.push([
        [null, 2],
        [null, JSON.stringify({ x: 10, y: 20, direction: 'left' })],
        [null, 'idle'],
        [null, 1],
        [null, JSON.stringify({ x: 30, y: 40, direction: 'right' })],
        [null, 'fishing'],
      ]);

      // i*3 오프셋이 어긋나면 김일의 화면에 이이의 위치가 그려진다
      await expect(service.getOnlineUsersForMap(MAP_ID)).resolves.toEqual([
        {
          userId: 1,
          userName: '김일',
          connectionCount: 2,
          position: { x: 10, y: 20, direction: 'left' },
          fishingState: 'idle',
        },
        {
          userId: 2,
          userName: '이이',
          connectionCount: 1,
          position: { x: 30, y: 40, direction: 'right' },
          fishingState: 'fishing',
        },
      ]);
    });

    it('위치·상태가 없는 유저는 undefined로 남겨야 함', async () => {
      redis.hgetall.mockResolvedValue({ '1': '김일' });
      execResults.push([
        [null, 1],
        [null, null],
        [null, null],
      ]);

      await expect(service.getOnlineUsersForMap(MAP_ID)).resolves.toEqual([
        { userId: 1, userName: '김일', connectionCount: 1, position: undefined, fishingState: undefined },
      ]);
    });

    it('위치 JSON이 깨져 있어도 나머지 유저를 반환해야 함', async () => {
      redis.hgetall.mockResolvedValue({ '1': '김일', '2': '이이' });
      execResults.push([
        [null, 1],
        [null, '{깨진 JSON'],
        [null, 'idle'],
        [null, 1],
        [null, JSON.stringify(POSITION)],
        [null, 'fishing'],
      ]);

      const result = await service.getOnlineUsersForMap(MAP_ID);

      // 한 명의 데이터 손상이 맵 전체 목록을 날리면 안 된다
      expect(result).toHaveLength(2);
      expect(result[0].position).toBeUndefined();
      expect(result[1].position).toEqual(POSITION);
    });

    it('접속 수 조회가 비면 0으로 채워야 함', async () => {
      redis.hgetall.mockResolvedValue({ '1': '김일' });
      execResults.push([]);

      await expect(service.getOnlineUsersForMap(MAP_ID)).resolves.toMatchObject([
        { connectionCount: 0 },
      ]);
    });

    it('50명을 초과하면 잘라내야 함', async () => {
      const many = Object.fromEntries(
        Array.from({ length: 80 }, (_, i) => [String(i + 1), `유저${i + 1}`]),
      );
      redis.hgetall.mockResolvedValue(many);
      execResults.push(Array.from({ length: 240 }, () => [null, 1]));

      const result = await service.getOnlineUsersForMap(MAP_ID);

      expect(result).toHaveLength(50);
      // 잘라낸 만큼만 조회해야 한다 (유저당 scard 1회)
      expect(pipeline.scard).toHaveBeenCalledTimes(50);
    });

    it('Redis 오류는 삼키고 빈 배열을 반환해야 함', async () => {
      redis.hgetall.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.getOnlineUsersForMap(MAP_ID)).resolves.toEqual([]);
    });
  });

  describe('getAllPositions', () => {
    it('위치가 있는 유저만 이름·낚시상태와 함께 반환해야 함', async () => {
      redis.hgetall
        .mockResolvedValueOnce({ '1': JSON.stringify(POSITION) }) // positions
        .mockResolvedValueOnce({ '1': '김일', '2': '이이' }) // online (2는 위치 없음)
        .mockResolvedValueOnce({ '1': 'fishing' }); // states

      await expect(service.getAllPositions(MAP_ID)).resolves.toEqual({
        1: { ...POSITION, userName: '김일', fishingState: 'fishing' },
      });
    });

    it('이름이 없으면 유저ID 기반 기본값을 써야 함', async () => {
      redis.hgetall
        .mockResolvedValueOnce({ '9': JSON.stringify(POSITION) })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await expect(service.getAllPositions(MAP_ID)).resolves.toEqual({
        9: { ...POSITION, userName: '유저9', fishingState: undefined },
      });
    });

    it('깨진 위치 JSON은 건너뛰고 나머지를 반환해야 함', async () => {
      redis.hgetall
        .mockResolvedValueOnce({ '1': '{깨짐', '2': JSON.stringify(POSITION) })
        .mockResolvedValueOnce({ '1': '김일', '2': '이이' })
        .mockResolvedValueOnce({});

      const result = await service.getAllPositions(MAP_ID);

      expect(result[1]).toBeUndefined();
      expect(result[2]).toMatchObject({ userName: '이이' });
    });

    it('Redis 오류는 삼키고 빈 객체를 반환해야 함', async () => {
      redis.hgetall.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.getAllPositions(MAP_ID)).resolves.toEqual({});
    });
  });

  describe('위치·낚시 상태 갱신 (fire-and-forget)', () => {
    it('위치를 JSON으로 직렬화해 저장하고 TTL을 갱신해야 함', async () => {
      await service.updatePosition(MAP_ID, USER_ID, POSITION);

      expect(pipeline.hset).toHaveBeenCalledWith(
        POSITIONS_KEY,
        String(USER_ID),
        JSON.stringify(POSITION),
      );
      expect(pipeline.expire).toHaveBeenCalledWith(POSITIONS_KEY, 7200);
    });

    it('낚시 상태를 그대로 저장하고 TTL을 갱신해야 함', async () => {
      await service.updateFishingState(MAP_ID, USER_ID, 'fishing');

      expect(pipeline.hset).toHaveBeenCalledWith(STATES_KEY, String(USER_ID), 'fishing');
      expect(pipeline.expire).toHaveBeenCalledWith(STATES_KEY, 7200);
    });

    it.each([
      ['updatePosition', () => service.updatePosition(MAP_ID, USER_ID, POSITION)],
      ['updateFishingState', () => service.updateFishingState(MAP_ID, USER_ID, 'idle')],
    ])('%s는 Redis 응답을 기다리지 않아야 함', async (_name, run) => {
      // 이동은 초당 여러 번 들어온다 — 쓰기를 기다리면 브로드캐스트가 지연된다
      pipeline.exec.mockReturnValue(new Promise(() => {}));

      await expect(run()).resolves.toBeUndefined();
      expect(pipeline.exec).toHaveBeenCalled();
    });

    it.each([
      ['updatePosition', () => service.updatePosition(MAP_ID, USER_ID, POSITION)],
      ['updateFishingState', () => service.updateFishingState(MAP_ID, USER_ID, 'idle')],
    ])('%s는 Redis 오류를 삼켜야 함', async (_name, run) => {
      redis.pipeline.mockImplementation(() => {
        throw new Error('ECONNREFUSED');
      });

      await expect(run()).resolves.toBeUndefined();
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });

  describe('단순 조회', () => {
    it('온라인 유저 수는 맵 해시 크기여야 함', async () => {
      redis.hlen.mockResolvedValue(7);

      await expect(service.getOnlineUsersCount(MAP_ID)).resolves.toBe(7);
      expect(redis.hlen).toHaveBeenCalledWith(ONLINE_KEY);
    });

    it.each([
      ['존재하면 true', 1, true],
      ['없으면 false', 0, false],
    ])('소켓 등록 여부는 %s여야 함', async (_desc, exists, expected) => {
      redis.exists.mockResolvedValue(exists);

      await expect(service.isSocketRegistered(SOCKET_ID)).resolves.toBe(expected);
      expect(redis.exists).toHaveBeenCalledWith(SOCKET_KEY);
    });

    it('소켓 매핑이 없으면 null을 반환해야 함', async () => {
      redis.hgetall.mockResolvedValue({});

      await expect(service.getSocketMapping(SOCKET_ID)).resolves.toBeNull();
    });

    it('소켓 매핑의 userId를 숫자로 변환해 반환해야 함', async () => {
      redis.hgetall.mockResolvedValue({
        mapId: MAP_ID,
        userId: String(USER_ID),
        userName: '낚시왕',
      });

      await expect(service.getSocketMapping(SOCKET_ID)).resolves.toEqual({
        mapId: MAP_ID,
        userId: USER_ID,
        userName: '낚시왕',
      });
    });

    it.each([
      ['getOnlineUsersCount', () => service.getOnlineUsersCount(MAP_ID), 0],
      ['isSocketRegistered', () => service.isSocketRegistered(SOCKET_ID), false],
      ['getSocketMapping', () => service.getSocketMapping(SOCKET_ID), null],
    ])('%s는 Redis 오류 시 안전한 기본값을 반환해야 함', async (_name, run, fallback) => {
      redis.hlen.mockRejectedValue(new Error('ECONNREFUSED'));
      redis.exists.mockRejectedValue(new Error('ECONNREFUSED'));
      redis.hgetall.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(run()).resolves.toBe(fallback);
    });

    it('Redis 클라이언트가 주입되지 않아도 앱이 죽지 않아야 함', async () => {
      const noRedis = await buildService();

      await expect(noRedis.getOnlineUsersCount(MAP_ID)).resolves.toBe(0);
      await expect(noRedis.getAllPositions(MAP_ID)).resolves.toEqual({});
    });
  });
});

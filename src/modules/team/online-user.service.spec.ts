import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getToken } from '@willsoto/nestjs-prometheus';
import type { Redis } from 'ioredis';
import { OnlineUserService } from './online-user.service';

const TEAM_ID = 7;
const USER_ID = 42;
const SOCKET_ID = 'socket-abc';

const SOCKET_KEY = `socket:${SOCKET_ID}`;
const USER_SOCKETS_KEY = `team:${TEAM_ID}:user:${USER_ID}:sockets`;
const TEAM_ONLINE_KEY = `team:${TEAM_ID}:online`;

/**
 * 멀티 레플리카 프레즌스의 진실 공급원(Redis)을 다루는 서비스.
 *
 * TeamGateway spec은 `wasAlreadyOnline`·`isFullyOffline`을 mock으로 가정했으므로,
 * **그 값을 실제로 계산하는 로직은 여기서만 검증된다.** 두 판정이 틀리면
 * 다중 탭 사용자에게 입퇴장 알림이 중복되거나(오탐) 아예 누락된다(미탐).
 *
 * 또 하나의 축은 **장애 격리**다. 이 서비스는 모든 Redis 오류를 삼키고 안전한 기본값을
 * 돌려준다 — Redis가 죽어도 HTTP는 정상 동작해야 한다는 설계 결정(WS 프레즌스만 중단)을
 * 지키기 위해서다. 그래서 "실패 시 무엇을 반환하는가"를 메서드마다 고정한다.
 */
describe('OnlineUserService', () => {
  let service: OnlineUserService;
  let redis: {
    scard: jest.Mock;
    hget: jest.Mock;
    hgetall: jest.Mock;
    hlen: jest.Mock;
    hdel: jest.Mock;
    del: jest.Mock;
    exists: jest.Mock;
    pipeline: jest.Mock;
  };
  let pipeline: Record<string, jest.Mock>;
  let gauge: { set: jest.Mock; remove: jest.Mock };
  let originalTaskSlot: string | undefined;

  /**
   * TASK_SLOT은 생성자에서 읽으므로 조합마다 인스턴스를 새로 만들어야 검증된다.
   * (scheduler.service.spec.ts와 동일한 이유)
   */
  const buildService = async (taskSlot?: string): Promise<OnlineUserService> => {
    if (taskSlot === undefined) delete process.env.TASK_SLOT;
    else process.env.TASK_SLOT = taskSlot;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnlineUserService,
        { provide: getToken('ws_team_online_users'), useValue: gauge },
      ],
    }).compile();

    const built = module.get(OnlineUserService);
    // 생성자의 "갱신 활성" 로그가 spy에 잡히므로 케이스 검증 전에 비운다
    (Logger.prototype.log as jest.Mock).mockClear();
    return built;
  };

  beforeEach(async () => {
    originalTaskSlot = process.env.TASK_SLOT;

    pipeline = {
      hset: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      sadd: jest.fn().mockReturnThis(),
      srem: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      scard: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    redis = {
      scard: jest.fn().mockResolvedValue(0),
      hget: jest.fn().mockResolvedValue(null),
      hgetall: jest.fn().mockResolvedValue({}),
      hlen: jest.fn().mockResolvedValue(0),
      hdel: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(0),
      pipeline: jest.fn(() => pipeline),
    };
    gauge = { set: jest.fn(), remove: jest.fn() };

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    service = await buildService();
    service.setRedisClient(redis as unknown as Redis);
  });

  afterEach(() => {
    service.onModuleDestroy();
    if (originalTaskSlot === undefined) delete process.env.TASK_SLOT;
    else process.env.TASK_SLOT = originalTaskSlot;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('addUserToOnline — 다중 탭 판정', () => {
    it.each([
      ['기존 소켓이 없으면', 0, false],
      ['기존 소켓이 1개면', 1, true],
      ['기존 소켓이 여러 개면', 3, true],
    ])('%s wasAlreadyOnline=%s여야 함', async (_desc, existing, expected) => {
      redis.scard.mockResolvedValue(existing);

      await expect(
        service.addUserToOnline(TEAM_ID, USER_ID, '홍길동', SOCKET_ID),
      ).resolves.toEqual({ wasAlreadyOnline: expected });
    });

    it('판정은 소켓을 추가하기 전의 개수로 해야 함', async () => {
      redis.scard.mockResolvedValue(0);

      await service.addUserToOnline(TEAM_ID, USER_ID, '홍길동', SOCKET_ID);

      // 추가 후에 세면 항상 1 이상이 되어 첫 입장 알림이 영영 안 나간다
      expect(redis.scard).toHaveBeenCalledWith(USER_SOCKETS_KEY);
      expect(redis.scard.mock.invocationCallOrder[0]).toBeLessThan(
        pipeline.sadd.mock.invocationCallOrder[0],
      );
    });

    it('세 종류의 키를 한 파이프라인으로 기록해야 함', async () => {
      await service.addUserToOnline(TEAM_ID, USER_ID, '홍길동', SOCKET_ID);

      // 소켓 → 유저 역방향 매핑 (disconnect 때 유일한 단서)
      expect(pipeline.hset).toHaveBeenCalledWith(SOCKET_KEY, {
        teamId: String(TEAM_ID),
        userId: String(USER_ID),
        userName: '홍길동',
      });
      // 유저별 소켓 목록 (다중 탭 카운트)
      expect(pipeline.sadd).toHaveBeenCalledWith(USER_SOCKETS_KEY, SOCKET_ID);
      // 팀 온라인 해시 (목록 조회용)
      expect(pipeline.hset).toHaveBeenCalledWith(TEAM_ONLINE_KEY, String(USER_ID), '홍길동');
      expect(pipeline.exec).toHaveBeenCalledTimes(1);
    });

    it('모든 키에 TTL을 걸어야 함 (고아 데이터 자동 정리)', async () => {
      await service.addUserToOnline(TEAM_ID, USER_ID, '홍길동', SOCKET_ID);

      // TTL이 없으면 서버가 비정상 종료됐을 때 유령 접속자가 영구히 남는다
      expect(pipeline.expire).toHaveBeenCalledWith(SOCKET_KEY, 3600);
      expect(pipeline.expire).toHaveBeenCalledWith(USER_SOCKETS_KEY, 3600);
      expect(pipeline.expire).toHaveBeenCalledWith(TEAM_ONLINE_KEY, 7200);
    });

    it('Redis 오류는 삼키고 첫 입장으로 취급해야 함', async () => {
      redis.scard.mockRejectedValue(new Error('ECONNREFUSED'));

      // 예외가 올라가면 joinTeam 전체가 실패해 팀 입장 자체가 막힌다
      await expect(
        service.addUserToOnline(TEAM_ID, USER_ID, '홍길동', SOCKET_ID),
      ).resolves.toEqual({ wasAlreadyOnline: false });
      expect(Logger.prototype.error).toHaveBeenCalled();
    });

    it('Redis 클라이언트가 주입되지 않아도 앱이 죽지 않아야 함', async () => {
      const noRedis = await buildService();

      await expect(
        noRedis.addUserToOnline(TEAM_ID, USER_ID, '홍길동', SOCKET_ID),
      ).resolves.toEqual({ wasAlreadyOnline: false });
    });
  });

  describe('removeSocket — 완전 오프라인 판정', () => {
    const mapping = {
      teamId: String(TEAM_ID),
      userId: String(USER_ID),
      userName: '홍길동',
    };

    it('등록되지 않은 소켓이면 null을 반환해야 함', async () => {
      redis.hgetall.mockResolvedValue({});

      await expect(service.removeSocket(SOCKET_ID)).resolves.toBeNull();
      expect(pipeline.exec).not.toHaveBeenCalled();
    });

    it('소켓 매핑과 유저 소켓 목록에서 함께 제거해야 함', async () => {
      redis.hgetall.mockResolvedValue(mapping);
      redis.scard.mockResolvedValue(1);

      await service.removeSocket(SOCKET_ID);

      expect(pipeline.del).toHaveBeenCalledWith(SOCKET_KEY);
      expect(pipeline.srem).toHaveBeenCalledWith(USER_SOCKETS_KEY, SOCKET_ID);
    });

    it('남은 소켓이 없으면 온라인 목록에서도 지워야 함', async () => {
      redis.hgetall.mockResolvedValue(mapping);
      redis.scard.mockResolvedValue(0);

      await expect(service.removeSocket(SOCKET_ID)).resolves.toEqual({
        teamId: TEAM_ID,
        userId: USER_ID,
        userName: '홍길동',
        isFullyOffline: true,
      });
      expect(redis.hdel).toHaveBeenCalledWith(TEAM_ONLINE_KEY, String(USER_ID));
      expect(redis.del).toHaveBeenCalledWith(USER_SOCKETS_KEY);
    });

    it('다른 탭이 남아 있으면 온라인 목록을 건드리지 않아야 함', async () => {
      redis.hgetall.mockResolvedValue(mapping);
      redis.scard.mockResolvedValue(2);

      await expect(service.removeSocket(SOCKET_ID)).resolves.toMatchObject({
        isFullyOffline: false,
      });
      // 지워버리면 아직 접속 중인 탭이 있는데도 오프라인으로 표시된다
      expect(redis.hdel).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('문자열로 저장된 ID를 숫자로 되돌려야 함', async () => {
      redis.hgetall.mockResolvedValue(mapping);
      redis.scard.mockResolvedValue(0);

      const result = await service.removeSocket(SOCKET_ID);

      // Redis Hash는 값을 전부 문자열로 돌려준다 — 호출부가 teamId를 room 이름에 쓰므로
      // 문자열이 새어나가면 room 계산이 어긋난다
      expect(result?.teamId).toBe(TEAM_ID);
      expect(result?.userId).toBe(USER_ID);
    });

    it('Redis 오류는 삼키고 null을 반환해야 함', async () => {
      redis.hgetall.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.removeSocket(SOCKET_ID)).resolves.toBeNull();
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });

  describe('getUserOnlineInfo', () => {
    it('온라인 목록에 없으면 null을 반환해야 함', async () => {
      redis.hget.mockResolvedValue(null);

      await expect(service.getUserOnlineInfo(TEAM_ID, USER_ID)).resolves.toBeNull();
      // 이름이 없으면 접속 수를 셀 필요도 없다
      expect(redis.scard).not.toHaveBeenCalled();
    });

    it('온라인이면 이름과 접속 수를 반환해야 함', async () => {
      redis.hget.mockResolvedValue('홍길동');
      redis.scard.mockResolvedValue(3);

      await expect(service.getUserOnlineInfo(TEAM_ID, USER_ID)).resolves.toEqual({
        userId: USER_ID,
        userName: '홍길동',
        connectionCount: 3,
      });
      expect(redis.hget).toHaveBeenCalledWith(TEAM_ONLINE_KEY, String(USER_ID));
    });

    it('Redis 오류는 삼키고 null을 반환해야 함', async () => {
      redis.hget.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.getUserOnlineInfo(TEAM_ID, USER_ID)).resolves.toBeNull();
    });
  });

  describe('getOnlineUsersForTeam', () => {
    it('아무도 없으면 빈 배열을 반환하고 파이프라인을 열지 않아야 함', async () => {
      redis.hgetall.mockResolvedValue({});

      await expect(service.getOnlineUsersForTeam(TEAM_ID)).resolves.toEqual([]);
      expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it('유저별 접속 수를 파이프라인 결과 순서대로 매핑해야 함', async () => {
      redis.hgetall.mockResolvedValue({ '1': '김일', '2': '이이' });
      pipeline.exec.mockResolvedValue([
        [null, 2],
        [null, 1],
      ]);

      await expect(service.getOnlineUsersForTeam(TEAM_ID)).resolves.toEqual([
        { userId: 1, userName: '김일', connectionCount: 2 },
        { userId: 2, userName: '이이', connectionCount: 1 },
      ]);
    });

    it('접속 수 조회가 비면 0으로 채워야 함', async () => {
      redis.hgetall.mockResolvedValue({ '1': '김일' });
      pipeline.exec.mockResolvedValue(null);

      await expect(service.getOnlineUsersForTeam(TEAM_ID)).resolves.toEqual([
        { userId: 1, userName: '김일', connectionCount: 0 },
      ]);
    });

    it('100명을 초과하면 잘라내야 함 (페이로드 무한 증가 방지)', async () => {
      const many = Object.fromEntries(
        Array.from({ length: 150 }, (_, i) => [String(i + 1), `유저${i + 1}`]),
      );
      redis.hgetall.mockResolvedValue(many);
      pipeline.exec.mockResolvedValue(Array.from({ length: 150 }, () => [null, 1]));

      const result = await service.getOnlineUsersForTeam(TEAM_ID);

      expect(result).toHaveLength(100);
      // 잘라낸 만큼만 조회해야 한다 — 전원 조회하면 큰 팀에서 Redis 왕복이 낭비된다
      expect(pipeline.scard).toHaveBeenCalledTimes(100);
    });

    it('Redis 오류는 삼키고 빈 배열을 반환해야 함', async () => {
      redis.hgetall.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.getOnlineUsersForTeam(TEAM_ID)).resolves.toEqual([]);
    });
  });

  describe('단순 조회', () => {
    it('온라인 유저 수는 팀 해시 크기여야 함', async () => {
      redis.hlen.mockResolvedValue(5);

      await expect(service.getOnlineUsersCount(TEAM_ID)).resolves.toBe(5);
      expect(redis.hlen).toHaveBeenCalledWith(TEAM_ONLINE_KEY);
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

      await expect(service.getSocketUserMapping(SOCKET_ID)).resolves.toBeNull();
    });

    it('소켓 매핑도 숫자로 변환해 반환해야 함', async () => {
      redis.hgetall.mockResolvedValue({
        teamId: String(TEAM_ID),
        userId: String(USER_ID),
        userName: '홍길동',
      });

      await expect(service.getSocketUserMapping(SOCKET_ID)).resolves.toEqual({
        teamId: TEAM_ID,
        userId: USER_ID,
        userName: '홍길동',
      });
    });

    it.each([
      ['getOnlineUsersCount', () => service.getOnlineUsersCount(TEAM_ID), 0],
      ['isSocketRegistered', () => service.isSocketRegistered(SOCKET_ID), false],
      ['getSocketUserMapping', () => service.getSocketUserMapping(SOCKET_ID), null],
    ])('%s는 Redis 오류 시 안전한 기본값을 반환해야 함', async (_name, run, fallback) => {
      redis.hlen.mockRejectedValue(new Error('ECONNREFUSED'));
      redis.exists.mockRejectedValue(new Error('ECONNREFUSED'));
      redis.hgetall.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(run()).resolves.toBe(fallback);
    });
  });

  describe('팀별 온라인 Gauge 갱신', () => {
    /** private 메서드 — 타이머로만 호출되므로 로직 검증은 직접 호출한다 */
    const refresh = (target: OnlineUserService = service) =>
      (target as unknown as { refreshTeamOnlineMetric: () => Promise<void> })
        .refreshTeamOnlineMetric();

    it('접속자가 있으면 팀 라벨로 값을 기록해야 함', async () => {
      service.trackActiveTeam(TEAM_ID);
      redis.hlen.mockResolvedValue(3);

      await refresh();

      expect(gauge.set).toHaveBeenCalledWith({ team_id: String(TEAM_ID) }, 3);
    });

    it('0명이 되면 라벨을 제거하고 추적 대상에서 빼야 함', async () => {
      service.trackActiveTeam(TEAM_ID);
      redis.hlen.mockResolvedValue(0);

      await refresh();

      // 남겨두면 아무도 없는 팀이 계속 0으로 노출되어 stale label이 쌓인다
      expect(gauge.remove).toHaveBeenCalledWith({ team_id: String(TEAM_ID) });

      // 추적에서 빠졌으므로 다음 주기에는 조회조차 하지 않는다
      redis.hlen.mockClear();
      await refresh();
      expect(redis.hlen).not.toHaveBeenCalled();
    });

    it('Redis 조회가 실패하면 이번 주기를 건너뛰어야 함 (실패와 0명을 구분)', async () => {
      service.trackActiveTeam(TEAM_ID);
      redis.hlen.mockRejectedValue(new Error('ECONNREFUSED'));

      await refresh();

      // 실패를 0으로 취급해 remove하면 장애 중에 지표가 사라져 대시보드가 빈다
      expect(gauge.set).not.toHaveBeenCalled();
      expect(gauge.remove).not.toHaveBeenCalled();

      // 추적 대상으로 남아 다음 주기에 다시 시도한다
      redis.hlen.mockResolvedValue(2);
      await refresh();
      expect(gauge.set).toHaveBeenCalledWith({ team_id: String(TEAM_ID) }, 2);
    });

    it('한 팀이 실패해도 다른 팀은 갱신해야 함', async () => {
      service.trackActiveTeam(1);
      service.trackActiveTeam(2);
      redis.hlen.mockImplementation(async (key: string) => {
        if (key === 'team:1:online') throw new Error('ECONNREFUSED');
        return 4;
      });

      await refresh();

      expect(gauge.set).toHaveBeenCalledTimes(1);
      expect(gauge.set).toHaveBeenCalledWith({ team_id: '2' }, 4);
    });

    it('Redis 클라이언트가 없으면 아무것도 하지 않아야 함', async () => {
      const noRedis = await buildService();
      noRedis.trackActiveTeam(TEAM_ID);

      await refresh(noRedis);

      expect(gauge.set).not.toHaveBeenCalled();
      expect(gauge.remove).not.toHaveBeenCalled();
    });
  });

  describe('갱신 타이머 (멀티 레플리카 중복 방지)', () => {
    afterEach(() => jest.useRealTimers());

    it('TASK_SLOT=1 레플리카만 주기 갱신을 등록해야 함', async () => {
      jest.useFakeTimers();
      const leader = await buildService('1');
      leader.setRedisClient(redis as unknown as Redis);
      leader.trackActiveTeam(TEAM_ID);
      redis.hlen.mockResolvedValue(2);

      jest.advanceTimersByTime(60_000);
      await Promise.resolve();

      expect(redis.hlen).toHaveBeenCalledWith(TEAM_ONLINE_KEY);
      leader.onModuleDestroy();
    });

    it.each([
      ['미설정', undefined],
      ['0', '0'],
      ['2', '2'],
    ])('TASK_SLOT=%s면 갱신을 등록하지 않아야 함', async (_desc, slot) => {
      jest.useFakeTimers();
      const follower = await buildService(slot);
      follower.setRedisClient(redis as unknown as Redis);
      follower.trackActiveTeam(TEAM_ID);

      jest.advanceTimersByTime(60_000);
      await Promise.resolve();

      // 여러 레플리카가 같은 team_id를 set하면 Prometheus에 중복 timeseries가 생긴다
      expect(redis.hlen).not.toHaveBeenCalled();
      follower.onModuleDestroy();
    });

    it('종료 시 타이머를 정리해야 함', async () => {
      jest.useFakeTimers();
      const leader = await buildService('1');
      leader.setRedisClient(redis as unknown as Redis);
      leader.trackActiveTeam(TEAM_ID);

      leader.onModuleDestroy();
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();

      // 정리하지 않으면 테스트·핫리로드 환경에서 타이머가 누적된다
      expect(redis.hlen).not.toHaveBeenCalled();
    });

    it('종료를 두 번 호출해도 안전해야 함', async () => {
      const leader = await buildService('1');

      expect(() => {
        leader.onModuleDestroy();
        leader.onModuleDestroy();
      }).not.toThrow();
    });
  });
});

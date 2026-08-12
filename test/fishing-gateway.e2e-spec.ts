import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { sign } from 'jsonwebtoken';
import { FishingGateway } from '../src/modules/fishing/fishing.gateway';
import { FishingOnlineService } from '../src/modules/fishing/fishing-online.service';
import { FishingSocketEvents } from '../src/modules/fishing/fishing.events';
import { User } from '../src/entities/User';
import { createUser } from '../src/entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createWsApp, WsE2eApp, waitFor, expectNoEvent, emitWithAck } from './helpers/ws-e2e-app';

const JWT_SECRET = 'e2e-ws-secret';
const MAP_A = 'lake-1';
const MAP_B = 'lake-2';
const USER = createUser({ userId: 42, userName: '낚시왕' });

const MOVE = { x: 100, y: 200, direction: 'left' as const };

/**
 * `/fishing` 게이트웨이를 실제 소켓으로 검증한다. `/teams`와 정반대의 정책이 핵심이다 —
 * **게스트도 그냥 붙어서 논다.** 토큰이 없거나 잘못돼도 거부하지 않고 게스트로 강등한다.
 *
 * 단위 테스트(54케이스)가 못 보는 두 가지를 노린다:
 *
 *  1. **게스트 강등이 실제 소켓에서 일어나는가** — 가드가 토큰 실패를 삼키고 음수 guestId를
 *     부여하는 전 과정. 음수인 이유는 실제 userId(양수)와 절대 충돌하지 않기 위해서다.
 *  2. **emit 대상이 실제로 다른가** — 이동은 `client.to`(본인 제외), 채팅은 `server.to`
 *     (본인 포함)로 **의도적으로 갈라져 있다.** mock은 어느 메서드를 불렀는지만 알지만
 *     여기서는 "본인에게 왔는가/안 왔는가"를 직접 본다.
 */
describe('E2E WS 낚시 게이트웨이', () => {
  let ws: WsE2eApp;
  let fishingOnlineService: Record<string, jest.Mock>;
  let userRepository: MockRepository<User>;

  const connectTo = async (map: string, opts: { token?: string } = {}) => {
    const socket = await ws.connect({ ...opts, namespace: '/fishing' });
    await emitWithAck(socket, FishingSocketEvents.JOIN_MAP, { mapId: map });
    return socket;
  };

  beforeEach(async () => {
    userRepository = createMockRepository<User>();
    userRepository.findOne.mockImplementation(async (options) => {
      const where = (options as { where: { userId: number } }).where;
      return where.userId === USER.userId ? USER : null;
    });

    fishingOnlineService = {
      addUserToOnline: jest.fn().mockResolvedValue({ wasAlreadyOnline: false }),
      removeSocket: jest.fn().mockResolvedValue(null),
      getOnlineUsersForMap: jest.fn().mockResolvedValue([]),
      getAllPositions: jest.fn().mockResolvedValue({}),
      isSocketRegistered: jest.fn().mockResolvedValue(false),
      updatePosition: jest.fn().mockResolvedValue(undefined),
      updateFishingState: jest.fn().mockResolvedValue(undefined),
    };

    ws = await createWsApp({
      gateways: [FishingGateway],
      providers: [
        { provide: FishingOnlineService, useValue: fishingOnlineService },
        { provide: getRepositoryToken(User), useValue: userRepository },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((k: string) => (k === 'JWT_SECRET' ? JWT_SECRET : undefined)) },
        },
      ],
    });
  });

  afterEach(async () => {
    await ws.close();
  });

  describe('게스트 허용 (팀과 정반대 정책)', () => {
    it('토큰 없이도 맵에 참가할 수 있어야 함', async () => {
      const socket = await ws.connect({ namespace: '/fishing' });

      const ack = await emitWithAck<{ mapId: string; room: string }>(
        socket,
        FishingSocketEvents.JOIN_MAP,
        { mapId: MAP_A },
      );

      // 팀은 인증 없으면 AUTH_UNAUTHORIZED로 막지만, 낚시 맵은 공개다
      expect(ack).toEqual({ mapId: MAP_A, room: `fishing-map-${MAP_A}` });
    });

    it('잘못된 토큰이어도 거부하지 않고 게스트로 강등해야 함', async () => {
      const socket = await ws.connect({ token: 'forged.token', namespace: '/fishing' });

      await expect(
        emitWithAck(socket, FishingSocketEvents.JOIN_MAP, { mapId: MAP_A }),
      ).resolves.toBeDefined();
    });

    it('게스트에게는 실제 userId와 충돌하지 않는 음수 ID를 줘야 함', async () => {
      await connectTo(MAP_A);

      const [, userId, userName] = fishingOnlineService.addUserToOnline.mock.calls[0];
      // 양수면 실제 회원 ID와 겹쳐 남의 캐릭터를 덮어쓸 수 있다
      expect(userId).toBeLessThan(0);
      expect(typeof userName).toBe('string');
    });

    it('유효한 토큰이면 회원 정보로 등록해야 함', async () => {
      const token = sign({ sub: USER.userId, loginType: 'KAKAO' }, JWT_SECRET, { expiresIn: '1h' });

      await connectTo(MAP_A, { token });

      expect(fishingOnlineService.addUserToOnline).toHaveBeenCalledWith(
        MAP_A,
        USER.userId,
        '낚시왕',
        expect.any(String),
      );
    });

    it('참가하면 온라인 목록과 전체 위치를 함께 받아야 함', async () => {
      const socket = await ws.connect({ namespace: '/fishing' });

      const users = waitFor(socket, FishingSocketEvents.ONLINE_USERS);
      const positions = waitFor(socket, FishingSocketEvents.PLAYER_POSITIONS);
      socket.emit(FishingSocketEvents.JOIN_MAP, { mapId: MAP_A });

      // 목록만 오면 새 접속자 화면에 캐릭터가 안 그려진다
      await expect(users).resolves.toMatchObject({ mapId: MAP_A });
      await expect(positions).resolves.toHaveProperty('positions');
    });
  });

  /**
   * 이동은 `client.to`(본인 제외), 채팅은 `server.to`(본인 포함)로 갈라져 있다.
   * 단위 테스트는 어느 메서드를 불렀는지만 알지만, 여기서는 실제 도달 여부를 본다.
   */
  describe('emit 대상 — 본인 포함 여부', () => {
    it('이동은 본인에게 되돌아오지 않아야 함', async () => {
      const socket = await connectTo(MAP_A);

      socket.emit(FishingSocketEvents.MOVE, MOVE);

      // 본인 화면은 이미 자기 캐릭터를 그렸다 — 되돌아오면 위치가 튄다
      await expectNoEvent(socket, FishingSocketEvents.PLAYER_MOVED);
    });

    it('이동은 같은 맵의 다른 사람에게는 도달해야 함', async () => {
      const a = await connectTo(MAP_A);
      const b = await connectTo(MAP_A);

      const received = waitFor<{ x: number; y: number }>(b, FishingSocketEvents.PLAYER_MOVED);
      a.emit(FishingSocketEvents.MOVE, MOVE);

      await expect(received).resolves.toMatchObject({ x: 100, y: 200, direction: 'left' });
    });

    it('채팅은 본인에게도 도착해야 함', async () => {
      const socket = await connectTo(MAP_A);

      const received = waitFor<{ message: string }>(socket, FishingSocketEvents.CHAT_RECEIVED);
      socket.emit(FishingSocketEvents.CHAT_MESSAGE, { message: '안녕하세요' });

      await expect(received).resolves.toMatchObject({ message: '안녕하세요' });
    });

    it('낚시 결과는 본인 제외로 알려야 함', async () => {
      const a = await connectTo(MAP_A);
      const b = await connectTo(MAP_A);

      const received = waitFor<{ fishName: string }>(b, FishingSocketEvents.CATCH_NOTIFICATION);
      a.emit(FishingSocketEvents.CATCH_RESULT, {
        fishName: '붕어',
        grade: 'rare',
        size: 30,
        weight: 500,
      });

      await expect(received).resolves.toMatchObject({ fishName: '붕어' });
      // 본인은 이미 UI에서 결과를 봤다
      await expectNoEvent(a, FishingSocketEvents.CATCH_NOTIFICATION);
    });
  });

  describe('맵 격리', () => {
    it('다른 맵에는 이동이 새지 않아야 함', async () => {
      const a = await connectTo(MAP_A);
      const b = await connectTo(MAP_B);

      a.emit(FishingSocketEvents.MOVE, MOVE);

      await expectNoEvent(b, FishingSocketEvents.PLAYER_MOVED);
    });

    it('다른 맵에는 채팅이 새지 않아야 함', async () => {
      const a = await connectTo(MAP_A);
      const b = await connectTo(MAP_B);

      a.emit(FishingSocketEvents.CHAT_MESSAGE, { message: '여기만 보여야 함' });

      await expectNoEvent(b, FishingSocketEvents.CHAT_RECEIVED);
    });
  });

  describe('맵 미참가 상태', () => {
    it('참가 없이 이동하면 조용히 무시해야 함', async () => {
      const socket = await ws.connect({ namespace: '/fishing' });

      socket.emit(FishingSocketEvents.MOVE, MOVE);

      // 팀 채팅은 CHAT_NOT_JOINED로 알려주지만, 공개 맵은 차단이 아니라 무시가 정책이다
      await expectNoEvent(socket, FishingSocketEvents.ERROR);
      expect(fishingOnlineService.updatePosition).not.toHaveBeenCalled();
    });

    it('참가 없이 채팅해도 조용히 무시해야 함', async () => {
      const socket = await ws.connect({ namespace: '/fishing' });

      socket.emit(FishingSocketEvents.CHAT_MESSAGE, { message: '안녕' });

      await expectNoEvent(socket, FishingSocketEvents.CHAT_RECEIVED);
    });
  });

  describe('퇴장', () => {
    it('연결이 끊기면 온라인에서 제거해야 함', async () => {
      const socket = await connectTo(MAP_A);

      socket.disconnect();
      await new Promise((r) => setTimeout(r, 300));

      expect(fishingOnlineService.removeSocket).toHaveBeenCalled();
    });
  });
});

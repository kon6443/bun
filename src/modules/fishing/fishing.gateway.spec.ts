import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { FishingGateway } from './fishing.gateway';
import { FishingOnlineService } from './fishing-online.service';
import { FishingWsGuard, FishingSocket } from './fishing-ws.guard';
import { FishingSocketEvents } from './fishing.events';
import { createUser } from '../../entities/__spec__/entity.factory';

const MAP_ID = 'lake-1';
const ROOM = `fishing-map-${MAP_ID}`;
const USER_ID = 42;
const GUEST_ID = -17;
const SOCKET_ID = 'socket-abc';

/**
 * /fishing 네임스페이스. /teams와 완전히 독립이며 **게스트도 접속할 수 있다**는 것이
 * 가장 큰 차이다. 그래서 모든 핸들러가 `getClientInfo`로 "인증 유저 → 게스트 → 없음"
 * 순서를 거치고, 신원을 못 만들면 조용히 무시한다(팀 채팅처럼 에러를 던지지 않는다 —
 * 공개 맵이라 차단이 아니라 무시가 정책이다).
 *
 * 이동은 초당 여러 번 들어오는 고빈도 이벤트라 **브로드캐스트를 먼저 하고 Redis 저장은
 * fire-and-forget**으로 흘린다. 그 순서가 뒤집히면 Redis 지연이 곧 게임 렉이 된다.
 *
 * Socket.IO의 `client.to`(본인 제외)와 `server.to`(본인 포함)는 이벤트마다 의도가 다르다 —
 * 채팅만 본인 포함이고, 이동·낚시상태·낚시결과는 본인 제외다(본인 화면은 이미 그려져 있다).
 */
describe('FishingGateway', () => {
  let gateway: FishingGateway;
  let fishingOnlineService: {
    addUserToOnline: jest.Mock;
    removeSocket: jest.Mock;
    getOnlineUsersForMap: jest.Mock;
    getAllPositions: jest.Mock;
    isSocketRegistered: jest.Mock;
    updatePosition: jest.Mock;
    updateFishingState: jest.Mock;
  };
  /** client.to(room).emit — 본인 제외 */
  let clientRoomEmit: jest.Mock;
  /** server.to(room).emit — 본인 포함 */
  let serverRoomEmit: jest.Mock;

  /** 인증 유저 / 게스트 / 신원 없음 세 가지를 만든다 */
  const createClient = (
    kind: 'auth' | 'guest' | 'anonymous' = 'auth',
    { mapId }: { mapId?: string } = {},
  ) => {
    const data =
      kind === 'auth'
        ? { user: createUser({ userId: USER_ID, userName: '낚시왕' }), isAuthenticated: true }
        : kind === 'guest'
          ? { guestId: GUEST_ID, guestName: '게스트17', isAuthenticated: false }
          : { isAuthenticated: false };

    return {
      id: SOCKET_ID,
      data,
      _fishingMapId: mapId,
      join: jest.fn(),
      leave: jest.fn(),
      emit: jest.fn(),
      to: jest.fn(() => ({ emit: clientRoomEmit })),
    } as unknown as FishingSocket & {
      join: jest.Mock;
      leave: jest.Mock;
      emit: jest.Mock;
      to: jest.Mock;
    };
  };

  beforeEach(async () => {
    clientRoomEmit = jest.fn();
    serverRoomEmit = jest.fn();
    fishingOnlineService = {
      addUserToOnline: jest.fn().mockResolvedValue({ wasAlreadyOnline: false }),
      removeSocket: jest.fn().mockResolvedValue(null),
      getOnlineUsersForMap: jest.fn().mockResolvedValue([]),
      getAllPositions: jest.fn().mockResolvedValue({}),
      isSocketRegistered: jest.fn().mockResolvedValue(false),
      updatePosition: jest.fn().mockResolvedValue(undefined),
      updateFishingState: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FishingGateway,
        { provide: FishingOnlineService, useValue: fishingOnlineService },
      ],
    })
      // 핸들러를 직접 호출하므로 가드는 실행되지 않지만, @UseGuards가 붙어 있어
      // Nest가 FishingWsGuard의 의존성까지 해석하려 한다.
      // 가드 자체는 fishing-ws.guard.spec.ts에서 16케이스로 검증 완료.
      .overrideGuard(FishingWsGuard)
      .useValue({ canActivate: () => true })
      .compile();

    gateway = module.get(FishingGateway);
    gateway.server = {
      to: jest.fn(() => ({ emit: serverRoomEmit })),
    } as unknown as Server;

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('handleJoinMap', () => {
    it('맵 room에 참가시키고 결과를 반환해야 함', async () => {
      const client = createClient();

      await expect(gateway.handleJoinMap(client, { mapId: MAP_ID })).resolves.toEqual({
        mapId: MAP_ID,
        room: ROOM,
      });
      expect(client.join).toHaveBeenCalledWith(ROOM);
    });

    it('mapId를 소켓에 캐싱해야 함 (고빈도 이벤트에서 Redis 조회 생략)', async () => {
      const client = createClient();

      await gateway.handleJoinMap(client, { mapId: MAP_ID });

      expect(client._fishingMapId).toBe(MAP_ID);
    });

    it.each([
      ['인증 유저', 'auth' as const, USER_ID, '낚시왕'],
      ['게스트', 'guest' as const, GUEST_ID, '게스트17'],
    ])('%s는 온라인 목록에 등록해야 함', async (_desc, kind, userId, userName) => {
      const client = createClient(kind);

      await gateway.handleJoinMap(client, { mapId: MAP_ID });

      expect(fishingOnlineService.addUserToOnline).toHaveBeenCalledWith(
        MAP_ID,
        userId,
        userName,
        SOCKET_ID,
      );
    });

    it('이름 없는 인증 유저는 기본 표시명을 써야 함', async () => {
      const client = createClient();
      client.data.user = createUser({ userId: USER_ID, userName: null });

      await gateway.handleJoinMap(client, { mapId: MAP_ID });

      expect(fishingOnlineService.addUserToOnline).toHaveBeenCalledWith(
        MAP_ID,
        USER_ID,
        `사용자${USER_ID}`,
        SOCKET_ID,
      );
    });

    it('신원을 만들 수 없으면 room에는 넣되 온라인 등록은 하지 않아야 함', async () => {
      const client = createClient('anonymous');

      await expect(gateway.handleJoinMap(client, { mapId: MAP_ID })).resolves.toEqual({
        mapId: MAP_ID,
        room: ROOM,
      });
      expect(client.join).toHaveBeenCalledWith(ROOM);
      // 관전만 가능한 상태 — 목록에 없으니 다른 플레이어에게 보이지 않는다
      expect(fishingOnlineService.addUserToOnline).not.toHaveBeenCalled();
      expect(client.emit).not.toHaveBeenCalled();
    });

    it('첫 접속이면 본인을 제외한 맵 전체에 입장을 알려야 함', async () => {
      fishingOnlineService.addUserToOnline.mockResolvedValue({ wasAlreadyOnline: false });
      fishingOnlineService.getOnlineUsersForMap.mockResolvedValue([
        { userId: USER_ID, userName: '낚시왕', connectionCount: 1, position: { x: 1, y: 2, direction: 'left' } },
      ]);
      const client = createClient();

      await gateway.handleJoinMap(client, { mapId: MAP_ID });

      expect(client.to).toHaveBeenCalledWith(ROOM);
      expect(clientRoomEmit).toHaveBeenCalledWith(FishingSocketEvents.USER_JOINED, {
        userId: USER_ID,
        userName: '낚시왕',
        connectionCount: 1,
        totalOnlineCount: 1,
        position: { x: 1, y: 2, direction: 'left' },
      });
    });

    it('이미 온라인이면 입장 알림을 보내지 않아야 함 (다중 탭)', async () => {
      fishingOnlineService.addUserToOnline.mockResolvedValue({ wasAlreadyOnline: true });
      const client = createClient();

      await gateway.handleJoinMap(client, { mapId: MAP_ID });

      expect(clientRoomEmit).not.toHaveBeenCalled();
    });

    it('온라인 목록에 자기 정보가 없으면 접속수 1로 대체해야 함', async () => {
      fishingOnlineService.getOnlineUsersForMap.mockResolvedValue([]);
      const client = createClient();

      await gateway.handleJoinMap(client, { mapId: MAP_ID });

      expect(clientRoomEmit).toHaveBeenCalledWith(
        FishingSocketEvents.USER_JOINED,
        expect.objectContaining({ connectionCount: 1, position: undefined }),
      );
    });

    it('본인에게 온라인 목록과 전체 위치를 모두 보내야 함', async () => {
      const users = [{ userId: USER_ID, userName: '낚시왕', connectionCount: 1 }];
      const positions = { 1: { x: 5, y: 6, direction: 'right' as const, userName: '김일' } };
      fishingOnlineService.getOnlineUsersForMap.mockResolvedValue(users);
      fishingOnlineService.getAllPositions.mockResolvedValue(positions);
      const client = createClient();

      await gateway.handleJoinMap(client, { mapId: MAP_ID });

      // 목록만 보내면 새 접속자 화면에 캐릭터가 안 그려진다 (위치가 없으므로)
      expect(client.emit).toHaveBeenCalledWith(FishingSocketEvents.ONLINE_USERS, {
        mapId: MAP_ID,
        users,
        totalCount: 1,
      });
      expect(client.emit).toHaveBeenCalledWith(FishingSocketEvents.PLAYER_POSITIONS, {
        positions,
      });
    });
  });

  describe('handleLeaveMap', () => {
    it('이미 disconnect로 정리된 소켓이면 다시 제거하지 않아야 함', async () => {
      fishingOnlineService.isSocketRegistered.mockResolvedValue(false);
      const client = createClient('auth', { mapId: MAP_ID });

      await gateway.handleLeaveMap(client, { mapId: MAP_ID });

      // 중복 호출하면 퇴장 알림이 두 번 나간다
      expect(fishingOnlineService.removeSocket).not.toHaveBeenCalled();
      expect(serverRoomEmit).not.toHaveBeenCalled();
    });

    it('신원이 없으면 온라인 정리를 시도하지 않아야 함', async () => {
      const client = createClient('anonymous', { mapId: MAP_ID });

      await gateway.handleLeaveMap(client, { mapId: MAP_ID });

      expect(fishingOnlineService.isSocketRegistered).not.toHaveBeenCalled();
      expect(client.leave).toHaveBeenCalledWith(ROOM);
    });

    it('마지막 연결이 끊기면 맵 전체에 퇴장을 알려야 함', async () => {
      fishingOnlineService.isSocketRegistered.mockResolvedValue(true);
      fishingOnlineService.removeSocket.mockResolvedValue({
        mapId: MAP_ID,
        userId: USER_ID,
        userName: '낚시왕',
        isFullyOffline: true,
      });
      fishingOnlineService.getOnlineUsersForMap.mockResolvedValue([]);
      const client = createClient('auth', { mapId: MAP_ID });

      await gateway.handleLeaveMap(client, { mapId: MAP_ID });

      expect(gateway.server.to).toHaveBeenCalledWith(ROOM);
      expect(serverRoomEmit).toHaveBeenCalledWith(FishingSocketEvents.USER_LEFT, {
        userId: USER_ID,
        userName: '낚시왕',
        connectionCount: 0,
        totalOnlineCount: 0,
      });
    });

    it('다른 탭이 남아 있으면 퇴장을 알리지 않아야 함', async () => {
      fishingOnlineService.isSocketRegistered.mockResolvedValue(true);
      fishingOnlineService.removeSocket.mockResolvedValue({
        mapId: MAP_ID,
        userId: USER_ID,
        userName: '낚시왕',
        isFullyOffline: false,
      });
      const client = createClient('auth', { mapId: MAP_ID });

      await gateway.handleLeaveMap(client, { mapId: MAP_ID });

      expect(serverRoomEmit).not.toHaveBeenCalled();
    });

    it('제거 직후 재접속했으면 퇴장을 알리지 않아야 함 (경합 방어)', async () => {
      fishingOnlineService.isSocketRegistered.mockResolvedValue(true);
      fishingOnlineService.removeSocket.mockResolvedValue({
        mapId: MAP_ID,
        userId: USER_ID,
        userName: '낚시왕',
        isFullyOffline: true,
      });
      // 아직 온라인 목록에 남아 있다 = 다른 소켓이 붙었다
      fishingOnlineService.getOnlineUsersForMap.mockResolvedValue([
        { userId: USER_ID, userName: '낚시왕', connectionCount: 1 },
      ]);
      const client = createClient('auth', { mapId: MAP_ID });

      await gateway.handleLeaveMap(client, { mapId: MAP_ID });

      expect(serverRoomEmit).not.toHaveBeenCalled();
    });

    it('room에서 나가고 결과를 반환해야 함', async () => {
      const client = createClient('auth', { mapId: MAP_ID });

      await expect(gateway.handleLeaveMap(client, { mapId: MAP_ID })).resolves.toEqual({
        mapId: MAP_ID,
        room: ROOM,
      });
      expect(client.leave).toHaveBeenCalledWith(ROOM);
    });
  });

  describe('handleMove — 고빈도 이벤트', () => {
    const dto = { x: 100, y: 200, direction: 'left' as const };

    it('본인을 제외한 맵 전체에 이동을 알려야 함', async () => {
      const client = createClient('auth', { mapId: MAP_ID });
      const before = Date.now();

      await gateway.handleMove(client, dto);

      expect(client.to).toHaveBeenCalledWith(ROOM);
      const [event, payload] = clientRoomEmit.mock.calls[0] as [string, { timestamp: number }];
      expect(event).toBe(FishingSocketEvents.PLAYER_MOVED);
      expect(payload).toMatchObject({ userId: USER_ID, userName: '낚시왕', ...dto });
      // 실행 시간 오차를 감안해 ±5초 이내인지 확인
      expect(Math.abs(payload.timestamp - before)).toBeLessThan(5_000);
    });

    it('브로드캐스트를 Redis 저장보다 먼저 해야 함', async () => {
      const client = createClient('auth', { mapId: MAP_ID });

      await gateway.handleMove(client, dto);

      // 순서가 뒤집히면 Redis 지연이 그대로 이동 렉이 된다
      expect(clientRoomEmit.mock.invocationCallOrder[0]).toBeLessThan(
        fishingOnlineService.updatePosition.mock.invocationCallOrder[0],
      );
    });

    it('위치를 스냅샷용으로 저장해야 함', async () => {
      const client = createClient('auth', { mapId: MAP_ID });

      await gateway.handleMove(client, dto);

      expect(fishingOnlineService.updatePosition).toHaveBeenCalledWith(MAP_ID, USER_ID, dto);
    });

    it('게스트의 이동도 동일하게 처리해야 함', async () => {
      const client = createClient('guest', { mapId: MAP_ID });

      await gateway.handleMove(client, dto);

      expect(clientRoomEmit).toHaveBeenCalledWith(
        FishingSocketEvents.PLAYER_MOVED,
        expect.objectContaining({ userId: GUEST_ID, userName: '게스트17' }),
      );
    });

    it.each([
      ['맵에 참가하지 않았으면', 'auth' as const, undefined],
      ['신원이 없으면', 'anonymous' as const, MAP_ID],
    ])('%s 조용히 무시해야 함', async (_desc, kind, mapId) => {
      const client = createClient(kind, { mapId });

      await expect(gateway.handleMove(client, dto)).resolves.toBeUndefined();
      expect(clientRoomEmit).not.toHaveBeenCalled();
      expect(fishingOnlineService.updatePosition).not.toHaveBeenCalled();
    });
  });

  describe('handleFishingState', () => {
    const dto = { state: 'casting' as const, pointId: 'point-3' };

    it('본인을 제외한 맵 전체에 상태를 알려야 함', async () => {
      const client = createClient('auth', { mapId: MAP_ID });

      await gateway.handleFishingState(client, dto);

      expect(clientRoomEmit).toHaveBeenCalledWith(FishingSocketEvents.PLAYER_FISHING_STATE, {
        userId: USER_ID,
        userName: '낚시왕',
        state: 'casting',
        pointId: 'point-3',
      });
    });

    it('브로드캐스트를 Redis 저장보다 먼저 해야 함', async () => {
      const client = createClient('auth', { mapId: MAP_ID });

      await gateway.handleFishingState(client, dto);

      expect(clientRoomEmit.mock.invocationCallOrder[0]).toBeLessThan(
        fishingOnlineService.updateFishingState.mock.invocationCallOrder[0],
      );
      expect(fishingOnlineService.updateFishingState).toHaveBeenCalledWith(
        MAP_ID,
        USER_ID,
        'casting',
      );
    });

    it.each([
      ['맵에 참가하지 않았으면', 'auth' as const, undefined],
      ['신원이 없으면', 'anonymous' as const, MAP_ID],
    ])('%s 조용히 무시해야 함', async (_desc, kind, mapId) => {
      const client = createClient(kind, { mapId });

      await gateway.handleFishingState(client, dto);

      expect(clientRoomEmit).not.toHaveBeenCalled();
      expect(fishingOnlineService.updateFishingState).not.toHaveBeenCalled();
    });
  });

  describe('handleChatMessage', () => {
    const dto = { message: '안녕하세요' };

    it('본인을 포함해 맵 전체에 보내야 함', async () => {
      const client = createClient('auth', { mapId: MAP_ID });
      const before = Date.now();

      await gateway.handleChatMessage(client, dto);

      // 이동·낚시결과와 달리 server.to — 본인 화면에도 자기 말풍선이 떠야 한다
      expect(gateway.server.to).toHaveBeenCalledWith(ROOM);
      const [event, payload] = serverRoomEmit.mock.calls[0] as [string, { timestamp: string }];
      expect(event).toBe(FishingSocketEvents.CHAT_RECEIVED);
      expect(payload).toMatchObject({ userId: USER_ID, userName: '낚시왕', message: '안녕하세요' });
      expect(Math.abs(new Date(payload.timestamp).getTime() - before)).toBeLessThan(5_000);
    });

    it('게스트도 채팅할 수 있어야 함', async () => {
      const client = createClient('guest', { mapId: MAP_ID });

      await gateway.handleChatMessage(client, dto);

      expect(serverRoomEmit).toHaveBeenCalledWith(
        FishingSocketEvents.CHAT_RECEIVED,
        expect.objectContaining({ userId: GUEST_ID, userName: '게스트17' }),
      );
    });

    it.each([
      ['맵에 참가하지 않았으면', 'auth' as const, undefined],
      ['신원이 없으면', 'anonymous' as const, MAP_ID],
    ])('%s 조용히 무시해야 함', async (_desc, kind, mapId) => {
      const client = createClient(kind, { mapId });

      await gateway.handleChatMessage(client, dto);

      expect(serverRoomEmit).not.toHaveBeenCalled();
    });
  });

  describe('handleCatchResult', () => {
    const dto = { fishName: '붕어', grade: 'rare', size: 30, weight: 500 };

    it('본인을 제외한 맵 전체에 알려야 함', async () => {
      const client = createClient('auth', { mapId: MAP_ID });
      const before = Date.now();

      await gateway.handleCatchResult(client, dto);

      // 본인은 이미 UI에서 결과를 봤으므로 중복 표시를 막는다
      expect(client.to).toHaveBeenCalledWith(ROOM);
      expect(serverRoomEmit).not.toHaveBeenCalled();
      const [event, payload] = clientRoomEmit.mock.calls[0] as [string, { timestamp: string }];
      expect(event).toBe(FishingSocketEvents.CATCH_NOTIFICATION);
      expect(payload).toMatchObject({ userId: USER_ID, userName: '낚시왕', ...dto });
      expect(Math.abs(new Date(payload.timestamp).getTime() - before)).toBeLessThan(5_000);
    });

    it.each([
      ['맵에 참가하지 않았으면', 'auth' as const, undefined],
      ['신원이 없으면', 'anonymous' as const, MAP_ID],
    ])('%s 조용히 무시해야 함', async (_desc, kind, mapId) => {
      const client = createClient(kind, { mapId });

      await gateway.handleCatchResult(client, dto);

      expect(clientRoomEmit).not.toHaveBeenCalled();
    });
  });

  describe('연결 라이프사이클', () => {
    it('연결 해제 시 온라인 목록에서 제거해야 함', async () => {
      await gateway.handleDisconnect(createClient());

      expect(fishingOnlineService.removeSocket).toHaveBeenCalledWith(SOCKET_ID);
    });

    it('등록되지 않은 소켓이면 퇴장 알림을 보내지 않아야 함', async () => {
      fishingOnlineService.removeSocket.mockResolvedValue(null);

      await gateway.handleDisconnect(createClient());

      expect(serverRoomEmit).not.toHaveBeenCalled();
    });

    it('마지막 연결이었으면 퇴장을 알려야 함', async () => {
      fishingOnlineService.removeSocket.mockResolvedValue({
        mapId: MAP_ID,
        userId: USER_ID,
        userName: '낚시왕',
        isFullyOffline: true,
      });
      fishingOnlineService.getOnlineUsersForMap.mockResolvedValue([]);

      await gateway.handleDisconnect(createClient());

      expect(serverRoomEmit).toHaveBeenCalledWith(
        FishingSocketEvents.USER_LEFT,
        expect.objectContaining({ userId: USER_ID, userName: '낚시왕' }),
      );
    });

    it('다른 탭이 남아 있으면 퇴장을 알리지 않아야 함', async () => {
      fishingOnlineService.removeSocket.mockResolvedValue({
        mapId: MAP_ID,
        userId: USER_ID,
        userName: '낚시왕',
        isFullyOffline: false,
      });

      await gateway.handleDisconnect(createClient());

      expect(serverRoomEmit).not.toHaveBeenCalled();
    });

    it('연결 시에는 상태를 바꾸지 않아야 함 (joinMap 전까지 맵 소속 없음)', () => {
      gateway.handleConnection(createClient());

      expect(fishingOnlineService.addUserToOnline).not.toHaveBeenCalled();
    });
  });
});

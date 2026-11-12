import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { FortressGateway } from './fortress.gateway';
import { FortressError } from './fortress.errors';
import { FortressServerEvents, RoomState } from './fortress.events';
import { FortressLobbyChatService } from './fortress-lobby-chat.service';
import { FortressMatchService, MatchBroadcast } from './fortress-match.service';
import { FortressRoomService } from './fortress-room.service';
import { FortressSkinService } from './fortress-skin.service';
import { FortressSocket } from './fortress-ws.guard';
import { FortressWsExceptionFilter } from './fortress-ws-exception.filter';

const CODE = 'ABCDEF';
const CHANNEL = `fortress:room:${CODE}`;
const LOBBY = 'fortress:lobby';
const MATCH_ID = 'AAAAAAAAAAAAAAAA';

const ROOM: RoomState = {
  code: CODE,
  name: '방',
  mode: 'ffa',
  mapId: 'hills',
  maxPlayers: 4,
  locked: false,
  hostId: 'p1',
  status: 'WAITING',
  players: [{ playerId: 'p1', name: '방장', ready: false, connected: true, isGuest: true, extra: { team: null, tankId: 0, skin: { id: 'default', level: 1 } } }],
};

/**
 * 게이트웨이는 얇다 — 판정은 서비스, 게이트웨이는 "누구 이름으로 묻는가(client.id)"와 "누구에게 보내는가"를 맡는다.
 * 경기 이벤트는 경기 서비스 리스너로만 나간다(요청 경로·타이머·스위퍼가 같은 길).
 */
describe('FortressGateway', () => {
  let gateway: FortressGateway;
  let room: Record<string, jest.Mock>;
  let match: { setBroadcastListener: jest.Mock };
  let roomEmit: jest.Mock;
  let serverTo: jest.Mock;
  let socketsLeave: jest.Mock;
  let fetchSockets: jest.Mock;
  let lobbyChat: { senderOf: jest.Mock; recent: jest.Mock; publish: jest.Mock; senderKeyOf: jest.Mock };
  let skins: { tankSkinOf: jest.Mock };

  const createClient = (data: FortressSocket['data'] = { authResolved: true, userId: null }) =>
    ({
      id: 'sock-a',
      data,
      handshake: { headers: { 'x-forwarded-for': '1.1.1.1, 10.9.9.9' }, address: '10.0.0.1' },
      join: jest.fn(),
      leave: jest.fn(),
      disconnected: false,
      rooms: new Set<string>(),
    }) as unknown as FortressSocket & { join: jest.Mock; leave: jest.Mock; rooms: Set<string> };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    roomEmit = jest.fn();
    socketsLeave = jest.fn();
    serverTo = jest.fn(() => ({ emit: roomEmit }));
    room = {
      listRooms: jest.fn().mockResolvedValue([]),
      createRoom: jest.fn(),
      joinRoom: jest.fn(),
      leaveRoom: jest.fn(),
      setReady: jest.fn(),
      updateSettings: jest.fn(),
      setTeam: jest.fn(),
      setTank: jest.fn(),
      markDisconnected: jest.fn(),
      prepareChat: jest.fn(),
      prepareEmote: jest.fn(),
      consumeRateLimit: jest.fn().mockResolvedValue(true),
      startMatch: jest.fn(),
      rematch: jest.fn(),
      turnSubmit: jest.fn().mockResolvedValue(undefined),
      resync: jest.fn(),
      setLiveSocketProbe: jest.fn(),
      setChangeListener: jest.fn(),
      setSocketEvictor: jest.fn(),
    };
    match = { setBroadcastListener: jest.fn() };
    lobbyChat = { senderOf: jest.fn(), recent: jest.fn().mockResolvedValue([]), publish: jest.fn(), senderKeyOf: jest.fn().mockReturnValue('my-key') };
    fetchSockets = jest.fn().mockResolvedValue([{}, {}]);
    skins = { tankSkinOf: jest.fn().mockResolvedValue({ id: 'desert', level: 2 }) };
    gateway = new FortressGateway(
      room as unknown as FortressRoomService,
      match as unknown as FortressMatchService,
      lobbyChat as unknown as FortressLobbyChatService,
      skins as unknown as FortressSkinService,
    );
    gateway.server = { to: serverTo, in: jest.fn(() => ({ socketsLeave, fetchSockets })), local: { emit: jest.fn() } } as unknown as Server;
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('멤버 아님(NOT_IN_ROOM)이면 그대로 던지고 아무에게도 보내지 않는다 — 신원은 소켓 id', async () => {
    room.setTeam.mockRejectedValue(new FortressError('NOT_IN_ROOM'));
    await expect(gateway.handleSetTeam(createClient(), { code: CODE, team: 1 })).rejects.toMatchObject({ code: 'NOT_IN_ROOM' });
    expect(room.setTeam).toHaveBeenCalledWith(CODE, 'sock-a', 1);
    expect(serverTo).not.toHaveBeenCalled();
  });

  it('createRoom: 빈도 제한(소켓·IP — XFF 마지막 값) → 서비스 → 로비 해제·방 채널 입장·roomState', async () => {
    room.createRoom.mockResolvedValue({ room: ROOM, playerId: 'p1', playerToken: 'tok', replacedSocketId: null, lobbyChanged: false });
    const client = createClient();
    const ack = await gateway.handleCreateRoom(client, { name: '방', mode: 'ffa', mapId: 'hills', maxPlayers: 4, playerName: '방장' });

    expect(ack).toEqual({ ok: true, data: { room: ROOM, playerId: 'p1', playerToken: 'tok' } });
    expect(room.consumeRateLimit).toHaveBeenCalledWith('createRoomSocket', 'sock-a');
    expect(room.consumeRateLimit).toHaveBeenCalledWith('createRoomIp', '10.9.9.9');
    expect(room.createRoom.mock.calls[0][1]).toEqual({ socketId: 'sock-a', userId: null, ip: '10.9.9.9' });
    expect(client.leave).toHaveBeenCalledWith(LOBBY);
    expect(client.join).toHaveBeenCalledWith(CHANNEL);
    expect(client.data.room).toEqual({ code: CODE, playerId: 'p1' });
    expect(roomEmit).toHaveBeenCalledWith(FortressServerEvents.ROOM_STATE, ROOM);
  });

  it('joinRoom: 넘겨받은 이전 소켓은 채널에서 빼고 sessionReplaced, ack에 rejoin.match', async () => {
    const rejoin = { match: { matchId: MATCH_ID } };
    room.joinRoom.mockImplementation(async (_d, _w, _n, beforeCommit: () => Promise<void>, afterCommit: (e: unknown) => Promise<void>) => {
      const entered = { room: ROOM, playerId: 'p1', playerToken: 'tok', replacedSocketId: 'sock-old', lobbyChanged: false, rejoin };
      await beforeCommit();
      await afterCommit(entered);
      return entered;
    });
    const ack = await gateway.handleJoinRoom(createClient(), { code: CODE, playerName: '방장', playerToken: 't'.repeat(32) });

    expect(ack).toEqual({ ok: true, data: { room: ROOM, playerId: 'p1', playerToken: 'tok', rejoin } });
    expect(socketsLeave).toHaveBeenCalledWith(CHANNEL);
    expect(serverTo).toHaveBeenCalledWith('sock-old');
    expect(roomEmit).toHaveBeenCalledWith(FortressServerEvents.SESSION_REPLACED, { code: CODE });
  });

  describe('F7 탱크 스킨 — 입장 신원에 계정 장착을 붙인다', () => {
    const entered = { room: ROOM, playerId: 'p1', playerToken: 'tok', replacedSocketId: null, lobbyChanged: false };

    it('로그인 createRoom·joinRoom: 그 userId의 장착을 읽어 신원 skin으로 넘긴다(페이로드 값이 아니라)', async () => {
      room.createRoom.mockResolvedValue(entered);
      room.joinRoom.mockResolvedValue(entered);
      await gateway.handleCreateRoom(createClient({ authResolved: true, userId: 42 }), { name: '방', mode: 'ffa', mapId: 'hills', maxPlayers: 4, playerName: '방장' });
      await gateway.handleJoinRoom(createClient({ authResolved: true, userId: 42 }), { code: CODE, playerName: '방장' });
      expect(skins.tankSkinOf).toHaveBeenCalledWith(42);
      const identity = { socketId: 'sock-a', userId: 42, ip: '10.9.9.9', skin: { id: 'desert', level: 2 } };
      expect(room.createRoom.mock.calls[0][1]).toEqual(identity);
      expect(room.joinRoom.mock.calls[0][1]).toEqual(identity);
    });

    it('게스트는 조회하지 않는다(skin 없음 → 서비스가 default)', async () => {
      room.joinRoom.mockResolvedValue(entered);
      await gateway.handleJoinRoom(createClient(), { code: CODE, playerName: '손님' });
      expect(skins.tankSkinOf).not.toHaveBeenCalled();
      expect(room.joinRoom.mock.calls[0][1]).toEqual({ socketId: 'sock-a', userId: null, ip: '10.9.9.9' });
    });

    it('조회 실패여도 입장은 진행 — skin 없이 넘긴다(새 자리 default, 기존 자리 유지)', async () => {
      skins.tankSkinOf.mockRejectedValue(new Error('db down'));
      room.joinRoom.mockResolvedValue(entered);
      const ack = await gateway.handleJoinRoom(createClient({ authResolved: true, userId: 42 }), { code: CODE, playerName: '방장' });
      expect(ack.ok).toBe(true);
      expect(room.joinRoom.mock.calls[0][1]).toEqual({ socketId: 'sock-a', userId: 42, ip: '10.9.9.9' });
    });
  });

  it('updateSettings: 보낸 필드만 서비스에 넘긴다(빠진 필드는 그대로)', async () => {
    room.updateSettings.mockResolvedValue({ room: ROOM, lobbyChanged: false });
    await gateway.handleUpdateSettings(createClient(), { code: CODE, mapId: 'canyon' });
    expect(room.updateSettings).toHaveBeenCalledWith(CODE, 'sock-a', { mapId: 'canyon' });
  });

  it('startMatch: matchStarting → roomState 순서로 방 채널에', async () => {
    const starting = { matchId: MATCH_ID };
    room.startMatch.mockResolvedValue({ room: { ...ROOM, status: 'PLAYING' }, lobbyChanged: false, starting });
    await gateway.handleStartMatch(createClient(), { code: CODE });
    expect(roomEmit.mock.calls.map((c) => c[0])).toEqual([FortressServerEvents.MATCH_STARTING, FortressServerEvents.ROOM_STATE]);
    expect(roomEmit).toHaveBeenCalledWith(FortressServerEvents.MATCH_STARTING, starting);
  });

  it('turnSubmit·resync: 소켓이 들어간 방 코드로 서비스에, 방이 없으면 NOT_IN_ROOM', async () => {
    const dto = { matchId: MATCH_ID, seq: 0, move: 0, angle: 45, power: 0, weaponId: 0 };
    await expect(gateway.handleTurnSubmit(createClient(), dto)).rejects.toMatchObject({ code: 'NOT_IN_ROOM' });

    const client = createClient({ authResolved: true, userId: null, room: { code: CODE, playerId: 'p1' } });
    await expect(gateway.handleTurnSubmit(client, dto)).resolves.toEqual({ ok: true, data: {} });
    expect(room.turnSubmit).toHaveBeenCalledWith(CODE, 'sock-a', dto);

    room.resync.mockResolvedValue({ matchId: MATCH_ID });
    await expect(gateway.handleResync(client, { matchId: MATCH_ID })).resolves.toEqual({ ok: true, data: { matchId: MATCH_ID } });
  });

  it('afterInit: 경기 이벤트(turnResolved·matchEnded)를 방 채널로 보낸다', () => {
    gateway.afterInit();
    const listener = match.setBroadcastListener.mock.calls[0][0] as (code: string, b: MatchBroadcast) => void;
    listener(CODE, { event: 'turnResolved', payload: { matchId: MATCH_ID } } as unknown as MatchBroadcast);
    listener(CODE, { event: 'matchEnded', payload: { matchId: MATCH_ID } } as unknown as MatchBroadcast);
    expect(serverTo).toHaveBeenCalledWith(CHANNEL);
    expect(roomEmit.mock.calls.map((c) => c[0])).toEqual([FortressServerEvents.TURN_RESOLVED, FortressServerEvents.MATCH_ENDED]);
  });

  it('leaveRoom: 이미 방에 없으면 채널만 정리하고 오류를 그대로', async () => {
    room.leaveRoom.mockRejectedValue(new FortressError('NOT_IN_ROOM'));
    const client = createClient({ authResolved: true, userId: null, room: { code: CODE, playerId: 'p1' } });
    await expect(gateway.handleLeaveRoom(client, { code: CODE })).rejects.toMatchObject({ code: 'NOT_IN_ROOM' });
    expect(client.leave).toHaveBeenCalledWith(CHANNEL);
    expect(client.data.room).toBeUndefined();
  });

  it('끊김: 소켓이 들어간 방을 서비스에 알리고 변경을 방송', async () => {
    room.markDisconnected.mockResolvedValue({ room: ROOM, lobbyChanged: false });
    await gateway.handleDisconnect(createClient({ authResolved: true, userId: null, room: { code: CODE, playerId: 'p1' } }));
    expect(room.markDisconnected).toHaveBeenCalledWith(CODE, 'sock-a');
    expect(roomEmit).toHaveBeenCalledWith(FortressServerEvents.ROOM_STATE, ROOM);
  });

  describe('로비 전체 채팅 (D-016 — 테트리스 게이트웨이 spec과 같은 사례)', () => {
    const LOBBY_CHAT = 'fortress:lobby-chat';
    const IP = '10.9.9.9';
    const MSG = { id: 'm1', senderKey: 'k', name: '손님', isGuest: true, text: '안녕', at: 'now' };

    it('구독 — 보낸 사람 표시를 소켓에 두고 포트리스 채널에 넣은 뒤 최근 대화·참여 수·내 표시를 돌려준다', async () => {
      const client = createClient({ authResolved: true, userId: 7 });
      lobbyChat.senderOf.mockResolvedValue({ isGuest: false, name: '개발자' });
      lobbyChat.recent.mockResolvedValue([MSG]);

      const ack = await gateway.handleJoinLobbyChat(client);

      expect(lobbyChat.senderOf).toHaveBeenCalledWith(7);
      expect(client.join).toHaveBeenCalledWith(LOBBY_CHAT);
      expect(client.data.lobbyChat).toEqual({ isGuest: false, name: '개발자' });
      expect(ack).toEqual({ ok: true, data: { messages: [MSG], onlineCount: 2, me: { isGuest: false, name: '개발자', senderKey: 'my-key' } } });
      expect(lobbyChat.senderKeyOf).toHaveBeenCalledWith(7, IP);
      expect(room.consumeRateLimit).toHaveBeenCalledWith('lobbyChatJoin', 'sock-a');
      expect(room.consumeRateLimit).toHaveBeenCalledWith('lobbyChatJoinIp', IP);
      expect(client.join.mock.invocationCallOrder[0]).toBeLessThan(lobbyChat.recent.mock.invocationCallOrder[0]);
    });

    it('구독 — 기다리는 동안 끊긴 소켓은 채널에 넣지 않는다', async () => {
      const client = Object.assign(createClient(), { disconnected: true });
      lobbyChat.senderOf.mockResolvedValue({ isGuest: true, name: null });
      await expect(gateway.handleJoinLobbyChat(client)).rejects.toMatchObject({ code: 'LOBBY_CHAT_NOT_JOINED' });
      expect(client.join).not.toHaveBeenCalled();
    });

    it('구독 — 최근 대화를 못 읽으면 실패로 돌려주고 채널에서 뺀다', async () => {
      const client = createClient();
      lobbyChat.senderOf.mockResolvedValue({ isGuest: true, name: null });
      lobbyChat.recent.mockRejectedValue(new FortressError('SERVICE_UNAVAILABLE'));
      await expect(gateway.handleJoinLobbyChat(client)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(client.leave).toHaveBeenCalledWith(LOBBY_CHAT);
      expect(client.data.lobbyChat).toBeUndefined();
    });

    it('구독 — 참여 수 조회가 실패해도 구독은 성공, onlineCount null', async () => {
      lobbyChat.senderOf.mockResolvedValue({ isGuest: true, name: null });
      fetchSockets.mockRejectedValue(new Error('adapter timeout'));
      await expect(gateway.handleJoinLobbyChat(createClient())).resolves.toMatchObject({ ok: true, data: { onlineCount: null } });
    });

    it('구독 연타 → RATE_LIMITED, 채널에 넣지 않는다', async () => {
      room.consumeRateLimit.mockResolvedValue(false);
      const client = createClient();
      await expect(gateway.handleJoinLobbyChat(client)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      expect(client.join).not.toHaveBeenCalled();
    });

    it('보내기 — 구독한 소켓만, 확정 메시지를 포트리스 채널(보낸 사람 포함)에 방송하고 ack로도 돌려준다', async () => {
      const client = createClient({ authResolved: true, userId: null, lobbyChat: { isGuest: true, name: null } });
      client.rooms.add(LOBBY_CHAT);
      lobbyChat.publish.mockResolvedValue(MSG);

      const ack = await gateway.handleLobbyChat(client, { text: '안녕', name: '손님' });

      expect(lobbyChat.publish).toHaveBeenCalledWith({ sender: { isGuest: true, name: null }, userId: null, ip: IP, name: '손님', text: '안녕' });
      expect(serverTo).toHaveBeenCalledWith(LOBBY_CHAT);
      expect(serverTo).not.toHaveBeenCalledWith('tetris-battle:lobby-chat');
      expect(roomEmit).toHaveBeenCalledWith(FortressServerEvents.LOBBY_CHAT_MESSAGE, MSG);
      expect(ack).toEqual({ ok: true, data: { message: MSG } });
    });

    it.each([
      ['구독하지 않음(채널에만 있음)', {}, true],
      ['나간 뒤(채널 밖)', { lobbyChat: { isGuest: true, name: null } }, false],
    ])('보내기 — %s → LOBBY_CHAT_NOT_JOINED, 방송 없음', async (_label, extra, inRoom) => {
      const client = createClient({ authResolved: true, userId: null, ...extra });
      if (inRoom) client.rooms.add(LOBBY_CHAT);
      await expect(gateway.handleLobbyChat(client, { text: '안녕' })).rejects.toMatchObject({ code: 'LOBBY_CHAT_NOT_JOINED' });
      expect(lobbyChat.publish).not.toHaveBeenCalled();
      expect(serverTo).not.toHaveBeenCalled();
    });

    it('검증 실패(서비스 거부) → 방송 없음', async () => {
      const client = createClient({ authResolved: true, userId: null, lobbyChat: { isGuest: true, name: null } });
      client.rooms.add(LOBBY_CHAT);
      lobbyChat.publish.mockRejectedValue(new FortressError('CHAT_FORBIDDEN'));
      await expect(gateway.handleLobbyChat(client, { text: '나쁜말' })).rejects.toMatchObject({ code: 'CHAT_FORBIDDEN' });
      expect(serverTo).not.toHaveBeenCalled();
    });

    it('join 처리 중에 온 leave·보내기는 join이 끝난 뒤 차례대로 — 나간 뒤 구독 상태로 남지 않는다', async () => {
      const client = createClient();
      let release!: (v: { isGuest: boolean; name: string | null }) => void;
      lobbyChat.senderOf.mockReturnValue(new Promise((r) => (release = r)));
      client.join.mockImplementation(async () => client.rooms.add(LOBBY_CHAT));
      client.leave.mockImplementation(async () => client.rooms.delete(LOBBY_CHAT));

      const join = gateway.handleJoinLobbyChat(client);
      const leave = gateway.handleLeaveLobbyChat(client);
      const send = gateway.handleLobbyChat(client, { text: '안녕', name: '손님' });
      release({ isGuest: true, name: null });

      await expect(join).resolves.toMatchObject({ ok: true });
      await expect(leave).resolves.toEqual({ ok: true, data: {} });
      await expect(send).rejects.toMatchObject({ code: 'LOBBY_CHAT_NOT_JOINED' });
      expect(client.rooms.has(LOBBY_CHAT)).toBe(false);
      expect(client.data.lobbyChat).toBeUndefined();
    });

    it('나가기 — 채널에서 빠지고 소켓 표시를 지운다', async () => {
      const client = createClient({ authResolved: true, userId: null, lobbyChat: { isGuest: true, name: null } });
      await gateway.handleLeaveLobbyChat(client);
      expect(client.leave).toHaveBeenCalledWith(LOBBY_CHAT);
      expect(client.data.lobbyChat).toBeUndefined();
    });
  });
});

describe('FortressWsExceptionFilter', () => {
  const filter = new FortressWsExceptionFilter();
  const hostOf = (ack: unknown) => {
    const client = { id: 'sock-a', emit: jest.fn() };
    const host = { switchToWs: () => ({ getClient: () => client }), getArgs: () => [client, {}, ack] } as unknown as ArgumentsHost;
    return { host, client };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [new FortressError('TURN_MISMATCH'), 'TURN_MISMATCH', '턴 정보가 맞지 않습니다. 경기 상태를 다시 불러옵니다.'],
    [new FortressError('ACTION_REJECTED', 'MOVE_RANGE'), 'ACTION_REJECTED', 'MOVE_RANGE'],
    [new BadRequestException(['angle must be an integer']), 'INVALID_PAYLOAD', '요청 형식이 올바르지 않습니다.'],
    [new Error('내부 비밀'), 'INTERNAL_ERROR', '서버 내부 오류가 발생했습니다.'],
  ] as const)('ack가 있으면 ack로 — %s → %s', (exception, code, message) => {
    const ack = jest.fn();
    const { host, client } = hostOf(ack);
    filter.catch(exception, host);
    expect(ack).toHaveBeenCalledWith({ ok: false, code, message });
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('ack가 없으면 error 이벤트 {code, message, timestamp}', () => {
    const { host, client } = hostOf(undefined);
    filter.catch(new FortressError('NOT_YOUR_TURN'), host);
    expect(client.emit).toHaveBeenCalledWith('error', { code: 'NOT_YOUR_TURN', message: '지금은 내 차례가 아닙니다.', timestamp: expect.any(String) });
  });
});

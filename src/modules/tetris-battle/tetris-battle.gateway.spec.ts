import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { TetrisBattleGateway } from './tetris-battle.gateway';
import { LOBBY_BROADCAST_DEBOUNCE_MS } from './tetris-battle.constants';
import { TetrisBattleError } from './tetris-battle.errors';
import { RoomState, TetrisBattleServerEvents } from './tetris-battle.events';
import { TetrisBattleRoomService } from './tetris-battle-room.service';
import { TetrisBattleSocket } from './tetris-battle-ws.guard';
import { TetrisBattleWsExceptionFilter } from './tetris-battle-ws-exception.filter';

const CODE = 'ABCDEF';
const CHANNEL = `tetris-battle:room:${CODE}`;
const LOBBY = 'tetris-battle:lobby';

/** 서비스 joinRoom·createRoom 대역: 사전 검증 통과 → beforeCommit(이전 방 이탈) → 커밋 순서를 흉내 낸다 */
const committing =
  <T>(result: T, onCommit?: () => void) =>
  async (
    _dto: unknown,
    _who: unknown,
    _now: unknown,
    beforeCommit?: () => Promise<void>,
    afterCommit?: (entered: T) => Promise<void>,
  ) => {
    await beforeCommit?.();
    onCommit?.();
    await afterCommit?.(result); // 게이트웨이의 채널 입장(enter) — 실제 서비스처럼 커밋 직후
    return result;
  };

/** 결과가 나중에 정해지는 joinRoom 대역 (직렬화 테스트용) */
const committingLater =
  <T>(pending: Promise<T>) =>
  async (_d: unknown, _w: unknown, _n: unknown, beforeCommit?: () => Promise<void>, afterCommit?: (e: T) => Promise<void>) => {
    const result = await pending;
    await beforeCommit?.();
    await afterCommit?.(result);
    return result;
  };

const ROOM: RoomState = {
  code: CODE,
  name: '방',
  maxPlayers: 4,
  locked: false,
  hostId: 'p1',
  status: 'WAITING',
  players: [{ playerId: 'p1', name: '방장', ready: false, connected: true, isGuest: true }],
};

/**
 * 게이트웨이는 얇다 — 판정은 서비스, 게이트웨이는 "누구 이름으로 묻는가(client.id)"와 "누구에게 보내는가"를 맡는다.
 * 핵심 계약:
 *  - 서비스에 넘기는 신원은 **소켓 id**다(페이로드의 playerId 등은 없다)
 *  - 서비스가 거부(NOT_IN_ROOM 등)하면 **아무 브로드캐스트도, 방 채널 입장도 없다**
 *  - 입장 성공 시에만 방 채널에 들어가고 로비에서 빠진다
 */
describe('TetrisBattleGateway', () => {
  let gateway: TetrisBattleGateway;
  let service: Record<
    | 'listRooms'
    | 'createRoom'
    | 'joinRoom'
    | 'leaveRoom'
    | 'setReady'
    | 'markDisconnected'
    | 'prepareChat'
    | 'prepareEmote'
    | 'consumeRateLimit'
    | 'startMatch'
    | 'rematch'
    | 'lock'
    | 'topOut',
    jest.Mock
  >;
  let roomEmit: jest.Mock;
  let serverTo: jest.Mock;
  let socketsLeave: jest.Mock;

  const createClient = (data: TetrisBattleSocket['data'] = { authResolved: true, userId: null }) =>
    ({
      id: 'sock-a',
      data,
      handshake: { headers: {}, address: '10.0.0.1' },
      join: jest.fn(),
      leave: jest.fn(),
    }) as unknown as TetrisBattleSocket & { join: jest.Mock; leave: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    roomEmit = jest.fn();
    socketsLeave = jest.fn();
    serverTo = jest.fn(() => ({ emit: roomEmit }));
    service = {
      listRooms: jest.fn().mockResolvedValue([]),
      createRoom: jest.fn(),
      joinRoom: jest.fn(),
      leaveRoom: jest.fn(),
      setReady: jest.fn(),
      markDisconnected: jest.fn(),
      prepareChat: jest.fn(),
      prepareEmote: jest.fn(),
      consumeRateLimit: jest.fn().mockResolvedValue(true),
      startMatch: jest.fn(),
      rematch: jest.fn(),
      lock: jest.fn(),
      topOut: jest.fn(),
    };
    gateway = new TetrisBattleGateway(service as unknown as TetrisBattleRoomService);
    gateway.server = { to: serverTo, in: jest.fn(() => ({ socketsLeave })) } as unknown as Server;
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('멤버십 거부 — 브로드캐스트 없음', () => {
    it.each([
      ['chat', (g: TetrisBattleGateway, c: TetrisBattleSocket) => g.handleChat(c, { code: CODE, text: '안녕' }), 'prepareChat'],
      ['emote', (g: TetrisBattleGateway, c: TetrisBattleSocket) => g.handleEmote(c, { code: CODE, emoteId: 'gg' }), 'prepareEmote'],
      ['setReady', (g: TetrisBattleGateway, c: TetrisBattleSocket) => g.handleSetReady(c, { code: CODE, ready: true }), 'setReady'],
      ['leaveRoom', (g: TetrisBattleGateway, c: TetrisBattleSocket) => g.handleLeaveRoom(c, { code: CODE }), 'leaveRoom'],
    ] as const)('%s: 서비스가 NOT_IN_ROOM이면 그대로 던지고 아무에게도 보내지 않는다', async (_label, call, method) => {
      service[method].mockRejectedValue(new TetrisBattleError('NOT_IN_ROOM'));
      const client = createClient();

      await expect(call(gateway, client)).rejects.toMatchObject({ code: 'NOT_IN_ROOM' });
      expect(service[method].mock.calls[0][1]).toBe('sock-a'); // 신원 = 소켓 id
      expect(serverTo).not.toHaveBeenCalled();
      // leaveRoom만 NOT_IN_ROOM이면 채널을 정리한다(이미 방에 없음, 리뷰 K1) — 그 외 핸들러는 소켓 상태를 바꾸지 않는다
      if (method !== 'leaveRoom') expect(client.leave).not.toHaveBeenCalled();
    });

    it('joinRoom이 거부되면(비밀번호 등) 방 채널에 들어가지 않는다', async () => {
      service.joinRoom.mockRejectedValue(new TetrisBattleError('ROOM_WRONG_PASSWORD'));
      const client = createClient();

      await expect(gateway.handleJoinRoom(client, { code: CODE, playerName: '나' })).rejects.toMatchObject({
        code: 'ROOM_WRONG_PASSWORD',
      });
      expect(client.join).not.toHaveBeenCalled();
      expect(client.data.room).toBeUndefined();
    });
  });

  describe('입장', () => {
    beforeEach(() => jest.useFakeTimers());

    const entered = { room: ROOM, playerId: 'p1', playerToken: 'tok', replacedSocketId: null, lobbyChanged: true };

    it('createRoom 성공: 로비에서 빠지고 방 채널 입장, roomState·roomsChanged 브로드캐스트, ack에 토큰', async () => {
      service.createRoom.mockResolvedValue(entered);
      const client = createClient({ authResolved: true, userId: 42 });

      const ack = await gateway.handleCreateRoom(client, { name: '방', maxPlayers: 4, playerName: '방장' });

      expect(ack).toEqual({ ok: true, data: { room: ROOM, playerId: 'p1', playerToken: 'tok' } });
      expect(service.createRoom.mock.calls[0][1]).toEqual({ socketId: 'sock-a', userId: 42, ip: '10.0.0.1' });
      expect(client.leave).toHaveBeenCalledWith(LOBBY);
      // 방 채널 + 플레이어 채널(garbage 수신용, 리뷰 H2)
      expect(client.join).toHaveBeenCalledWith([CHANNEL, `tetris-battle:player:${CODE}:p1`]);
      expect(client.data.room).toEqual({ code: CODE, playerId: 'p1' });
      expect(serverTo).toHaveBeenCalledWith(CHANNEL);
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.ROOM_STATE, ROOM);
      // 로비 방송은 LOBBY_BROADCAST_DEBOUNCE_MS 뒤 1번(BE-09)
      await jest.advanceTimersByTimeAsync(LOBBY_BROADCAST_DEBOUNCE_MS);
      expect(serverTo).toHaveBeenCalledWith(LOBBY);
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.ROOMS_CHANGED, { rooms: [] });
      expect(service.listRooms).toHaveBeenCalledWith(undefined, { reconcile: false });
    });

    it('방 변경이 몰려도 로비 방송은 묶어서 1번만 만든다 (BE-09)', async () => {
      service.createRoom.mockResolvedValue(entered);
      await gateway.handleCreateRoom(createClient(), { name: '방', maxPlayers: 4, playerName: '방장' });
      await gateway.handleCreateRoom(createClient(), { name: '방', maxPlayers: 4, playerName: '방장' });
      await jest.advanceTimersByTimeAsync(LOBBY_BROADCAST_DEBOUNCE_MS);
      expect(service.listRooms).toHaveBeenCalledTimes(1);
    });

    it('createRoom 빈도 한도(소켓·IP)를 넘으면 RATE_LIMITED, 방을 만들지 않는다', async () => {
      service.consumeRateLimit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await expect(
        gateway.handleCreateRoom(createClient(), { name: '방', maxPlayers: 4, playerName: '방장' }),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      expect(service.consumeRateLimit).toHaveBeenLastCalledWith('createRoomIp', '10.0.0.1');
      expect(service.createRoom).not.toHaveBeenCalled();
    });

    it('joinRoom에도 IP를 넘긴다(비밀번호 IP 잠금)', async () => {
      service.joinRoom.mockImplementation(committing(entered));
      const client = createClient();
      (client.handshake.headers as Record<string, string>)['x-forwarded-for'] = '6.6.6.6, 203.0.113.9';
      await gateway.handleJoinRoom(client, { code: CODE, playerName: '나', password: 'pw' });
      expect(service.joinRoom.mock.calls[0][1]).toEqual({ socketId: 'sock-a', userId: null, ip: '203.0.113.9' });
    });

    it('IP는 X-Forwarded-For의 마지막 값(바로 앞 프록시)을 쓴다', async () => {
      service.createRoom.mockResolvedValue(entered);
      const client = createClient();
      (client.handshake.headers as Record<string, string>)['x-forwarded-for'] = '6.6.6.6, 203.0.113.9';
      await gateway.handleCreateRoom(client, { name: '방', maxPlayers: 4, playerName: '방장' });
      expect(service.consumeRateLimit).toHaveBeenCalledWith('createRoomIp', '203.0.113.9');
    });

    it('다른 방에 있던 소켓이 새 방에 들어가면 이전 방 이탈은 사전 검증 뒤·커밋 전에 한다 (리뷰 F6·G6)', async () => {
      const order: string[] = [];
      service.leaveRoom.mockImplementation(async () => (order.push('leave'), { room: null, lobbyChanged: true }));
      service.joinRoom.mockImplementation(
        async (
          dto: unknown,
          who: unknown,
          now: unknown,
          beforeCommit?: () => Promise<void>,
          afterCommit?: (e: typeof entered) => Promise<void>,
        ) => {
          order.push('validate');
          return committing({ ...entered, playerId: 'p2' }, () => order.push('commit'))(dto, who, now, beforeCommit, afterCommit);
        },
      );
      const client = createClient({ authResolved: true, userId: null, room: { code: 'ZZZZZZ', playerId: 'p1' } });

      await gateway.handleJoinRoom(client, { code: CODE, playerName: '나' });

      expect(order).toEqual(['validate', 'leave', 'commit']);
      expect(service.leaveRoom).toHaveBeenCalledWith('ZZZZZZ', 'sock-a');
      expect(client.leave).toHaveBeenCalledWith('tetris-battle:room:ZZZZZZ');
      expect(client.data.room).toEqual({ code: CODE, playerId: 'p2' });
    });

    it.each(['ROOM_NOT_FOUND', 'NOT_IN_ROOM'] as const)('이전 방 이탈이 %s면 무시하고 입장한다', async (code) => {
      service.leaveRoom.mockRejectedValue(new TetrisBattleError(code));
      service.joinRoom.mockImplementation(committing({ ...entered, playerId: 'p2' }));
      const client = createClient({ authResolved: true, userId: null, room: { code: 'ZZZZZZ', playerId: 'p1' } });

      await expect(gateway.handleJoinRoom(client, { code: CODE, playerName: '나' })).resolves.toMatchObject({ ok: true });
    });

    it('이전 방 이탈이 그 밖의 오류면 새 입장을 커밋하지 않고 오류를 그대로 던진다 (리뷰 F6)', async () => {
      service.leaveRoom.mockRejectedValue(new TetrisBattleError('ROOM_BUSY'));
      const commit = jest.fn();
      service.joinRoom.mockImplementation(committing(entered, commit));
      const client = createClient({ authResolved: true, userId: null, room: { code: 'ZZZZZZ', playerId: 'p1' } });

      await expect(gateway.handleJoinRoom(client, { code: CODE, playerName: '나' })).rejects.toMatchObject({
        code: 'ROOM_BUSY',
      });
      expect(commit).not.toHaveBeenCalled();
      expect(client.data.room).toEqual({ code: 'ZZZZZZ', playerId: 'p1' });
    });

    it('새 방 사전 검증이 실패하면(오답·만원 등) 이전 방에 그대로 남는다 (리뷰 G6)', async () => {
      service.joinRoom.mockRejectedValue(new TetrisBattleError('ROOM_WRONG_PASSWORD'));
      const client = createClient({ authResolved: true, userId: null, room: { code: 'ZZZZZZ', playerId: 'p1' } });

      await expect(gateway.handleJoinRoom(client, { code: CODE, playerName: '나' })).rejects.toMatchObject({
        code: 'ROOM_WRONG_PASSWORD',
      });
      expect(service.leaveRoom).not.toHaveBeenCalled();
      expect(client.leave).not.toHaveBeenCalled();
      expect(client.data.room).toEqual({ code: 'ZZZZZZ', playerId: 'p1' });
    });

    it('createRoom도 이전 방 이탈을 생성 커밋 직전에 한다', async () => {
      service.createRoom.mockImplementation(committing(entered));
      service.leaveRoom.mockResolvedValue({ room: null, lobbyChanged: true });
      const client = createClient({ authResolved: true, userId: null, room: { code: 'ZZZZZZ', playerId: 'p1' } });

      await gateway.handleCreateRoom(client, { name: '방', maxPlayers: 4, playerName: '방장' });

      expect(service.leaveRoom).toHaveBeenCalledWith('ZZZZZZ', 'sock-a');
      expect(client.data.room).toEqual({ code: CODE, playerId: 'p1' });
    });

    it('같은 방에 다시 입장하면 이전 방 이탈을 하지 않는다', async () => {
      service.joinRoom.mockImplementation(committing(entered));
      const client = createClient({ authResolved: true, userId: null, room: { code: CODE, playerId: 'p1' } });
      await gateway.handleJoinRoom(client, { code: CODE, playerName: '나' });
      expect(service.leaveRoom).not.toHaveBeenCalled();
    });

    it('joinRoom도 소켓·IP 빈도 제한 — 넘으면 RATE_LIMITED, 서비스 호출 없음 (리뷰 F1)', async () => {
      service.consumeRateLimit.mockResolvedValueOnce(false);
      await expect(gateway.handleJoinRoom(createClient(), { code: CODE, playerName: '나' })).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
      expect(service.consumeRateLimit).toHaveBeenCalledWith('joinRoomSocket', 'sock-a');
      expect(service.joinRoom).not.toHaveBeenCalled();
    });

    it('입장 커밋 시점에 소켓이 이미 끊겼으면 방 채널에 넣지 않고 바로 끊김으로 표시한다(리뷰 F2·G2)', async () => {
      service.joinRoom.mockImplementation(committing(entered));
      service.markDisconnected.mockResolvedValue({ room: ROOM, lobbyChanged: false });
      const client = createClient();
      (client as unknown as { disconnected: boolean }).disconnected = true;

      await gateway.handleJoinRoom(client, { code: CODE, playerName: '나' });

      expect(client.join).not.toHaveBeenCalled();
      expect(service.markDisconnected).toHaveBeenCalledWith(CODE, 'sock-a');
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.ROOM_STATE, ROOM);
    });

    it('토큰 재연결로 넘겨받은 이전 소켓은 방 채널에서 뺀다', async () => {
      service.joinRoom.mockImplementation(committing({ ...entered, replacedSocketId: 'sock-old', lobbyChanged: false }));

      await gateway.handleJoinRoom(createClient(), { code: CODE, playerName: '나', playerToken: 't'.repeat(32) });

      expect(gateway.server.in).toHaveBeenCalledWith('sock-old');
      expect(socketsLeave).toHaveBeenCalledWith([CHANNEL, `tetris-battle:player:${CODE}:p1`]);
      expect(serverTo).not.toHaveBeenCalledWith(LOBBY); // 로비 값 변화 없음
    });

    it('넘겨받힌 이전 소켓에만 sessionReplaced를 보낸다 (tetris-audit D-007)', async () => {
      service.joinRoom.mockImplementation(committing({ ...entered, replacedSocketId: 'sock-old', lobbyChanged: false }));

      await gateway.handleJoinRoom(createClient(), { code: CODE, playerName: '나', playerToken: 't'.repeat(32) });

      expect(serverTo).toHaveBeenCalledWith('sock-old');
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.SESSION_REPLACED, { code: CODE });
    });

    it('넘겨받은 소켓이 없으면 sessionReplaced를 보내지 않는다', async () => {
      service.joinRoom.mockImplementation(committing(entered));

      await gateway.handleJoinRoom(createClient(), { code: CODE, playerName: '나' });

      expect(roomEmit).not.toHaveBeenCalledWith(TetrisBattleServerEvents.SESSION_REPLACED, expect.anything());
    });
  });

  it('listRooms: 목록을 돌려주고 로비 채널을 구독한다', async () => {
    service.listRooms.mockResolvedValue([{ code: CODE }]);
    const client = createClient();
    await expect(gateway.handleListRooms(client, {})).resolves.toEqual({ ok: true, data: { rooms: [{ code: CODE }] } });
    expect(client.join).toHaveBeenCalledWith(LOBBY);
  });

  it('leaveRoom: 방 채널에서 빠지고 남은 사람에게 roomState', async () => {
    service.leaveRoom.mockResolvedValue({ room: ROOM, lobbyChanged: true });
    const client = createClient({ authResolved: true, userId: null, room: { code: CODE, playerId: 'p2' } });

    await expect(gateway.handleLeaveRoom(client, { code: CODE })).resolves.toEqual({ ok: true, data: {} });
    expect(client.leave).toHaveBeenCalledWith(CHANNEL);
    expect(client.data.room).toBeUndefined();
    expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.ROOM_STATE, ROOM);
  });

  it('chat: 서비스가 만든 페이로드를 방 채널(보낸 사람 포함)에 보낸다', async () => {
    const payload = { playerId: 'p1', name: '방장', text: '안녕', at: 'now' };
    service.prepareChat.mockResolvedValue(payload);

    await gateway.handleChat(createClient(), { code: CODE, text: '안녕' });

    expect(serverTo).toHaveBeenCalledWith(CHANNEL);
    expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.CHAT_MESSAGE, payload);
  });

  describe('소켓별 직렬화 (리뷰 F2)', () => {
    const deferred = <T>() => {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    };
    const flush = () => new Promise((r) => setImmediate(r));
    const entered = { room: ROOM, playerId: 'p1', playerToken: 'tok', replacedSocketId: null, lobbyChanged: false };

    it('같은 소켓의 join A·B 동시 요청은 A가 끝난 뒤 B가 시작된다', async () => {
      const first = deferred<typeof entered>();
      const roomB = { ...ROOM, code: 'BBBBBB' };
      service.joinRoom.mockImplementationOnce(committingLater(first.promise)).mockImplementationOnce(committing({ ...entered, room: roomB }));
      service.leaveRoom.mockResolvedValue({ room: null, lobbyChanged: false });
      const client = createClient();

      const a = gateway.handleJoinRoom(client, { code: CODE, playerName: '나' });
      const b = gateway.handleJoinRoom(client, { code: 'BBBBBB', playerName: '나' });
      await flush();
      expect(service.joinRoom).toHaveBeenCalledTimes(1);

      first.resolve(entered);
      await Promise.all([a, b]);

      expect(service.joinRoom).toHaveBeenCalledTimes(2);
      // B는 A 입장 결과(client.data.room = A)를 보고 A에서 먼저 이탈한다 → 한 소켓이 두 방에 남지 않는다
      expect(service.leaveRoom).toHaveBeenCalledWith(CODE, 'sock-a');
      expect(client.data.room).toEqual({ code: 'BBBBBB', playerId: 'p1' });
    });

    it('입장 처리 중 끊기면 끊김 처리는 입장이 끝난 뒤 실행되어 그 방을 끊김으로 표시한다', async () => {
      const join = deferred<typeof entered>();
      service.joinRoom.mockImplementationOnce(committingLater(join.promise));
      service.markDisconnected.mockResolvedValue(null);
      const client = createClient();

      const joining = gateway.handleJoinRoom(client, { code: CODE, playerName: '나' });
      await flush();
      const disconnecting = gateway.handleDisconnect(client);
      await flush();
      expect(service.markDisconnected).not.toHaveBeenCalled();

      join.resolve(entered);
      await Promise.all([joining, disconnecting]);
      expect(service.markDisconnected).toHaveBeenCalledWith(CODE, 'sock-a');
    });

    it('listRooms도 큐에 들어가 진행 중인 입장 뒤에 실행된다(로비 재구독 경합 방지, 리뷰 G8)', async () => {
      const join = deferred<typeof entered>();
      service.joinRoom.mockImplementationOnce(committingLater(join.promise));
      const client = createClient();

      const joining = gateway.handleJoinRoom(client, { code: CODE, playerName: '나' });
      const listing = gateway.handleListRooms(client, {});
      await flush();
      expect(service.listRooms).not.toHaveBeenCalled();

      join.resolve(entered);
      await Promise.all([joining, listing]);
      expect(service.listRooms).toHaveBeenCalledTimes(1);
      // 순서: 입장의 로비 해제 → 목록 조회의 로비 구독
      const lobbyCalls = [...client.leave.mock.calls, ...client.join.mock.calls].filter(([room]) => room === LOBBY);
      expect(lobbyCalls).toHaveLength(2);
      expect(client.leave.mock.invocationCallOrder[0]).toBeLessThan(
        client.join.mock.invocationCallOrder[client.join.mock.calls.findIndex(([room]) => room === LOBBY)],
      );
    });

    it('앞 작업이 실패해도 다음 작업은 실행된다', async () => {
      service.setReady.mockRejectedValueOnce(new TetrisBattleError('NOT_IN_ROOM'));
      service.leaveRoom.mockResolvedValue({ room: null, lobbyChanged: false });
      const client = createClient();

      const failed = gateway.handleSetReady(client, { code: CODE, ready: true });
      const next = gateway.handleLeaveRoom(client, { code: CODE });

      await expect(failed).rejects.toMatchObject({ code: 'NOT_IN_ROOM' });
      await expect(next).resolves.toEqual({ ok: true, data: {} });
    });
  });

  describe('afterInit — 서비스 주입 (리뷰 F3·F7)', () => {
    it('생존 확인 함수는 방 채널 소켓을 조회해 id 집합을 돌려준다', async () => {
      const fetchSockets = jest.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
      const inFn = jest.fn(() => ({ fetchSockets }));
      gateway.server = { to: serverTo, in: inFn } as unknown as Server;
      const setProbe = jest.fn();
      const setListener = jest.fn();
      Object.assign(service, { setLiveSocketProbe: setProbe, setChangeListener: setListener, setMatchListener: jest.fn(), setSocketEvictor: jest.fn() });

      gateway.afterInit();
      gateway.onModuleDestroy();
      const probe = setProbe.mock.calls[0][0] as (code: string) => Promise<Set<string>>;

      await expect(probe(CODE)).resolves.toEqual(new Set(['s1', 's2']));
      expect(inFn).toHaveBeenCalledWith(CHANNEL);

      // 변경 알림 → roomState 방송
      const listener = setListener.mock.calls[0][0] as (c: string, r: RoomState | null, l: boolean) => void;
      listener(CODE, ROOM, false);
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.ROOM_STATE, ROOM);
    });
  });

  it('생존 확인은 어댑터가 응답하지 않아도 2초 자체 타이머로 끊는다 (리뷰 G1 — redis-adapter는 .timeout()을 무시)', async () => {
    jest.useFakeTimers();
    try {
      const fetchSockets = jest.fn(() => new Promise(() => undefined)); // 영원히 응답 없음
      gateway.server = { to: serverTo, in: jest.fn(() => ({ fetchSockets })) } as unknown as Server;
      const setProbe = jest.fn();
      Object.assign(service, { setLiveSocketProbe: setProbe, setChangeListener: jest.fn(), setMatchListener: jest.fn(), setSocketEvictor: jest.fn() });
      gateway.afterInit();
      gateway.onModuleDestroy();
      const probe = setProbe.mock.calls[0][0] as (code: string) => Promise<Set<string>>;

      const result = probe(CODE).then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      jest.advanceTimersByTime(1_999);
      await Promise.resolve();
      jest.advanceTimersByTime(1);
      await expect(result).resolves.toContain('2000ms 초과');
    } finally {
      jest.useRealTimers();
    }
  });

  describe('하트비트 (tetris-audit D-010·D-012)', () => {
    const init = () => {
      const local = { emit: jest.fn() };
      const disconnectSockets = jest.fn();
      const inFn = jest.fn(() => ({ disconnectSockets }));
      gateway.server = { to: serverTo, in: inFn, local } as unknown as Server;
      const setEvictor = jest.fn();
      Object.assign(service, { setLiveSocketProbe: jest.fn(), setChangeListener: jest.fn(), setMatchListener: jest.fn(), setSocketEvictor: setEvictor });
      gateway.afterInit();
      return { local, inFn, disconnectSockets, evict: setEvictor.mock.calls[0][0] as (ids: string[]) => void };
    };

    it(`이 레플리카의 소켓에만 ${4_000}ms마다 presencePing을 보내고, 종료 때 멈춘다`, () => {
      jest.useFakeTimers();
      try {
        const { local } = init();
        jest.advanceTimersByTime(4_000);
        expect(local.emit).toHaveBeenCalledWith(TetrisBattleServerEvents.PRESENCE_PING);
        gateway.onModuleDestroy();
        local.emit.mockClear();
        jest.advanceTimersByTime(8_000);
        expect(local.emit).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('하트비트가 끊긴 소켓은 서버에서 끊는다(재연결·토큰 복귀를 유도)', () => {
      const { evict, inFn, disconnectSockets } = init();
      gateway.onModuleDestroy();
      evict(['s1', 's2']);
      expect(inFn).toHaveBeenCalledWith(['s1', 's2']);
      expect(disconnectSockets).toHaveBeenCalledWith(false); // 이 namespace만(리뷰 R1)
    });

    it('heartbeat는 이 소켓이 들어가 있는 방일 때만 기록한다', async () => {
      Object.assign(service, { recordHeartbeat: jest.fn().mockResolvedValue(undefined) });
      const recordHeartbeat = (service as unknown as { recordHeartbeat: jest.Mock }).recordHeartbeat;

      await gateway.handleHeartbeat(createClient({ authResolved: true, userId: null, room: { code: CODE, playerId: 'p2' } }), { code: CODE });
      await gateway.handleHeartbeat(createClient({ authResolved: true, userId: null, room: { code: 'ZZZZZZ', playerId: 'p2' } }), { code: CODE });
      await gateway.handleHeartbeat(createClient(), { code: CODE });

      expect(recordHeartbeat.mock.calls).toEqual([[CODE, 'sock-a']]);
    });
  });

  describe('강퇴 (tetris-audit D-011)', () => {
    it('강퇴된 소켓을 채널에서 빼고 그 소켓에만 kicked를 보낸 뒤 방에 roomState', async () => {
      Object.assign(service, {
        kickPlayer: jest.fn().mockResolvedValue({ room: ROOM, lobbyChanged: true, kickedSocketId: 'sock-k' }),
      });

      await gateway.handleKickPlayer(createClient(), { code: CODE, playerId: 'p2' });

      expect(gateway.server.in).toHaveBeenCalledWith('sock-k');
      expect(socketsLeave).toHaveBeenCalledWith([CHANNEL, `tetris-battle:player:${CODE}:p2`]);
      expect(serverTo).toHaveBeenCalledWith('sock-k');
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.KICKED, { code: CODE });
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.ROOM_STATE, ROOM);
    });

    it('끊긴 자리를 내보내면(소켓 없음) kicked 없이 방송만', async () => {
      Object.assign(service, { kickPlayer: jest.fn().mockResolvedValue({ room: ROOM, lobbyChanged: true, kickedSocketId: null }) });
      await gateway.handleKickPlayer(createClient(), { code: CODE, playerId: 'p2' });
      expect(roomEmit).not.toHaveBeenCalledWith(TetrisBattleServerEvents.KICKED, expect.anything());
    });
  });

  describe('disconnect', () => {
    it('방에 있던 소켓이면 끊김 표시 후 roomState', async () => {
      service.markDisconnected.mockResolvedValue({ room: ROOM, lobbyChanged: false });
      await gateway.handleDisconnect(createClient({ room: { code: CODE, playerId: 'p1' } }));
      expect(service.markDisconnected).toHaveBeenCalledWith(CODE, 'sock-a');
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.ROOM_STATE, ROOM);
    });

    it('방에 없던 소켓이면 아무것도 하지 않는다', async () => {
      await gateway.handleDisconnect(createClient());
      expect(service.markDisconnected).not.toHaveBeenCalled();
    });

    it('서비스 오류는 삼킨다(끊김 처리가 예외로 새지 않게)', async () => {
      service.markDisconnected.mockRejectedValue(new TetrisBattleError('SERVICE_UNAVAILABLE'));
      await expect(gateway.handleDisconnect(createClient({ room: { code: CODE, playerId: 'p1' } }))).resolves.toBeUndefined();
    });
  });

  describe('매치 (P2)', () => {
    const MATCH = 'm'.repeat(16);
    const lockDto = { matchId: MATCH, seq: 1, frame: 10, sent: 2, combo: 0, b2b: false, tSpin: 'none' as const, lines: 2, pc: false, board: 'B', pending: 0 };
    const inRoom = () => createClient({ authResolved: true, userId: null, room: { code: CODE, playerId: 'p1' } });
    const noMatchEvents = { matchId: MATCH, kos: [], ended: null };
    let clientRoomEmit: jest.Mock;
    let clientTo: jest.Mock;

    const inRoomWithTo = () => {
      const client = inRoom();
      clientRoomEmit = jest.fn();
      clientTo = jest.fn(() => ({ emit: clientRoomEmit }));
      Object.assign(client, { to: clientTo });
      return client;
    };

    it('startMatch: 방에 matchStarting, roomState', async () => {
      const starting = { matchId: MATCH, seed: 1, startInMs: 3000, startAt: 'iso', players: [] };
      service.startMatch.mockResolvedValue({ room: ROOM, lobbyChanged: false, starting });

      await expect(gateway.handleStartMatch(inRoom(), { code: CODE })).resolves.toEqual({ ok: true, data: {} });

      expect(service.startMatch).toHaveBeenCalledWith(CODE, 'sock-a');
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.MATCH_STARTING, starting);
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.ROOM_STATE, ROOM);
    });

    it('lock: garbage는 대상 소켓에만, attack은 방, opponentUpdate는 보낸 사람 제외(client.to), ack는 다음 대상', async () => {
      const garbage = { matchId: MATCH, id: 1, lines: 2, hole: 3, from: 'p1' };
      const attack = { matchId: MATCH, from: 'p1', to: 'p2', lines: 2 };
      const update = { matchId: MATCH, playerId: 'p1', board: 'B', pending: 0, combo: 0, b2b: false };
      service.lock.mockResolvedValue({
        targetId: 'p3',
        duplicate: false,
        garbage: { toPlayerId: 'p2', payload: garbage },
        attack,
        opponentUpdate: update,
        match: noMatchEvents,
        roomChange: null,
      });
      const client = inRoomWithTo();

      await expect(gateway.handleLock(client, lockDto)).resolves.toEqual({ ok: true, data: { targetId: 'p3' } });

      expect(service.lock).toHaveBeenCalledWith(CODE, 'sock-a', lockDto);
      expect(serverTo).toHaveBeenCalledWith(`tetris-battle:player:${CODE}:p2`); // 소켓 id가 아니라 플레이어 채널
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.GARBAGE, garbage);
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.ATTACK, attack);
      expect(clientTo).toHaveBeenCalledWith(CHANNEL);
      expect(clientRoomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.OPPONENT_UPDATE, update);
    });

    it('lock: KO·종료는 KO 먼저 보낸다', async () => {
      const ko = { matchId: MATCH, playerId: 'p2', by: 'p1', place: 2, reason: 'topout' };
      const ended = { matchId: MATCH, results: [] };
      service.lock.mockResolvedValue({
        targetId: null,
        duplicate: false,
        garbage: null,
        attack: null,
        opponentUpdate: null,
        match: { matchId: MATCH, kos: [ko], ended },
        roomChange: { room: { ...ROOM, status: 'RESULT' }, lobbyChanged: true },
      });

      await gateway.handleLock(inRoomWithTo(), lockDto);

      const events = roomEmit.mock.calls.map(([e]) => e);
      expect(events.indexOf(TetrisBattleServerEvents.PLAYER_KO)).toBeLessThan(events.indexOf(TetrisBattleServerEvents.MATCH_ENDED));
      await new Promise((r) => setImmediate(r));
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.ROOM_STATE, expect.objectContaining({ status: 'RESULT' }));
    });

    it('lock·topOut: 방에 들어가 있지 않은 소켓이면 NOT_IN_ROOM (서비스 호출 없음)', async () => {
      await expect(gateway.handleLock(createClient(), lockDto)).rejects.toMatchObject({ code: 'NOT_IN_ROOM' });
      await expect(gateway.handleTopOut(createClient(), { matchId: MATCH, frame: 1 })).rejects.toMatchObject({ code: 'NOT_IN_ROOM' });
      expect(service.lock).not.toHaveBeenCalled();
      expect(service.topOut).not.toHaveBeenCalled();
    });

    it('lock은 소켓 큐로 순서대로 처리된다(앞 lock이 끝나야 다음 lock)', async () => {
      let release!: () => void;
      const outcome = { targetId: null, duplicate: false, garbage: null, attack: null, opponentUpdate: null, match: noMatchEvents, roomChange: null };
      service.lock.mockImplementationOnce(() => new Promise((r) => (release = () => r(outcome)))).mockResolvedValue(outcome);
      const client = inRoomWithTo();

      const first = gateway.handleLock(client, lockDto);
      const second = gateway.handleLock(client, { ...lockDto, seq: 2, frame: 20 });
      await new Promise((r) => setImmediate(r));
      expect(service.lock).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([first, second]);
      expect(service.lock).toHaveBeenCalledTimes(2);
    });

    it('topOut: KO 방송', async () => {
      const ko = { matchId: MATCH, playerId: 'p1', by: null, place: 2, reason: 'topout' };
      service.topOut.mockResolvedValue({ match: { matchId: MATCH, kos: [ko], ended: null }, roomChange: null });
      await gateway.handleTopOut(inRoom(), { matchId: MATCH, frame: 5 });
      expect(service.topOut).toHaveBeenCalledWith(CODE, 'sock-a', { matchId: MATCH, frame: 5 });
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.PLAYER_KO, ko);
    });

    it.each([
      ['ROOM_BUSY', new TetrisBattleError('ROOM_BUSY')],
      ['SERVICE_UNAVAILABLE', new TetrisBattleError('SERVICE_UNAVAILABLE')],
      ['Redis 오류', new Error('redis down')],
    ])('leaveRoom 커밋 전 실패(%s)면 채널·소켓 방 정보를 유지하고 오류 ack — 재시도로 정상 이탈 (리뷰 K1)', async (_label, error) => {
      service.leaveRoom.mockRejectedValue(error);
      const client = inRoom();
      await expect(gateway.handleLeaveRoom(client, { code: CODE })).rejects.toBe(error);
      expect(client.leave).not.toHaveBeenCalled();
      expect(client.data.room).toEqual({ code: CODE, playerId: 'p1' });
    });

    it.each(['NOT_IN_ROOM', 'ROOM_NOT_FOUND'] as const)(
      'leaveRoom이 %s면(이미 방에 없음) 채널을 정리하고 오류 ack (리뷰 K1)',
      async (errorCode) => {
        service.leaveRoom.mockRejectedValue(new TetrisBattleError(errorCode));
        const client = inRoom();
        await expect(gateway.handleLeaveRoom(client, { code: CODE })).rejects.toMatchObject({ code: errorCode });
        expect(client.leave).toHaveBeenCalledWith(CHANNEL);
        expect(client.leave).toHaveBeenCalledWith(`tetris-battle:player:${CODE}:p1`);
        expect(client.data.room).toBeUndefined();
      },
    );

    it('경기 중 leaveRoom: KO를 roomState보다 먼저 보낸다', async () => {
      const ko = { matchId: MATCH, playerId: 'p1', by: null, place: 2, reason: 'leave' };
      service.leaveRoom.mockResolvedValue({ room: ROOM, lobbyChanged: false, match: { matchId: MATCH, kos: [ko], ended: null } });
      await gateway.handleLeaveRoom(inRoom(), { code: CODE });
      const events = roomEmit.mock.calls.map(([e]) => e);
      expect(events.indexOf(TetrisBattleServerEvents.PLAYER_KO)).toBeLessThan(events.indexOf(TetrisBattleServerEvents.ROOM_STATE));
    });

    it('재연결 joinRoom: ack에 rejoin, 정리로 생긴 KO는 방송', async () => {
      const rejoin = { match: { matchId: MATCH, seed: 1, status: 'PLAYING', alive: true }, missedGarbage: [], opponents: [] };
      const ko = { matchId: MATCH, playerId: 'p3', by: null, place: 3, reason: 'disconnect' };
      service.joinRoom.mockImplementation(committing({
        room: ROOM,
        playerId: 'p2',
        playerToken: 't',
        replacedSocketId: null,
        lobbyChanged: false,
        rejoin,
        match: { matchId: MATCH, kos: [ko], ended: null },
      }));

      const ack = await gateway.handleJoinRoom(createClient(), { code: CODE, playerName: '나', playerToken: 't'.repeat(32), lastGarbageId: 3 });

      expect(ack).toEqual({ ok: true, data: { room: ROOM, playerId: 'p2', playerToken: 't', rejoin } });
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.PLAYER_KO, ko);
    });

    it('rematch: roomState 방송', async () => {
      service.rematch.mockResolvedValue({ room: ROOM, lobbyChanged: true });
      await gateway.handleRematch(inRoom(), { code: CODE });
      expect(service.rematch).toHaveBeenCalledWith(CODE, 'sock-a');
      expect(roomEmit).toHaveBeenCalledWith(TetrisBattleServerEvents.ROOM_STATE, ROOM);
    });
  });
});

describe('TetrisBattleWsExceptionFilter', () => {
  const filter = new TetrisBattleWsExceptionFilter();
  const host = (ack?: jest.Mock) => {
    const client = { id: 's', emit: jest.fn() };
    const h = {
      switchToWs: () => ({ getClient: () => client }),
      getArgs: () => [client, {}, ack, 'pattern'],
    } as unknown as ArgumentsHost;
    return { h, client };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['도메인 에러', new TetrisBattleError('ROOM_FULL'), 'ROOM_FULL'],
    ['DTO 검증 실패', new BadRequestException(['code must match']), 'INVALID_PAYLOAD'],
    ['예상 못 한 에러', new Error('db password=xxx'), 'INTERNAL_ERROR'],
  ])('%s → ack { ok: false, code: %s }', (_label, exception, code) => {
    const ack = jest.fn();
    const { h, client } = host(ack);
    filter.catch(exception, h);
    expect(ack).toHaveBeenCalledWith({ ok: false, code, message: expect.any(String) });
    expect(JSON.stringify(ack.mock.calls[0][0])).not.toContain('password=xxx');
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('ack 없이 보낸 요청이면 error 이벤트로 보낸다', () => {
    const { h, client } = host(undefined);
    filter.catch(new TetrisBattleError('NOT_IN_ROOM'), h);
    expect(client.emit).toHaveBeenCalledWith('error', {
      code: 'NOT_IN_ROOM',
      message: expect.any(String),
      timestamp: expect.any(String),
    });
  });
});

import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { sign } from 'jsonwebtoken';
import { Socket } from 'socket.io-client';
import { TetrisBattleGateway } from '../src/modules/tetris-battle/tetris-battle.gateway';
import { TetrisBattleRoomService } from '../src/modules/tetris-battle/tetris-battle-room.service';
import { TetrisBattleWsGuard } from '../src/modules/tetris-battle/tetris-battle-ws.guard';
import { TetrisBattleError } from '../src/modules/tetris-battle/tetris-battle.errors';
import {
  RoomState,
  TetrisBattleAck,
  TetrisBattleClientEvents as C,
  TetrisBattleServerEvents as S,
} from '../src/modules/tetris-battle/tetris-battle.events';
import { User } from '../src/entities/User';
import { createUser } from '../src/entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createWsApp, WsE2eApp, waitFor, expectNoEvent, emitWithAck } from './helpers/ws-e2e-app';
import { UserSkinService } from '../src/modules/users/user-skin.service';
import { UserPointService } from '../src/modules/users/user-point.service';
import { UserSkinLevel } from '../src/entities/UserSkinLevel';
import { UserPointLedger } from '../src/entities/UserPointLedger';
import { UserSkinEquip } from '../src/entities/UserSkinEquip';

const JWT_SECRET = 'e2e-ws-secret';
const NS = '/tetris-battle';
const USER = createUser({ userId: 42, userName: '테트리스왕' });
const CODE = 'ABCDEF';

const roomOf = (players: RoomState['players'], hostId = 'p1'): RoomState => ({
  code: CODE,
  name: '한판',
  maxPlayers: 4,
  locked: true,
  hostId,
  status: 'WAITING',
  players,
});
const P1 = { playerId: 'p1', name: '방장', ready: false, connected: true, isGuest: false, skins: { block: 'default', effect: 'default', board: 'default', levels: { block: 1, effect: 1, board: 1 } } };
const P2 = { playerId: 'p2', name: '도전자', ready: false, connected: true, isGuest: true, skins: { block: 'default', effect: 'default', board: 'default', levels: { block: 1, effect: 1, board: 1 } } };

type Ack<T = unknown> = TetrisBattleAck<T>;

/** joinRoom 대역 — 실제 서비스처럼 커밋 직후 afterCommit(게이트웨이의 채널 입장)을 부른다 */
const committing =
  <T>(result: T) =>
  async (_d: unknown, _w: unknown, _n: unknown, beforeCommit?: () => Promise<void>, afterCommit?: (e: T) => Promise<void>) => {
    await beforeCommit?.();
    await afterCommit?.(result);
    return result;
  };

/**
 * `/tetris-battle` 게이트웨이를 실제 소켓으로 검증한다 — 서비스(Redis 방 상태)는 경계에서 mock.
 * 방 규칙 자체(비밀번호·정원·이양·CAS)는 단위 테스트와 실제 Redis 스펙(`tetris-battle-room.redis.e2e-spec.ts`)이 본다.
 *
 * 여기서 노리는 것은 mock이 못 보는 **배선**이다:
 *  1. 실패가 **ack `{ ok:false, code }`로 돌아오는가** — 공용 WS 필터는 `error` 이벤트만 보내 ack 콜백이 영영 안 불린다
 *  2. DTO 검증 실패가 INVALID_PAYLOAD ack인가
 *  3. 가드가 실제 핸드셰이크 토큰으로 userId/게스트를 갈라 서비스에 넘기는가
 *  4. **브로드캐스트 대상** — roomState는 방 채널만, roomsChanged는 로비 구독자만, 입장하면 로비에서 빠지는가,
 *     멤버가 아니면 채팅이 아무에게도 가지 않는가
 */
describe('E2E WS 테트리스 대전 게이트웨이', () => {
  let ws: WsE2eApp;
  let service: Record<string, jest.Mock>;

  const connect = (token?: string) => ws.connect({ namespace: NS, ...(token ? { token } : {}) });

  beforeEach(async () => {
    const userRepository: MockRepository<User> = createMockRepository<User>();
    userRepository.findOne.mockImplementation(async (options) =>
      (options as { where: { userId: number } }).where.userId === USER.userId ? USER : null,
    );

    service = {
      listRooms: jest.fn().mockResolvedValue([]),
      createRoom: jest.fn(),
      joinRoom: jest.fn(),
      leaveRoom: jest.fn(),
      setReady: jest.fn(),
      markDisconnected: jest.fn().mockResolvedValue(null),
      prepareChat: jest.fn(),
      prepareEmote: jest.fn(),
      consumeRateLimit: jest.fn().mockResolvedValue(true),
      // afterInit이 주입한다
      setLiveSocketProbe: jest.fn(),
      setChangeListener: jest.fn(),
      setMatchListener: jest.fn(),
      setSocketEvictor: jest.fn(),
      startMatch: jest.fn(),
      rematch: jest.fn(),
      lock: jest.fn(),
      topOut: jest.fn(),
    };

    const skinEquipRepository = createMockRepository<UserSkinEquip>();
    skinEquipRepository.find.mockResolvedValue([]);
    ws = await createWsApp({
      gateways: [TetrisBattleGateway],
      providers: [
        TetrisBattleWsGuard,
        { provide: TetrisBattleRoomService, useValue: service },
        // 보드 주인 스킨 — 장착 없음(모두 default)
        UserSkinService,
        { provide: getRepositoryToken(UserSkinEquip), useValue: skinEquipRepository },
        // 스킨 레벨·포인트 (skin-levels D-002) — 강화 없음, 레벨 행 없음(모두 Lv1)
        { provide: getRepositoryToken(UserSkinLevel), useValue: { ...createMockRepository<UserSkinLevel>(), find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(UserPointLedger), useValue: createMockRepository<UserPointLedger>() },
        UserPointService,
        // UserSkinService 의존(게이트웨이는 장착 조회만 — 저장하지 않는다)
        { provide: getDataSourceToken(), useValue: {} },
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

  it('토큰이 있으면 userId, 없으면 게스트(null)로 서비스에 넘긴다', async () => {
    service.createRoom.mockResolvedValue({ room: roomOf([P1]), playerId: 'p1', playerToken: 't', replacedSocketId: null, lobbyChanged: true });
    const member = await connect(sign({ sub: USER.userId }, JWT_SECRET));
    const guest = await connect();

    await emitWithAck(member, C.CREATE_ROOM, { name: '한판', maxPlayers: 4, playerName: '방장' });
    await emitWithAck(guest, C.CREATE_ROOM, { name: '한판', maxPlayers: 4, playerName: '게스트' });

    expect(service.createRoom.mock.calls[0][1]).toEqual({ socketId: member.id, userId: USER.userId, ip: expect.any(String), skins: { block: 'default', effect: 'default', board: 'default', levels: { block: 1, effect: 1, board: 1 } } });
    expect(service.createRoom.mock.calls[1][1]).toEqual({ socketId: guest.id, userId: null, ip: expect.any(String), skins: { block: 'default', effect: 'default', board: 'default', levels: { block: 1, effect: 1, board: 1 } } });
  });

  it('로비 구독 → 방 생성 → 비번 입장: roomState는 방 멤버만, roomsChanged는 로비에 남은 소켓만 받는다', async () => {
    const host = await connect();
    const joiner = await connect();
    const lobbyWatcher = await connect();

    for (const s of [host, joiner, lobbyWatcher]) {
      await expect(emitWithAck(s, C.LIST_ROOMS, {})).resolves.toEqual({ ok: true, data: { rooms: [] } });
    }

    // 생성 — 방장은 로비에서 빠지고 방 채널로
    const summary = { code: CODE, name: '한판', playerCount: 1, maxPlayers: 4, locked: true, status: 'WAITING' };
    service.listRooms.mockResolvedValue([summary]);
    service.createRoom.mockResolvedValue({ room: roomOf([P1]), playerId: 'p1', playerToken: 'host-token', replacedSocketId: null, lobbyChanged: true });

    const watcherSawCreate = waitFor(lobbyWatcher, S.ROOMS_CHANGED);
    const joinerSawCreate = waitFor(joiner, S.ROOMS_CHANGED);
    const created = await emitWithAck<Ack>(host, C.CREATE_ROOM, { name: '한판', maxPlayers: 4, password: 'pw', playerName: '방장' });
    expect(created).toEqual({ ok: true, data: { room: roomOf([P1]), playerId: 'p1', playerToken: 'host-token' } });
    await expect(watcherSawCreate).resolves.toEqual({ rooms: [summary] });
    await joinerSawCreate;

    // 입장 — 방장은 roomState를 받고, 로비 감시자는 받지 않는다
    const joinedRoom = roomOf([P1, P2]);
    service.joinRoom.mockImplementation(committing({ room: joinedRoom, playerId: 'p2', playerToken: 'join-token', replacedSocketId: null, lobbyChanged: true }));
    const hostSawJoin = waitFor<RoomState>(host, S.ROOM_STATE);
    const joined = await emitWithAck<Ack>(joiner, C.JOIN_ROOM, { code: 'abcdef', password: 'pw', playerName: '도전자' });

    expect(joined).toEqual({ ok: true, data: { room: joinedRoom, playerId: 'p2', playerToken: 'join-token' } });
    expect(service.joinRoom.mock.calls[0][0]).toMatchObject({ code: CODE, password: 'pw' }); // 소문자 코드 정규화
    await expect(hostSawJoin).resolves.toEqual(joinedRoom);
    await expectNoEvent(lobbyWatcher, S.ROOM_STATE);

    // 입장한 소켓은 로비에서 빠졌다 — 이후 로비 변경을 받지 않는다
    service.createRoom.mockResolvedValue({ room: { ...roomOf([P1]), code: 'ZZZZZZ' }, playerId: 'p1', playerToken: 't', replacedSocketId: null, lobbyChanged: true });
    const third = await connect();
    const watcherSawSecond = waitFor(lobbyWatcher, S.ROOMS_CHANGED);
    await emitWithAck(third, C.CREATE_ROOM, { name: '두번째', maxPlayers: 2, playerName: '셋째' });
    await watcherSawSecond;
    await expectNoEvent(joiner, S.ROOMS_CHANGED);
  });

  it('listRooms는 페이로드 없이(ack 콜백만) 보내도 동작하고 로비를 구독한다', async () => {
    const summary = { code: CODE, name: '한판', playerCount: 1, maxPlayers: 4, locked: false, status: 'WAITING' };
    service.listRooms.mockResolvedValue([summary]);
    const s = await connect();

    const ack = await new Promise<Ack>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('listRooms ack 타임아웃')), 3000);
      s.emit(C.LIST_ROOMS, (res: Ack) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
    expect(ack).toEqual({ ok: true, data: { rooms: [summary] } });

    // 로비 구독 확인 — 다른 소켓의 생성이 roomsChanged로 온다
    service.createRoom.mockResolvedValue({ room: roomOf([P1]), playerId: 'p1', playerToken: 't', replacedSocketId: null, lobbyChanged: true });
    const saw = waitFor(s, S.ROOMS_CHANGED);
    await emitWithAck(await connect(), C.CREATE_ROOM, { name: '한판', maxPlayers: 4, playerName: '방장' });
    await expect(saw).resolves.toEqual({ rooms: [summary] });
  });

  it('서비스 거부는 ack { ok:false, code, message }로 돌아온다', async () => {
    service.joinRoom.mockRejectedValue(new TetrisBattleError('ROOM_WRONG_PASSWORD'));
    const s = await connect();

    const ack = await emitWithAck<Ack>(s, C.JOIN_ROOM, { code: CODE, password: 'x', playerName: '도전자' });

    expect(ack).toEqual({ ok: false, code: 'ROOM_WRONG_PASSWORD', message: '비밀번호가 맞지 않습니다.' });
  });

  it.each([
    ['createRoom 인원 5', C.CREATE_ROOM, { name: '방', maxPlayers: 5, playerName: '나' }],
    ['createRoom 이름 누락', C.CREATE_ROOM, { maxPlayers: 2, playerName: '나' }],
    ['joinRoom 코드 형식(혼동 문자 O)', C.JOIN_ROOM, { code: 'ABCDEO', playerName: '나' }],
    ['joinRoom 토큰 형식', C.JOIN_ROOM, { code: CODE, playerName: '나', playerToken: 'short' }],
    ['setReady ready 누락', C.SET_READY, { code: CODE }],
    ['chat 101자', C.CHAT, { code: CODE, text: '가'.repeat(101) }],
    ['chat 공백만', C.CHAT, { code: CODE, text: '   ' }],
    ['emote 프리셋 밖', C.EMOTE, { code: CODE, emoteId: 'custom' }],
  ])('%s → INVALID_PAYLOAD (서비스 호출 없음)', async (_label, event, payload) => {
    const s = await connect();
    const ack = await emitWithAck<Ack>(s, event, payload);
    expect(ack).toEqual({ ok: false, code: 'INVALID_PAYLOAD', message: expect.any(String) });
    for (const name of ['createRoom', 'joinRoom', 'setReady', 'prepareChat', 'prepareEmote', 'consumeRateLimit']) {
      expect(service[name]).not.toHaveBeenCalled();
    }
  });

  it('채팅: 멤버면 방 전원(보낸 사람 포함)이 받고, 비멤버는 NOT_IN_ROOM ack + 아무에게도 안 간다', async () => {
    service.createRoom.mockResolvedValue({ room: roomOf([P1]), playerId: 'p1', playerToken: 't', replacedSocketId: null, lobbyChanged: false });
    const host = await connect();
    await emitWithAck(host, C.CREATE_ROOM, { name: '한판', maxPlayers: 4, playerName: '방장' });

    const payload = { playerId: 'p1', name: '방장', text: '안녕', at: '2026-10-22T00:00:00.000Z' };
    service.prepareChat.mockImplementation(async (_code: string, socketId: string) => {
      if (socketId !== host.id) throw new TetrisBattleError('NOT_IN_ROOM');
      return payload;
    });

    const hostGotOwn = waitFor(host, S.CHAT_MESSAGE);
    await expect(emitWithAck(host, C.CHAT, { code: CODE, text: '  안녕  ' })).resolves.toEqual({ ok: true, data: {} });
    await expect(hostGotOwn).resolves.toEqual(payload);
    expect(service.prepareChat).toHaveBeenLastCalledWith(CODE, host.id, '안녕'); // trim

    const outsider: Socket = await connect();
    await expect(emitWithAck(outsider, C.CHAT, { code: CODE, text: '끼어들기' })).resolves.toEqual({
      ok: false,
      code: 'NOT_IN_ROOM',
      message: expect.any(String),
    });
    await expectNoEvent(host, S.CHAT_MESSAGE);
  });

  it('이모트: 방 채널로 emoteReceived', async () => {
    service.createRoom.mockResolvedValue({ room: roomOf([P1]), playerId: 'p1', playerToken: 't', replacedSocketId: null, lobbyChanged: false });
    service.prepareEmote.mockResolvedValue({ playerId: 'p1', emoteId: 'gg', at: 'now' });
    const host = await connect();
    await emitWithAck(host, C.CREATE_ROOM, { name: '한판', maxPlayers: 4, playerName: '방장' });

    const got = waitFor(host, S.EMOTE_RECEIVED);
    await emitWithAck(host, C.EMOTE, { code: CODE, emoteId: 'gg' });
    await expect(got).resolves.toEqual({ playerId: 'p1', emoteId: 'gg', at: 'now' });
  });

  it('이탈하면 방 채널에서 빠져 이후 roomState를 받지 않는다 · 남은 사람은 이양된 roomState를 받는다', async () => {
    service.createRoom.mockResolvedValue({ room: roomOf([P1]), playerId: 'p1', playerToken: 't', replacedSocketId: null, lobbyChanged: false });
    service.joinRoom.mockImplementation(committing({ room: roomOf([P1, P2]), playerId: 'p2', playerToken: 't2', replacedSocketId: null, lobbyChanged: false }));
    const host = await connect();
    const joiner = await connect();
    await emitWithAck(host, C.CREATE_ROOM, { name: '한판', maxPlayers: 4, playerName: '방장' });
    await emitWithAck(joiner, C.JOIN_ROOM, { code: CODE, playerName: '도전자' });

    const transferred = roomOf([P2], 'p2');
    service.leaveRoom.mockResolvedValue({ room: transferred, lobbyChanged: true });
    const joinerSaw = waitFor<RoomState>(joiner, S.ROOM_STATE);
    await expect(emitWithAck(host, C.LEAVE_ROOM, { code: CODE })).resolves.toEqual({ ok: true, data: {} });
    await expect(joinerSaw).resolves.toEqual(transferred);

    service.setReady.mockResolvedValue({ room: { ...transferred, players: [{ ...P2, ready: true }] }, lobbyChanged: false });
    await emitWithAck(joiner, C.SET_READY, { code: CODE, ready: true });
    await expectNoEvent(host, S.ROOM_STATE);
  });

  it('방에 있던 소켓이 끊기면 markDisconnected(소켓 id)', async () => {
    service.createRoom.mockResolvedValue({ room: roomOf([P1]), playerId: 'p1', playerToken: 't', replacedSocketId: null, lobbyChanged: false });
    const host = await connect();
    const hostId = host.id;
    await emitWithAck(host, C.CREATE_ROOM, { name: '한판', maxPlayers: 4, playerName: '방장' });

    host.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    expect(service.markDisconnected).toHaveBeenCalledWith(CODE, hostId);
  });

  describe('매치 (P2) — 방송 대상', () => {
    const MATCH = 'M'.repeat(16);
    const BOARD = Buffer.alloc(200).toString('base64');
    const P3 = { playerId: 'p3', name: '셋째', ready: false, connected: true, isGuest: true, skins: { block: 'default', effect: 'default', board: 'default', levels: { block: 1, effect: 1, board: 1 } } };
    const lockPayload = { matchId: MATCH, seq: 1, frame: 30, sent: 2, combo: 0, b2b: false, tSpin: 'none', lines: 2, pc: false, board: BOARD, pending: 0 };

    /** 3인이 같은 방 채널에 들어간 상태 */
    const threeInRoom = async () => {
      service.createRoom.mockResolvedValue({ room: roomOf([P1]), playerId: 'p1', playerToken: 't', replacedSocketId: null, lobbyChanged: false });
      const host = await connect();
      await emitWithAck(host, C.CREATE_ROOM, { name: '한판', maxPlayers: 4, playerName: '방장' });
      const others: Socket[] = [];
      for (const p of [P2, P3]) {
        service.joinRoom.mockImplementationOnce(committing({ room: roomOf([P1, p]), playerId: p.playerId, playerToken: 't', replacedSocketId: null, lobbyChanged: false }));
        const s = await connect();
        await emitWithAck(s, C.JOIN_ROOM, { code: CODE, playerName: p.name });
        others.push(s);
      }
      return { host, p2: others[0], p3: others[1] };
    };

    it('시작→lock→garbage는 대상만·attack은 전원·opponentUpdate는 보낸 사람 제외→topOut→playerKO·matchEnded 전원→rematch', async () => {
      const { host, p2, p3 } = await threeInRoom();

      // 시작 — 전원 matchStarting
      const starting = { matchId: MATCH, seed: 7, startInMs: 3000, startAt: 'iso', players: [] };
      service.startMatch.mockResolvedValue({ room: { ...roomOf([P1, P2, P3]), status: 'PLAYING' }, lobbyChanged: true, starting });
      const allStarting = Promise.all([host, p2, p3].map((s) => waitFor(s, S.MATCH_STARTING)));
      await expect(emitWithAck(host, C.START_MATCH, { code: CODE })).resolves.toEqual({ ok: true, data: {} });
      expect(await allStarting).toEqual([starting, starting, starting]);

      // lock — 대상 p2 소켓에만 garbage
      const garbage = { matchId: MATCH, id: 1, lines: 2, hole: 5, from: 'p1' };
      const attack = { matchId: MATCH, from: 'p1', to: 'p2', lines: 2 };
      const update = { matchId: MATCH, playerId: 'p1', board: BOARD, pending: 0, combo: 0, b2b: false };
      service.lock.mockResolvedValue({
        targetId: 'p3',
        duplicate: false,
        garbage: { toPlayerId: 'p2', payload: garbage },
        attack,
        opponentUpdate: update,
        match: { matchId: MATCH, kos: [], ended: null },
        roomChange: null,
      });
      const p2Garbage = waitFor(p2, S.GARBAGE);
      const attacks = Promise.all([host, p2, p3].map((s) => waitFor(s, S.ATTACK)));
      const updates = Promise.all([p2, p3].map((s) => waitFor(s, S.OPPONENT_UPDATE)));

      await expect(emitWithAck(host, C.LOCK, lockPayload)).resolves.toEqual({ ok: true, data: { targetId: 'p3' } });
      expect(service.lock).toHaveBeenCalledWith(CODE, host.id, expect.objectContaining({ matchId: MATCH, seq: 1, sent: 2 }));
      await expect(p2Garbage).resolves.toEqual(garbage);
      expect(await attacks).toEqual([attack, attack, attack]);
      expect(await updates).toEqual([update, update]);
      await Promise.all([expectNoEvent(p3, S.GARBAGE), expectNoEvent(host, S.GARBAGE), expectNoEvent(host, S.OPPONENT_UPDATE)]);

      // topOut — KO·종료는 전원
      const ko = { matchId: MATCH, playerId: 'p2', by: 'p1', place: 3, reason: 'topout' };
      const ended = { matchId: MATCH, results: [{ playerId: 'p1', name: '방장', place: 1, kos: 1, sent: 2, received: 0, pieces: 1, maxCombo: 0, frames: 30 }] };
      service.topOut.mockResolvedValue({
        match: { matchId: MATCH, kos: [ko], ended },
        roomChange: { room: { ...roomOf([P1, P2, P3]), status: 'RESULT' }, lobbyChanged: true },
      });
      const kos = Promise.all([host, p2, p3].map((s) => waitFor(s, S.PLAYER_KO)));
      const endeds = Promise.all([host, p2, p3].map((s) => waitFor(s, S.MATCH_ENDED)));
      await expect(emitWithAck(p2, C.TOP_OUT, { matchId: MATCH, frame: 99 })).resolves.toEqual({ ok: true, data: {} });
      expect(service.topOut).toHaveBeenCalledWith(CODE, p2.id, { matchId: MATCH, frame: 99 });
      expect(await kos).toEqual([ko, ko, ko]);
      expect(await endeds).toEqual([ended, ended, ended]);

      // rematch — 전원 WAITING roomState
      const waiting = roomOf([P1, P2, P3]);
      service.rematch.mockResolvedValue({ room: waiting, lobbyChanged: true });
      const states = Promise.all([host, p2, p3].map((s) => waitFor<RoomState>(s, S.ROOM_STATE)));
      await expect(emitWithAck(host, C.REMATCH, { code: CODE })).resolves.toEqual({ ok: true, data: {} });
      expect((await states).map((r) => r.status)).toEqual(['WAITING', 'WAITING', 'WAITING']);
    });

    it.each([
      ['sent 23(MAX_ATTACK 초과)', { sent: 23 }],
      ['판 길이', { board: 'AAAA' }],
      ['tSpin 값', { tSpin: 'double' }],
      ['matchId 형식', { matchId: 'short' }],
      ['seq 0', { seq: 0 }],
    ])('lock 형식 오류(%s) → INVALID_PAYLOAD, 서비스 호출 없음', async (_label, patch) => {
      const { host } = await threeInRoom();
      await expect(emitWithAck(host, C.LOCK, { ...lockPayload, ...patch })).resolves.toMatchObject({ ok: false, code: 'INVALID_PAYLOAD' });
      expect(service.lock).not.toHaveBeenCalled();
    });

    it('방에 들어가지 않은 소켓의 lock → NOT_IN_ROOM', async () => {
      const outsider = await connect();
      await expect(emitWithAck(outsider, C.LOCK, lockPayload)).resolves.toMatchObject({ ok: false, code: 'NOT_IN_ROOM' });
    });
  });
});

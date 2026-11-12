import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import { Socket } from 'socket.io-client';
import { User } from '../src/entities/User';
import { createMockRepository } from '../src/common/__spec__/mock-repository';
import { FortressGateway } from '../src/modules/fortress/fortress.gateway';
import { FortressSkinService } from '../src/modules/fortress/fortress-skin.service';
import { FortressLobbyChatService } from '../src/modules/fortress/fortress-lobby-chat.service';
import { FortressMatchService } from '../src/modules/fortress/fortress-match.service';
import { FortressRoomService } from '../src/modules/fortress/fortress-room.service';
import { FortressWsGuard } from '../src/modules/fortress/fortress-ws.guard';
import {
  EnterRoomAckData,
  FortressAck,
  JoinLobbyChatAckData,
  LobbyChatAckData,
  LobbyChatMessage,
  FortressClientEvents as C,
  FortressServerEvents as S,
  MatchEndedPayload,
  MatchSnapshot,
  MatchStartingPayload,
  RoomState,
  TurnResolvedPayload,
} from '../src/modules/fortress/fortress.events';
import { applyAction, createMatch, stateHash } from '../src/modules/fortress/engine';
import { createRedisMock } from '../src/modules/fortress/__spec__/redis-mock';
import { createWsApp, emitWithAck, waitFor, WsE2eApp } from './helpers/ws-e2e-app';

/** matchStarting.startAt(시작 카운트다운 끝)까지 실제로 기다린다 — 그 전 제출은 MATCH_NOT_STARTED */
const untilStart = (startAt: string) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(startAt) - Date.now())));

const NS = '/fortress';
type Ack<T = unknown> = FortressAck<T>;

/**
 * `/fortress` 전체 흐름을 실제 소켓 4개 + 실제 게이트웨이·방·경기 서비스로 — Redis만 메모리 대역(Lua 의미 흉내).
 * 실제 Redis·Lua 본문·두 레플리카는 opt-in `fortress-match.redis.e2e-spec.ts`가 본다. 이 스펙은 Redis 없이 항상 돈다.
 *
 * 노리는 것(mock 게이트웨이 spec이 못 보는 배선): 실제 ValidationPipe → INVALID_PAYLOAD ack, 방 채널 브로드캐스트 대상,
 * 경기 서비스 리스너 → 게이트웨이 → 전원 수신, 엔진 결과(해시)가 클라이언트에서 재현되는가
 */
describe('E2E WS 포트리스 — 생성부터 경기 끝까지', () => {
  let ws: WsE2eApp;
  let matches: FortressMatchService;
  let mock: ReturnType<typeof createRedisMock>;

  beforeEach(async () => {
    const userRepository = createMockRepository<User>();
    userRepository.findOne.mockResolvedValue(null);
    ws = await createWsApp({
      gateways: [FortressGateway],
      providers: [
        FortressRoomService,
        FortressMatchService,
        FortressLobbyChatService,
        FortressWsGuard,
        // F7: 입장 때 탱크 스킨 조회 — 이 E2E는 게스트라 부르지 않는다
        { provide: FortressSkinService, useValue: { tankSkinOf: jest.fn() } },
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
      ],
    });
    mock = createRedisMock();
    ws.moduleRef.get(FortressLobbyChatService).setRedisClient(mock.redis as unknown as Redis);
    matches = ws.moduleRef.get(FortressMatchService);
    matches.setRedisClient(mock.redis as unknown as Redis);
    // 실제 타이머 대신 테스트가 마감 시각으로 직접 깨운다(25초를 기다리지 않게)
    matches.setWakeScheduler(() => undefined);
    const rooms = ws.moduleRef.get(FortressRoomService);
    rooms.setRedisClient(mock.redis as unknown as Redis);
    rooms.setWakeScheduler(() => undefined);
  });

  afterEach(async () => {
    await ws.close();
  });

  const connect = () => ws.connect({ namespace: NS });
  const ok = <T>(ack: Ack<T>): T => {
    if (!ack.ok) throw new Error(`ack 실패: ${ack.code} ${ack.message}`);
    return ack.data;
  };

  it('팀전 4인: 생성 → 입장 → 팀·탱크 → 준비 → 시작 → 카운트다운 → 턴 → 시간 초과 skip → 이탈 resign → 경기 끝', async () => {
    const [a, b, c, d] = await Promise.all([connect(), connect(), connect(), connect()]);
    const sockets: Record<string, Socket> = {};

    const created = ok(
      await emitWithAck<Ack<EnterRoomAckData>>(a, C.CREATE_ROOM, { name: '팀전', mode: 'team', mapId: 'random', maxPlayers: 2, playerName: '방장' }),
    );
    expect(created.room).toMatchObject({ mode: 'team', maxPlayers: 4, mapId: 'random' });
    const code = created.room.code;
    sockets[created.playerId] = a;
    for (const [s, name] of [
      [b, '둘'],
      [c, '셋'],
      [d, '넷'],
    ] as const) {
      const entered = ok(await emitWithAck<Ack<EnterRoomAckData>>(s, C.JOIN_ROOM, { code, playerName: name }));
      sockets[entered.playerId] = s;
    }

    // 팀 자동 배정 0,1,0,1 — 이미 2명인 팀은 TEAM_FULL, 탱크 변경은 방 전원에게 roomState
    const full = await emitWithAck<Ack>(b, C.SET_TEAM, { code, team: 0 });
    expect(full).toMatchObject({ ok: false, code: 'TEAM_FULL' });
    const tankState = waitFor<RoomState>(a, S.ROOM_STATE);
    ok(await emitWithAck<Ack>(d, C.SET_TANK, { code, tankId: 2 }));
    expect((await tankState).players.map((p) => [p.extra.team, p.extra.tankId])).toEqual([
      [0, 0],
      [1, 0],
      [0, 0],
      [1, 2],
    ]);
    // 실제 ValidationPipe: 범위 밖 탱크 → INVALID_PAYLOAD ack
    expect(await emitWithAck<Ack>(d, C.SET_TANK, { code, tankId: 7 })).toMatchObject({ ok: false, code: 'INVALID_PAYLOAD' });

    expect(await emitWithAck<Ack>(a, C.START_MATCH, { code })).toMatchObject({ ok: false, code: 'NOT_ALL_READY' });
    for (const s of [b, c, d]) ok(await emitWithAck<Ack>(s, C.SET_READY, { code, ready: true }));

    const startingAll = [a, b, c, d].map((s) => waitFor<MatchStartingPayload>(s, S.MATCH_STARTING));
    ok(await emitWithAck<Ack>(a, C.START_MATCH, { code }));
    const starting = await startingAll[0];
    await Promise.all(startingAll);
    expect(['hills', 'canyon']).toContain(starting.config.mapId);
    expect(starting.config.players.map((p) => [p.team, p.tankId])).toEqual([
      [0, 0],
      [1, 0],
      [0, 0],
      [1, 2],
    ]);
    const engine = createMatch(starting.config);
    if (!engine.ok) throw new Error('config');
    expect(starting.turn).toMatchObject({ seq: 0, turnNo: 0, slot: engine.state.turn.slot });

    const socketOfSlot = (slot: number) => sockets[starting.slots[slot].playerId];
    const { matchId } = starting;
    let state = engine.state;

    // 1) 턴 주인 아닌 사람 → NOT_YOUR_TURN, 형식 오류 → INVALID_PAYLOAD
    const owner = socketOfSlot(starting.turn.slot);
    const notOwner = socketOfSlot((starting.turn.slot + 1) % 4);
    const fire = { matchId, seq: 0, move: 0, angle: 70, power: 60, weaponId: 0 };
    expect(await emitWithAck<Ack>(notOwner, C.TURN_SUBMIT, fire)).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(await emitWithAck<Ack>(owner, C.TURN_SUBMIT, { ...fire, angle: 1.5 })).toMatchObject({ ok: false, code: 'INVALID_PAYLOAD' });
    // 시작 카운트다운 중에는 턴 주인도 못 쏜다 → startAt까지 기다린다(D-021)
    expect(await emitWithAck<Ack>(owner, C.TURN_SUBMIT, fire)).toMatchObject({ ok: false, code: 'MATCH_NOT_STARTED' });
    await untilStart(starting.startAt);

    // 2) 턴 주인 fire → 전원 turnResolved, 클라이언트 엔진으로 같은 해시
    const resolvedAll = [a, b, c, d].map((s) => waitFor<TurnResolvedPayload>(s, S.TURN_RESOLVED));
    expect(await emitWithAck<Ack>(owner, C.TURN_SUBMIT, fire)).toEqual({ ok: true, data: {} });
    const first = await resolvedAll[0];
    await Promise.all(resolvedAll);
    const applied = applyAction(state, first.action);
    if (!applied.ok) throw new Error(applied.reason);
    state = applied.state;
    expect(first).toMatchObject({ seq: 0, cause: 'player', stateHash: stateHash(state), next: { seq: 1, slot: state.turn.slot } });
    // 늦은 재전송 → TURN_MISMATCH
    expect(await emitWithAck<Ack>(owner, C.TURN_SUBMIT, fire)).toMatchObject({ ok: false, code: 'TURN_MISMATCH' });

    // 3) 마감 초과 → 서버 skip(timeout) — 타이머 대신 마감 시각으로 깨운다
    const skipped = waitFor<TurnResolvedPayload>(a, S.TURN_RESOLVED);
    await matches.processDue(matchId, Date.parse((first.next as NonNullable<typeof first.next>).deadlineAt));
    const skip = await skipped;
    expect(skip).toMatchObject({ seq: 1, action: { kind: 'skip' }, cause: 'timeout' });
    const afterSkip = applyAction(state, skip.action);
    if (!afterSkip.ok) throw new Error(afterSkip.reason);
    state = afterSkip.state;
    expect(skip.stateHash).toBe(stateHash(state));

    // 4) resync — 행동 재적용으로 같은 해시
    const snap = ok(await emitWithAck<Ack<MatchSnapshot>>(c, C.RESYNC, { matchId, seq: 2, clientHash: stateHash(state) }));
    expect(snap).toMatchObject({ matchId, actions: [first.action, { kind: 'skip' }], stateHash: stateHash(state), turn: { seq: 2 } });

    // 5) 경기 중 채팅은 전원 허용
    const chat = waitFor<{ text: string }>(b, S.CHAT_MESSAGE);
    ok(await emitWithAck<Ack>(d, C.CHAT, { code, text: '좋은 샷' }));
    expect((await chat).text).toBe('좋은 샷');

    // 6) 팀 1(slot 1·3)이 모두 나가면 팀 0 승 — resign(leave) 두 번, matchEnded·roomState(RESULT)
    const endedAt = waitFor<MatchEndedPayload>(a, S.MATCH_ENDED);
    const resultState = new Promise<RoomState>((resolve) => {
      const handler = (room: RoomState) => {
        if (room.status !== 'RESULT') return;
        a.off(S.ROOM_STATE, handler);
        resolve(room);
      };
      a.on(S.ROOM_STATE, handler);
    });
    ok(await emitWithAck<Ack>(socketOfSlot(1), C.LEAVE_ROOM, { code }));
    ok(await emitWithAck<Ack>(socketOfSlot(3), C.LEAVE_ROOM, { code }));
    const ended = await endedAt;
    expect(ended.result).toMatchObject({ kind: 'win', team: 0 });
    expect(ended.players.map((p) => [p.slot, p.team, p.place])).toEqual([
      [0, 0, 1],
      [2, 0, 1],
      [1, 1, 2],
      [3, 1, 2],
    ]);
    expect((await resultState).players).toHaveLength(2);

    // 7) 재대결 → WAITING
    ok(await emitWithAck<Ack>(a, C.REMATCH, { code }));
  }, 15_000);

  it('로비 전체 채팅(D-016): 구독한 두 클라이언트가 같은 메시지를 받고, 구독 안 한 소켓은 LOBBY_CHAT_NOT_JOINED · 포트리스 키에만 남는다', async () => {
    const [a, b, outsider] = await Promise.all([connect(), connect(), connect()]);

    expect(await emitWithAck<Ack>(outsider, C.LOBBY_CHAT, { text: '안녕', name: '손님' })).toMatchObject({ ok: false, code: 'LOBBY_CHAT_NOT_JOINED' });

    const joinedA = ok(await emitWithAck<Ack<JoinLobbyChatAckData>>(a, C.JOIN_LOBBY_CHAT, undefined));
    expect(joinedA).toMatchObject({ messages: [], onlineCount: 1, me: { isGuest: true, name: null } });
    const joinedB = ok(await emitWithAck<Ack<JoinLobbyChatAckData>>(b, C.JOIN_LOBBY_CHAT, undefined));
    expect(joinedB.onlineCount).toBe(2);

    const atA = waitFor<LobbyChatMessage>(a, S.LOBBY_CHAT_MESSAGE);
    const atB = waitFor<LobbyChatMessage>(b, S.LOBBY_CHAT_MESSAGE);
    const sent = ok(await emitWithAck<Ack<LobbyChatAckData>>(a, C.LOBBY_CHAT, { text: '  포트리스 한판?  ', name: '손님' })).message;
    expect(sent).toMatchObject({ name: '손님', isGuest: true, text: '포트리스 한판?', senderKey: joinedA.me.senderKey });
    expect(await atA).toEqual(sent);
    expect(await atB).toEqual(sent);

    // 실제 ValidationPipe: 빈 문장 → INVALID_PAYLOAD
    expect(await emitWithAck<Ack>(b, C.LOBBY_CHAT, { text: '   ', name: '손님' })).toMatchObject({ ok: false, code: 'INVALID_PAYLOAD' });
    // 나간 뒤에는 보낼 수 없다
    ok(await emitWithAck<Ack>(b, C.LEAVE_LOBBY_CHAT, undefined));
    expect(await emitWithAck<Ack>(b, C.LOBBY_CHAT, { text: '또', name: '손님' })).toMatchObject({ ok: false, code: 'LOBBY_CHAT_NOT_JOINED' });

    // 기록은 포트리스 키에만(테트리스 로비 채팅과 섞이지 않는다)
    expect(mock.lists.get('fortress:lobby-chat:recent')).toHaveLength(1);
    expect(mock.lists.has('tetris-battle:lobby-chat:recent')).toBe(false);
    const late = await connect();
    expect(ok(await emitWithAck<Ack<JoinLobbyChatAckData>>(late, C.JOIN_LOBBY_CHAT, undefined)).messages).toEqual([sent]);
  });

  it('ffa 2인: 연속 3회 시간 초과면 탈락으로 끝난다', async () => {
    const [a, b] = await Promise.all([connect(), connect()]);
    const created = ok(await emitWithAck<Ack<EnterRoomAckData>>(a, C.CREATE_ROOM, { name: '개인전', mode: 'ffa', mapId: 'canyon', maxPlayers: 2, playerName: '방장' }));
    const code = created.room.code;
    ok(await emitWithAck<Ack>(b, C.JOIN_ROOM, { code, playerName: '도전자' }));
    expect(await emitWithAck<Ack>(b, C.JOIN_ROOM, { code: 'ZZZZZZ', playerName: '도전자' })).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' });
    ok(await emitWithAck<Ack>(b, C.SET_READY, { code, ready: true }));
    const startingP = waitFor<MatchStartingPayload>(b, S.MATCH_STARTING);
    ok(await emitWithAck<Ack>(a, C.START_MATCH, { code }));
    const starting = await startingP;

    const endedP = waitFor<MatchEndedPayload>(b, S.MATCH_ENDED);
    let deadline = Date.parse(starting.turn.deadlineAt);
    const causes: string[] = [];
    b.on(S.TURN_RESOLVED, (r: TurnResolvedPayload) => {
      causes.push(r.cause);
      if (r.next) deadline = Date.parse(r.next.deadlineAt);
    });
    for (let i = 0; i < 5; i++) {
      const next = waitFor<TurnResolvedPayload>(b, S.TURN_RESOLVED);
      await matches.processDue(starting.matchId, deadline);
      await next;
    }
    const ended = await endedP;
    expect(causes).toEqual(['timeout', 'timeout', 'timeout', 'timeout', 'timeout']);
    expect(ended.players.map((p) => p.place)).toEqual([1, 2]);
    expect(ended.players[1].hp).toBe(0);
  });
});

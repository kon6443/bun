import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { TetrisBattleGateway } from '../src/modules/tetris-battle/tetris-battle.gateway';
import { ROOM_CAS_SCRIPT, TetrisBattleRoomService } from '../src/modules/tetris-battle/tetris-battle-room.service';
import { TetrisBattleWsGuard } from '../src/modules/tetris-battle/tetris-battle-ws.guard';
import { TetrisBattleError } from '../src/modules/tetris-battle/tetris-battle.errors';
import {
  EnterRoomAckData,
  GarbagePayload,
  MatchEndedPayload,
  MatchStartingPayload,
  RoomState,
  RoomsChangedPayload,
  TetrisBattleAck,
  TetrisBattleClientEvents as C,
  TetrisBattleServerEvents as S,
} from '../src/modules/tetris-battle/tetris-battle.events';
import { User } from '../src/entities/User';
import { createMockRepository } from '../src/common/__spec__/mock-repository';
import { createWsApp, WsE2eApp, waitFor, expectNoEvent, emitWithAck } from './helpers/ws-e2e-app';

/**
 * 실제 Redis 대상 대전 방 검증 — **opt-in**.
 *
 * CI·기본 E2E에는 Redis가 없으므로 `TETRIS_BATTLE_REDIS_TEST_PORT`가 있을 때만 돈다.
 * 로컬: `TETRIS_BATTLE_REDIS_TEST_PORT=6380 pnpm test:e2e -- --testPathPatterns tetris-battle`
 * 모든 키는 실행마다 다른 프리픽스(`tbtest:<난수>:`) 아래에 쓰고 끝나면 지운다(남아도 전부 TTL). 운영 Redis를 가리키지 말 것.
 *
 * mock이 못 보는 것:
 *  1. CAS Lua 본문의 의미 — 버전 불일치 거부, 생성 시 기존 키 거부, 키 TTL
 *  2. 두 "레플리카"(서비스 인스턴스 2개·연결 2개)가 같은 방에 동시에 입장해도 정원을 넘지 않는다
 *  3. 실제 소켓 + 실제 서비스 + 실제 Redis로 로비→생성→비번 입장→ready→채팅→이탈·이양→재연결 전체 흐름
 */
const port = Number(process.env.TETRIS_BATTLE_REDIS_TEST_PORT);
const describeIfRedis = port ? describe : describe.skip;

const PREFIX = `tbtest:${Date.now()}:${Math.random().toString(36).slice(2, 8)}:`;

const openClient = () => new Redis({ host: '127.0.0.1', port, keyPrefix: PREFIX, lazyConnect: false });
const waitReady = (client: Redis) =>
  new Promise<void>((resolve, reject) => {
    if (client.status === 'ready') return resolve();
    const timer = setTimeout(() => reject(new Error('Redis 연결 대기 초과')), 3000);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TetrisBattleError ? e.code : `UNEXPECTED:${String(e)}`),
  );

describeIfRedis('테트리스 대전 방 — 실제 Redis', () => {
  const clients: Redis[] = [];
  let replicaA: TetrisBattleRoomService;
  let replicaB: TetrisBattleRoomService;

  beforeAll(async () => {
    replicaA = new TetrisBattleRoomService();
    replicaB = new TetrisBattleRoomService();
    const a = openClient();
    const b = openClient();
    clients.push(a, b);
    await Promise.all([waitReady(a), waitReady(b)]);
    replicaA.setRedisClient(a);
    replicaB.setRedisClient(b);
  });

  afterAll(async () => {
    const raw = new Redis({ host: '127.0.0.1', port });
    const keys = await raw.keys(`${PREFIX}*`);
    if (keys.length) await raw.del(...keys);
    await raw.quit();
    await Promise.all(clients.map((c) => c.quit()));
  });

  describe('CAS Lua', () => {
    it('기대 버전이 다르면 쓰지 않고, 같으면 쓰고 버전을 올린다 · 생성(0)은 키가 있으면 거부', async () => {
      const redis = clients[0];
      const key = 'tetris-battle:room:LUATST';
      const lobby = 'tetris-battle:rooms';
      const cas = (expected: string, json: string) => redis.eval(ROOM_CAS_SCRIPT, 2, key, lobby, expected, json, '60', 'LUATST', '1');

      await expect(cas('0', '{"a":1}')).resolves.toBe(1);
      await expect(cas('0', '{"a":2}')).resolves.toBe(0);
      await expect(cas('5', '{"a":3}')).resolves.toBe(0);
      await expect(cas('1', '{"a":4}')).resolves.toBe(1);
      await expect(redis.hgetall(key)).resolves.toEqual({ v: '2', json: '{"a":4}' });

      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(await redis.ttl(lobby)).toBeGreaterThan(0);

      await expect(cas('2', '')).resolves.toBe(1); // 삭제
      expect(await redis.exists(key)).toBe(0);
      expect(await redis.zscore(lobby, 'LUATST')).toBeNull();
    });

    it('방·로비·빈도 제한·비밀번호 실패 키가 모두 TTL을 가진다', async () => {
      const host = { socketId: 'ttl-host', userId: null, ip: '127.0.0.1' };
      const room = await replicaA.createRoom({ name: 'TTL', maxPlayers: 2, password: 'pw', playerName: '방장' }, host);
      await codeOf(replicaA.joinRoom({ code: room.room.code, password: 'x', playerName: '도전자' }, { socketId: 'ttl-x', userId: null, ip: '127.0.0.1' }));
      await replicaA.consumeRateLimit('chat', 'ttl-host');
      // 정답 입장은 예약 카운터를 되돌린다(DECR) — 값 0이어도 TTL은 남아야 한다(TTL 없는 키 금지)
      await replicaA.joinRoom({ code: room.room.code, password: 'pw', playerName: '정답' }, { socketId: 'ttl-ok', userId: null, ip: '127.0.0.2' });
      expect(await clients[0].get(`tetris-battle:pwfail-ip:${room.room.code}:127.0.0.2`)).toBe('0');

      const redis = clients[0];
      for (const key of [
        `tetris-battle:room:${room.room.code}`,
        'tetris-battle:rooms',
        'tetris-battle:rl:chat:ttl-host',
        `tetris-battle:pwfail:${room.room.code}:ttl-x`,
        `tetris-battle:pwfail-ip:${room.room.code}:127.0.0.1`,
        `tetris-battle:pwfail-ip:${room.room.code}:127.0.0.2`,
        `tetris-battle:pwfail:${room.room.code}:ttl-ok`,
      ]) {
        // -1 = TTL 없음, -2 = 키 없음 — 둘 다 실패. 키 이름을 같이 찍어 어느 키인지 보이게 한다
        expect({ key, positive: (await redis.ttl(key)) > 0 }).toEqual({ key, positive: true });
      }
    });
  });

  it('두 레플리카가 같은 방(정원 4)에 10명을 동시에 넣어도 정원을 넘지 않는다', async () => {
    const room = await replicaA.createRoom({ name: '동시성', maxPlayers: 4, playerName: '방장' }, { socketId: 'race-host', userId: null, ip: '127.0.0.1' });

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        codeOf((i % 2 ? replicaB : replicaA).joinRoom({ code: room.room.code, playerName: `참가${i}` }, { socketId: `race-${i}`, userId: null, ip: '127.0.0.1' })),
      ),
    );

    expect(outcomes.filter((o) => o === 'OK')).toHaveLength(3);
    expect(outcomes.filter((o) => o !== 'OK').every((o) => o === 'ROOM_FULL')).toBe(true);

    const stored = await clients[0].hget(`tetris-battle:room:${room.room.code}`, 'json');
    const players = (JSON.parse(stored as string) as { players: { playerId: string }[] }).players;
    expect(players).toHaveLength(4);
    expect(new Set(players.map((p) => p.playerId)).size).toBe(4); // playerId 중복 없음
  });

  it('같은 소켓이 비밀번호를 동시에 여러 번 시도해도 한도(5)를 넘는 시도는 잠금 — 두 레플리카에 나눠 보내도 같다', async () => {
    const room = await replicaA.createRoom(
      { name: '비번 동시', maxPlayers: 2, password: 'right', playerName: '방장' },
      { socketId: 'pw-host', userId: null, ip: '127.0.0.1' },
    );
    const attacker = { socketId: 'pw-attacker', userId: null, ip: '198.51.100.1' };

    const outcomes = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        codeOf((i % 2 ? replicaB : replicaA).joinRoom({ code: room.room.code, password: `wrong${i}`, playerName: '공격자' }, attacker)),
      ),
    );

    expect(outcomes.filter((o) => o === 'ROOM_WRONG_PASSWORD')).toHaveLength(5);
    expect(outcomes.filter((o) => o === 'ROOM_PASSWORD_LOCKED')).toHaveLength(10);
    await expect(codeOf(replicaA.joinRoom({ code: room.room.code, password: 'right', playerName: '공격자' }, attacker))).resolves.toBe(
      'ROOM_PASSWORD_LOCKED',
    );
  });

  describe('실제 소켓 흐름', () => {
    let ws: WsE2eApp;
    const NS = '/tetris-battle';

    beforeAll(async () => {
      ws = await createWsApp({
        gateways: [TetrisBattleGateway],
        providers: [
          TetrisBattleWsGuard,
          { provide: TetrisBattleRoomService, useValue: replicaA },
          { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
          { provide: ConfigService, useValue: { get: jest.fn(() => 'secret') } },
        ],
      });
    });

    afterAll(async () => {
      await ws.close();
    });

    it('로비 → 비번 방 생성 → 오답·정답 입장 → ready → 채팅·비멤버 거부 → 방장 이탈·이양 → 재연결', async () => {
      const host = await ws.connect({ namespace: NS });
      const joiner = await ws.connect({ namespace: NS });
      const watcher = await ws.connect({ namespace: NS });
      await emitWithAck(watcher, C.LIST_ROOMS, {});

      // 생성 → 로비 감시자가 목록 변경을 받는다
      const watcherSaw = waitFor<RoomsChangedPayload>(watcher, S.ROOMS_CHANGED);
      const created = await emitWithAck<TetrisBattleAck<EnterRoomAckData>>(host, C.CREATE_ROOM, {
        name: '실전 한판',
        maxPlayers: 3,
        password: 'pw1234',
        playerName: '방장',
      });
      if (!created.ok) throw new Error(`생성 실패: ${created.code}`);
      const code = created.data.room.code;
      const listed = (await watcherSaw).rooms.find((r) => r.code === code);
      expect(listed).toEqual({ code, name: '실전 한판', playerCount: 1, maxPlayers: 3, locked: true, status: 'WAITING' });

      // 오답 → 정답
      await expect(emitWithAck(joiner, C.JOIN_ROOM, { code, password: 'nope', playerName: '도전자' })).resolves.toMatchObject({
        ok: false,
        code: 'ROOM_WRONG_PASSWORD',
      });
      const hostSawJoin = waitFor<RoomState>(host, S.ROOM_STATE);
      const joined = await emitWithAck<TetrisBattleAck<EnterRoomAckData>>(joiner, C.JOIN_ROOM, {
        code: code.toLowerCase(),
        password: 'pw1234',
        playerName: '도전자',
      });
      if (!joined.ok) throw new Error(`입장 실패: ${joined.code}`);
      expect(joined.data.playerId).toBe('p2');
      expect((await hostSawJoin).players.map((p) => p.playerId)).toEqual(['p1', 'p2']);

      // ready
      const hostSawReady = waitFor<RoomState>(host, S.ROOM_STATE);
      await expect(emitWithAck(joiner, C.SET_READY, { code, ready: true })).resolves.toEqual({ ok: true, data: {} });
      expect((await hostSawReady).players[1]).toMatchObject({ playerId: 'p2', ready: true });

      // 채팅 — 멤버 둘 다 받고, 비멤버(watcher)는 거부되며 아무도 받지 않는다
      const hostChat = waitFor(host, S.CHAT_MESSAGE);
      const joinerChat = waitFor(joiner, S.CHAT_MESSAGE);
      await emitWithAck(joiner, C.CHAT, { code, text: '잘 부탁해요' });
      await expect(hostChat).resolves.toMatchObject({ playerId: 'p2', name: '도전자', text: '잘 부탁해요' });
      await joinerChat;
      await expect(emitWithAck(watcher, C.CHAT, { code, text: '훔쳐보기' })).resolves.toMatchObject({ ok: false, code: 'NOT_IN_ROOM' });
      await expect(emitWithAck(watcher, C.SET_READY, { code, ready: true })).resolves.toMatchObject({ ok: false, code: 'NOT_IN_ROOM' });
      await expectNoEvent(host, S.CHAT_MESSAGE);

      // 방장 이탈 → p2에게 이양
      const joinerSawLeave = waitFor<RoomState>(joiner, S.ROOM_STATE);
      await expect(emitWithAck(host, C.LEAVE_ROOM, { code })).resolves.toEqual({ ok: true, data: {} });
      const afterLeave = await joinerSawLeave;
      expect(afterLeave.hostId).toBe('p2');
      expect(afterLeave.players.map((p) => p.playerId)).toEqual(['p2']);

      // 재연결: 소켓이 끊기면 connected=false, 새 소켓이 토큰으로 같은 p2 복귀
      joiner.disconnect();
      await new Promise((r) => setTimeout(r, 200));
      const mid = await clients[0].hget(`tetris-battle:room:${code}`, 'json');
      expect(JSON.parse(mid as string).players[0]).toMatchObject({ playerId: 'p2', connected: false, socketId: null });

      const back = await ws.connect({ namespace: NS });
      const rejoined = await emitWithAck<TetrisBattleAck<EnterRoomAckData>>(back, C.JOIN_ROOM, {
        code,
        playerName: '도전자',
        playerToken: joined.data.playerToken,
      });
      expect(rejoined).toMatchObject({ ok: true, data: { playerId: 'p2', room: { hostId: 'p2' } } });
      if (rejoined.ok) expect(rejoined.data.room.players[0].connected).toBe(true);

      // 마지막 사람이 나가면 방 삭제 → 목록에서 사라진다
      await emitWithAck(back, C.LEAVE_ROOM, { code });
      const list = await emitWithAck<TetrisBattleAck<{ rooms: { code: string }[] }>>(watcher, C.LIST_ROOMS, {});
      expect(list.ok && list.data.rooms.some((r) => r.code === code)).toBe(false);
    });

    it('대전(P2) 실제 흐름: 3인 시작 → lock → 대상만 garbage → topOut 2번 → matchEnded 전원 → rematch', async () => {
      const BOARD = Buffer.alloc(200).toString('base64');
      const host = await ws.connect({ namespace: NS });
      const created = await emitWithAck<TetrisBattleAck<EnterRoomAckData>>(host, C.CREATE_ROOM, { name: '대전', maxPlayers: 3, playerName: '방장' });
      if (!created.ok) throw new Error(created.code);
      const code = created.data.room.code;
      const p2 = await ws.connect({ namespace: NS });
      const p3 = await ws.connect({ namespace: NS });
      await emitWithAck(p2, C.JOIN_ROOM, { code, playerName: '둘째' });
      await emitWithAck(p3, C.JOIN_ROOM, { code, playerName: '셋째' });
      for (const s of [host, p2, p3]) await emitWithAck(s, C.SET_READY, { code, ready: true });

      const startings = Promise.all([host, p2, p3].map((s) => waitFor<MatchStartingPayload>(s, S.MATCH_STARTING)));
      await expect(emitWithAck(host, C.START_MATCH, { code })).resolves.toEqual({ ok: true, data: {} });
      const [starting] = await startings;
      const matchId = starting.matchId;
      // 카운트다운이 끝난 것으로 경기 시계를 돌린다(lock 프레임 상한 — 실제 클라이언트는 3초 뒤부터 보낸다)
      const [sec] = await clients[0].time();
      await clients[0].hset(`tetris-battle:match:${matchId}`, 'clockStart', String(Number(sec) * 1000 - 60_000));
      expect(starting.players.map((p) => p.playerId)).toEqual(['p1', 'p2', 'p3']);

      // p1의 첫 공격은 p2(입장 순서 다음) — p2만 garbage를 받는다
      const garbage = waitFor<GarbagePayload>(p2, S.GARBAGE);
      const attackSeen = waitFor(p3, S.ATTACK);
      const lockAck = await emitWithAck(host, C.LOCK, {
        matchId, seq: 1, frame: 60, sent: 3, combo: 1, b2b: false, tSpin: 'none', lines: 3, pc: false, board: BOARD, pending: 0,
      });
      expect(lockAck).toEqual({ ok: true, data: { targetId: 'p3' } });
      await expect(garbage).resolves.toMatchObject({ matchId, id: 1, lines: 3, from: 'p1' });
      await expect(attackSeen).resolves.toEqual({ matchId, from: 'p1', to: 'p2', lines: 3 });
      await expectNoEvent(p3, S.GARBAGE);

      // p2 탑아웃(by p1, 3위) → p3 탑아웃(2위) → 종료
      const firstKo = waitFor(host, S.PLAYER_KO);
      await emitWithAck(p2, C.TOP_OUT, { matchId, frame: 120 });
      await expect(firstKo).resolves.toEqual({ matchId, playerId: 'p2', by: 'p1', place: 3, reason: 'topout' });

      const endeds = Promise.all([host, p2, p3].map((s) => waitFor<MatchEndedPayload>(s, S.MATCH_ENDED)));
      const resultState = waitFor<RoomState>(host, S.ROOM_STATE);
      await emitWithAck(p3, C.TOP_OUT, { matchId, frame: 130 });
      const [ended] = await endeds;
      expect(ended.results.map((r) => [r.playerId, r.place])).toEqual([['p1', 1], ['p3', 2], ['p2', 3]]);
      expect((await resultState).status).toBe('RESULT');

      const waitingState = waitFor<RoomState>(p2, S.ROOM_STATE);
      await expect(emitWithAck(host, C.REMATCH, { code })).resolves.toEqual({ ok: true, data: {} });
      const waiting = await waitingState;
      expect(waiting.status).toBe('WAITING');
      expect(waiting.players.every((p) => !p.ready)).toBe(true);
    });

    it('리뷰 H2: garbage는 플레이어 채널로 — 끊긴 사이 것은 rejoin.missedGarbage, 재연결 소켓은 이후 것을 받고, 넘겨준 옛 소켓은 못 받는다', async () => {
      const BOARD = Buffer.alloc(200).toString('base64');
      const host = await ws.connect({ namespace: NS });
      const created = await emitWithAck<TetrisBattleAck<EnterRoomAckData>>(host, C.CREATE_ROOM, { name: 'H2', maxPlayers: 3, playerName: '방장' });
      if (!created.ok) throw new Error(created.code);
      const code = created.data.room.code;
      const p2 = await ws.connect({ namespace: NS });
      const p3 = await ws.connect({ namespace: NS });
      const j2 = await emitWithAck<TetrisBattleAck<EnterRoomAckData>>(p2, C.JOIN_ROOM, { code, playerName: '둘째' });
      const j3 = await emitWithAck<TetrisBattleAck<EnterRoomAckData>>(p3, C.JOIN_ROOM, { code, playerName: '셋째', tabId: 'tab-p3' });
      if (!j2.ok || !j3.ok) throw new Error('join');
      for (const s of [host, p2, p3]) await emitWithAck(s, C.SET_READY, { code, ready: true });
      const starting = waitFor<MatchStartingPayload>(host, S.MATCH_STARTING);
      await emitWithAck(host, C.START_MATCH, { code });
      const matchId = (await starting).matchId;
      const [sec] = await clients[0].time();
      await clients[0].hset(`tetris-battle:match:${matchId}`, 'clockStart', String(Number(sec) * 1000 - 60_000));

      let seq = 0;
      const hostLock = (sent: number) =>
        emitWithAck(host, C.LOCK, {
          matchId, seq: ++seq, frame: seq * 30, sent, combo: 0, b2b: false, tSpin: 'none', lines: 2, pc: false, board: BOARD, pending: 0,
        });

      // p2 소켓이 끊긴 동안 p2에게 가비지 1
      p2.disconnect();
      await new Promise((r) => setTimeout(r, 200));
      await hostLock(2); // → p2 (id 1)

      // 새 소켓으로 재연결 → 놓친 1번은 ack로
      const p2b = await ws.connect({ namespace: NS });
      const back = await emitWithAck<TetrisBattleAck<EnterRoomAckData>>(p2b, C.JOIN_ROOM, {
        code, playerName: '둘째', playerToken: j2.data.playerToken, lastGarbageId: 0,
      });
      if (!back.ok) throw new Error(back.code);
      expect(back.data.rejoin?.missedGarbage.map((g) => g.id)).toEqual([1]);

      await hostLock(1); // → p3 (id 1)
      const p2bGarbage = waitFor<GarbagePayload>(p2b, S.GARBAGE);
      await hostLock(3); // → p2 (id 2) — 재연결한 새 소켓이 채널로 받는다
      await expect(p2bGarbage).resolves.toMatchObject({ id: 2, lines: 3 });

      // p3: 같은 탭이 옛 소켓이 아직 살아 있는 채로(서버가 끊김을 모름) 새 소켓으로 넘겨받는다 → 이후 가비지는 새 소켓만.
      // 경기 중 연결된 자리는 같은 tabId만 넘겨받는다(tetris-audit D-007) — 다른 탭이면 SEAT_IN_USE
      const p3other = await ws.connect({ namespace: NS });
      const denied = await emitWithAck<TetrisBattleAck<EnterRoomAckData>>(p3other, C.JOIN_ROOM, {
        code, playerName: '셋째', playerToken: j3.data.playerToken, tabId: 'tab-other',
      });
      expect(denied).toMatchObject({ ok: false, code: 'SEAT_IN_USE' });
      const p3b = await ws.connect({ namespace: NS });
      const replaced = waitFor<{ code: string }>(p3, S.SESSION_REPLACED);
      await emitWithAck(p3b, C.JOIN_ROOM, { code, playerName: '셋째', playerToken: j3.data.playerToken, lastGarbageId: 1, tabId: 'tab-p3' });
      await expect(replaced).resolves.toEqual({ code });
      const p3bGarbage = waitFor<GarbagePayload>(p3b, S.GARBAGE);
      const oldSocketGot = expectNoEvent(p3, S.GARBAGE, 500); // 보내기 전부터 지켜본다
      await hostLock(1); // → p3 (id 2)
      await expect(p3bGarbage).resolves.toMatchObject({ id: 2 });
      await oldSocketGot;
    });
  });
});

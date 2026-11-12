import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Redis } from 'ioredis';
import { User } from '../src/entities/User';
import { createMockRepository } from '../src/common/__spec__/mock-repository';
import { FortressGateway } from '../src/modules/fortress/fortress.gateway';
import { FortressSkinService } from '../src/modules/fortress/fortress-skin.service';
import { FortressLobbyChatService } from '../src/modules/fortress/fortress-lobby-chat.service';
import { FortressMatchService, MatchBroadcast } from '../src/modules/fortress/fortress-match.service';
import { FortressMatchStore, MATCH_ACTIVATE_SCRIPT, MATCH_CAS_SCRIPT } from '../src/modules/fortress/fortress-match.store';
import { FortressRoomService, SocketIdentity } from '../src/modules/fortress/fortress-room.service';
import { FortressWsGuard } from '../src/modules/fortress/fortress-ws.guard';
import { FortressError } from '../src/modules/fortress/fortress.errors';
import {
  EnterRoomAckData,
  FortressAck,
  FortressClientEvents as C,
  FortressServerEvents as S,
  MatchEndedPayload,
  MatchStartingPayload,
  TurnResolvedPayload,
} from '../src/modules/fortress/fortress.events';
import { createWsApp, emitWithAck, waitFor } from './helpers/ws-e2e-app';

/**
 * 실제 Redis 대상 포트리스 방·경기 검증 — **opt-in**.
 *
 * CI·기본 E2E에는 Redis가 없으므로 `FORTRESS_REDIS_TEST_PORT`가 있을 때만 돈다(테트리스 `TETRIS_BATTLE_REDIS_TEST_PORT`와 같은 방식).
 * 로컬: `FORTRESS_REDIS_TEST_PORT=6390 pnpm test:e2e -- --testPathPatterns fortress`
 * 모든 키는 실행마다 다른 프리픽스(`fttest:<난수>:`) 아래에 쓰고 끝나면 지운다(남아도 전부 TTL). 운영 Redis를 가리키지 말 것.
 *
 * mock이 못 보는 것:
 *  1. MATCH_CAS_SCRIPT 본문 — 버전 불일치 거부, 생성 시 기존 키 거부, 마감 ZSET ZADD/ZREM, 두 키 TTL
 *  2. 두 "레플리카"(서비스 인스턴스 2개·연결 2개)가 같은 마감을 동시에 처리해도 skip은 1번 — 스위퍼(ZRANGEBYSCORE)가 지난 경기만 집는다
 *  3. 실제 소켓 + 실제 서비스 + 실제 Redis로 생성→입장→준비→시작→턴→마감 skip→이탈 resign→종료
 *  4. 결과 저장(F6) Redis 부분 — 끝내는 행동이 저장 대기 ZSET에 들어감, 진행 가드 SET NX EX, 완료 표시·대기 ZSET TTL
 *  5. MATCH_ACTIVATE_SCRIPT 본문 — 버전 1일 때만 첫 마감 ZADD, 그 사이 버전이 오르면(끝난 경기) 덮지 않음
 */
const port = Number(process.env.FORTRESS_REDIS_TEST_PORT);
const describeIfRedis = port ? describe : describe.skip;

const PREFIX = `fttest:${Date.now()}:${Math.random().toString(36).slice(2, 8)}:`;
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
const who = (n: number): SocketIdentity => ({ socketId: `ft-sock-${n}-${Math.random()}`, userId: null, ip: `10.1.0.${n}` });

describeIfRedis('포트리스 경기 — 실제 Redis (Lua·두 레플리카·WS)', () => {
  const clients: Redis[] = [];
  /** 레플리카 = 방 서비스 + 경기 서비스 + 자기 Redis 연결 */
  const replica = (client: Redis, broadcasts: MatchBroadcast[]) => {
    const matches = new FortressMatchService();
    matches.setRedisClient(client);
    matches.setWakeScheduler(() => undefined);
    matches.setBroadcastListener((_code, b) => broadcasts.push(b));
    const rooms = new FortressRoomService(matches);
    rooms.setRedisClient(client);
    rooms.setWakeScheduler(() => undefined);
    return { matches, rooms };
  };

  beforeAll(async () => {
    const a = openClient();
    const b = openClient();
    clients.push(a, b);
    await Promise.all([waitReady(a), waitReady(b)]);
  });

  afterAll(async () => {
    const raw = new Redis({ host: '127.0.0.1', port });
    const keys = await raw.keys(`${PREFIX}*`);
    if (keys.length) await raw.del(...keys);
    await raw.quit();
    await Promise.all(clients.map((c) => c.quit()));
  });

  it('MATCH_CAS_SCRIPT: 생성(0)은 키가 있으면 거부, 기대 버전이 다르면 거부, 점수 있으면 ZADD·없으면 ZREM, 두 키 모두 TTL', async () => {
    const redis = clients[0];
    const key = 'fortress:match:LUATEST';
    const zset = 'fortress:deadlines';
    const cas = (expected: string, json: string, score: string) => redis.eval(MATCH_CAS_SCRIPT, 2, key, zset, expected, json, '60', 'LUATEST', score);

    await expect(cas('0', '{"a":1}', '100')).resolves.toBe(1);
    await expect(cas('0', '{"a":2}', '100')).resolves.toBe(0);
    await expect(cas('7', '{"a":3}', '100')).resolves.toBe(0);
    expect(await redis.zscore(zset, 'LUATEST')).toBe('100');
    await expect(cas('1', '{"a":4}', '200')).resolves.toBe(1);
    await expect(redis.hgetall(key)).resolves.toEqual({ v: '2', json: '{"a":4}' });
    expect(await redis.zscore(zset, 'LUATEST')).toBe('200');
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    expect(await redis.ttl(zset)).toBeGreaterThan(0);

    await expect(cas('2', '{"a":5}', '')).resolves.toBe(1); // 경기 끝 — JSON은 남고 마감 ZSET에서만 빠진다
    expect(await redis.zscore(zset, 'LUATEST')).toBeNull();
    expect(await redis.hget(key, 'json')).toBe('{"a":5}');
  });

  it('MATCH_ACTIVATE_SCRIPT: 버전 1일 때만 첫 마감을 넣고, 그 사이 행동이 들어가 버전이 오르면(v≠1) 마감을 덮지 않는다', async () => {
    const redis = clients[0];
    const key = 'fortress:match:ACTTEST';
    const zset = 'fortress:deadlines';
    const cas = (expected: string, score: string) => redis.eval(MATCH_CAS_SCRIPT, 2, key, zset, expected, '{}', '60', 'ACTTEST', score);
    const activate = (score: string) => redis.eval(MATCH_ACTIVATE_SCRIPT, 2, key, zset, 'ACTTEST', score, '60');

    await expect(activate('100')).resolves.toBe(0); // 경기 키가 없으면 넣지 않는다
    expect(await redis.zscore(zset, 'ACTTEST')).toBeNull();

    await expect(cas('0', '')).resolves.toBe(1); // 생성(v1) — 마감 없음
    await expect(activate('100')).resolves.toBe(1);
    expect(await redis.zscore(zset, 'ACTTEST')).toBe('100');

    await expect(cas('1', '')).resolves.toBe(1); // 다른 레플리카가 경기를 끝냄(v2, ZSET에서 뺌)
    await expect(activate('100')).resolves.toBe(0); // 늦은 activate가 끝난 경기를 되살리지 않는다
    expect(await redis.zscore(zset, 'ACTTEST')).toBeNull();
    await redis.del(key);
  });

  it('두 레플리카: A가 시작한 경기의 마감을 A·B가 동시에 처리해도 skip 1번 · 스위퍼는 지난 경기만 집는다 · 이탈 resign으로 종료·방 RESULT', async () => {
    const broadcasts: MatchBroadcast[] = [];
    const A = replica(clients[0], broadcasts);
    const B = replica(clients[1], broadcasts);
    const host = who(1);
    const guest = who(2);
    const T0 = Date.now();

    const created = await A.rooms.createRoom({ name: '레디스', mode: 'ffa', mapId: 'hills', maxPlayers: 2, playerName: '방장' }, host, T0);
    const code = created.room.code;
    await B.rooms.joinRoom({ code, playerName: '도전자' }, guest, T0);
    await B.rooms.setReady(code, guest.socketId, true, T0);
    const { starting } = await A.rooms.startMatch(code, host.socketId, T0);
    const deadline = Date.parse(starting.turn.deadlineAt);

    // 마감 전 스윕은 아무것도 하지 않는다
    await B.matches.sweep(deadline - 1);
    expect(broadcasts).toHaveLength(0);

    await Promise.all([A.matches.processDue(starting.matchId, deadline), B.matches.processDue(starting.matchId, deadline), B.matches.sweep(deadline)]);
    const resolved = broadcasts.filter((b) => b.event === 'turnResolved').map((b) => b.payload as TurnResolvedPayload);
    expect(resolved).toEqual([expect.objectContaining({ seq: 0, action: { kind: 'skip' }, cause: 'timeout' })]);

    // 늦은 제출은 TURN_MISMATCH(실제 Redis에서 로드한 seq 기준)
    const late = await A.rooms
      .turnSubmit(code, host.socketId, { matchId: starting.matchId, seq: 0, move: 0, angle: 45, power: 0, weaponId: 0 }, deadline)
      .then(() => 'OK', (e: unknown) => (e instanceof FortressError ? e.code : String(e)));
    expect(late).toBe('TURN_MISMATCH');

    await B.rooms.leaveRoom(code, guest.socketId, deadline + 1);
    expect(broadcasts.filter((b) => b.event === 'matchEnded')).toHaveLength(1);
    const room = await clients[0].hget(`fortress:room:${code}`, 'json');
    expect(JSON.parse(room as string)).toMatchObject({ status: 'RESULT' });
    expect(await clients[0].zscore('fortress:deadlines', starting.matchId)).toBeNull();
    expect(await clients[0].ttl(`fortress:match:${starting.matchId}`)).toBeGreaterThan(0);
    // F6: 끝내는 행동이 CAS 전에 저장 대기에 넣었다 · matchEnded에 replay id = matchId
    expect(Number(await clients[0].zscore('fortress:pending-saves', starting.matchId))).toBe(deadline + 1);
    expect(await clients[0].ttl('fortress:pending-saves')).toBeGreaterThan(0);
    const endedPayload = broadcasts.find((b) => b.event === 'matchEnded')?.payload as MatchEndedPayload;
    expect(endedPayload.replay).toEqual({ id: starting.matchId });
  });

  it('결과 저장 키: 진행 가드는 두 연결 중 하나만(SET NX, TTL) · 완료 표시(TTL) · 대기 ZSET 기한 조회·삭제', async () => {
    const store = new FortressMatchStore();
    const [a, b] = clients;
    const id = 'SAVETEST00000000';
    const claims = await Promise.all([store.claimSave(a, id), store.claimSave(b, id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await a.ttl(`fortress:match:${id}:saving`)).toBeGreaterThan(0);
    await store.releaseSave(b, id);
    await expect(store.claimSave(a, id)).resolves.toBe(true);

    await expect(store.isSaved(b, id)).resolves.toBe(false);
    await store.markSaved(a, id);
    await expect(store.isSaved(b, id)).resolves.toBe(true);
    expect(await a.ttl(`fortress:match:${id}:saved`)).toBeGreaterThan(0);

    await store.markPendingSave(a, id, 1_000);
    await store.markPendingSave(a, 'SAVETEST00000001', 5_000);
    await expect(store.duePendingSaves(b, 2_000, 10)).resolves.toEqual([id]);
    await store.clearPendingSave(b, id);
    await expect(store.duePendingSaves(a, 10_000, 10)).resolves.toEqual(['SAVETEST00000001']);
  });

  it('WS: 실제 소켓 2개 + 실제 Redis로 시작 → 턴 → 마감 skip → 이탈 → matchEnded', async () => {
    const userRepository = createMockRepository<User>();
    const app = await createWsApp({
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
    try {
      const matches = app.moduleRef.get(FortressMatchService);
      matches.setRedisClient(clients[0]);
      matches.setWakeScheduler(() => undefined);
      app.moduleRef.get(FortressRoomService).setRedisClient(clients[0]);
      const a = await app.connect({ namespace: '/fortress' });
      const b = await app.connect({ namespace: '/fortress' });
      type Ack<T = unknown> = FortressAck<T>;

      const created = (await emitWithAck<Ack<EnterRoomAckData>>(a, C.CREATE_ROOM, { name: 'WS', mode: 'ffa', mapId: 'random', maxPlayers: 2, playerName: '방장' })) as {
        ok: true;
        data: EnterRoomAckData;
      };
      const code = created.data.room.code;
      expect(await emitWithAck<Ack>(b, C.JOIN_ROOM, { code, playerName: '도전자' })).toMatchObject({ ok: true });
      expect(await emitWithAck<Ack>(b, C.SET_READY, { code, ready: true })).toMatchObject({ ok: true });
      const startingP = waitFor<MatchStartingPayload>(b, S.MATCH_STARTING);
      expect(await emitWithAck<Ack>(a, C.START_MATCH, { code })).toMatchObject({ ok: true });
      const starting = await startingP;

      const ownerId = starting.slots[starting.turn.slot].playerId;
      const owner = ownerId === created.data.playerId ? a : b;
      // 시작 카운트다운(D-021) — startAt 전 제출은 MATCH_NOT_STARTED라 끝날 때까지 기다린다
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(starting.startAt) - Date.now())));
      const firstP = waitFor<TurnResolvedPayload>(b, S.TURN_RESOLVED);
      expect(await emitWithAck<Ack>(owner, C.TURN_SUBMIT, { matchId: starting.matchId, seq: 0, move: 5, angle: 60, power: 55, weaponId: 0 })).toEqual({ ok: true, data: {} });
      const first = await firstP;
      expect(first).toMatchObject({ seq: 0, cause: 'player', next: { seq: 1 } });

      const skipP = waitFor<TurnResolvedPayload>(a, S.TURN_RESOLVED);
      await matches.processDue(starting.matchId, Date.parse((first.next as NonNullable<typeof first.next>).deadlineAt));
      expect(await skipP).toMatchObject({ seq: 1, cause: 'timeout' });

      const endedP = waitFor<MatchEndedPayload>(a, S.MATCH_ENDED);
      expect(await emitWithAck<Ack>(b, C.LEAVE_ROOM, { code })).toMatchObject({ ok: true });
      const ended = await endedP;
      expect(ended.players.map((p) => [p.playerId, p.place])).toEqual([
        [created.data.playerId, 1],
        ['p2', 2],
      ]);
    } finally {
      await app.close();
    }
  }, 15_000);
});

import { Redis } from 'ioredis';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { SocketIdentity, TetrisBattleRoomService } from '../src/modules/tetris-battle/tetris-battle-room.service';
import { TetrisBattleResultService } from '../src/modules/tetris-battle/tetris-battle-result.service';
import {
  TetrisBattleMatchStore,
  matchKey,
  savedGuardKey,
  sentLogKey,
  submissionsKey,
} from '../src/modules/tetris-battle/tetris-battle-match.store';
import { BOARD_BYTES } from '../src/modules/tetris-battle/tetris-battle.events';
import {
  type BattleLock,
  type BattleReplayInput,
  createBattle,
  receiveGarbage,
  stepBattle,
} from '../src/modules/tetris-battle/battle-engine';
import golden from '../src/modules/tetris-battle/battle-engine/__fixtures__/golden-battle-replays.json';
import { createMockRepository } from '../src/common/__spec__/mock-repository';

/**
 * 실제 Redis 대상 경기 후 검증(P5) — **opt-in** (`TETRIS_BATTLE_REDIS_TEST_PORT`).
 * 로컬: `TETRIS_BATTLE_REDIS_TEST_PORT=6380 npx jest --config ./test/jest-e2e.json --testPathPatterns 'test/tetris-battle-'`
 * 실행마다 다른 keyPrefix 아래에 쓰고 끝나면 지운다. 운영 Redis를 가리키지 말 것.
 *
 * mock이 못 보는 것: 시작 시 토큰 해시 복사 · lock Lua의 (seq, sent) 로그 · 종료 Redis 시각 기록 ·
 * 제출 HSETNX·저장 SET NX의 1회 의미 · 그리고 실제 lock 흐름으로 쌓인 서버 기록과 골든 리플레이가 검증을 통과하는지.
 */
const port = Number(process.env.TETRIS_BATTLE_REDIS_TEST_PORT);
const describeIfRedis = port ? describe : describe.skip;

const PREFIX = `tbtest:${Date.now()}:${Math.random().toString(36).slice(2, 8)}:`;
const EMPTY_BOARD = Buffer.alloc(BOARD_BYTES).toString('base64');
const T0 = 1_900_000_000_000;
const who = (n: number): SocketIdentity => ({ socketId: `r-sock-${n}`, userId: null, ip: '127.0.0.1' });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 골든 리플레이를 래퍼로 재생해 실제 lock 순서를 뽑는다 */
const locksOf = (input: BattleReplayInput) => {
  const locks: BattleLock[] = [];
  const bs = createBattle({ seed: input.seed, das: input.das, arr: input.arr });
  const buffer: number[] = [];
  let ii = 0;
  let inputFrame = input.inputs.length > 0 ? input.inputs[0] : -1;
  let gi = 0;
  let garbageFrame = input.garbage.length > 0 ? input.garbage[0] : -1;
  for (let frame = 0; frame < input.frames && !bs.game.over; frame++) {
    while (gi < input.garbage.length && garbageFrame === frame) {
      receiveGarbage(bs, { id: input.garbage[gi + 1], lines: input.garbage[gi + 2], hole: input.garbage[gi + 3] });
      gi += 4;
      if (gi < input.garbage.length) garbageFrame += input.garbage[gi];
    }
    let count = 0;
    while (ii < input.inputs.length && inputFrame === frame) {
      buffer[count++] = input.inputs[ii + 1];
      ii += 2;
      if (ii < input.inputs.length) inputFrame += input.inputs[ii];
    }
    const { lock } = stepBattle(bs, buffer, count);
    if (lock) locks.push(lock);
  }
  return { locks, topOutFrame: bs.game.over ? bs.game.endFrame : null };
};

describeIfRedis('테트리스 대전 경기 후 검증 — 실제 Redis', () => {
  let client: Redis;
  let room: TetrisBattleRoomService;
  const store = new TetrisBattleMatchStore();

  const waitReady = (c: Redis) =>
    new Promise<void>((resolve, reject) => {
      if (c.status === 'ready') return resolve();
      const timer = setTimeout(() => reject(new Error('Redis 연결 대기 초과')), 3000);
      c.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });

  /** 2인 방 시작 + 경기 시계 1시간 전으로(lock 프레임 상한이 골든 프레임을 막지 않게) */
  const start = async () => {
    const created = await room.createRoom({ name: '검증방', maxPlayers: 2, playerName: '플1' }, who(1), T0);
    const code = created.room.code;
    const joined = await room.joinRoom({ code, playerName: '플2' }, who(2), T0);
    await room.setReady(code, who(2).socketId, true, T0);
    const { starting } = await room.startMatch(code, who(1).socketId, T0);
    const [sec] = await client.time();
    await client.hset(matchKey(starting.matchId), 'clockStart', String(Number(sec) * 1000 - 3_600_000));
    return { code, matchId: starting.matchId, tokens: [created.playerToken, joined.playerToken] };
  };

  beforeAll(async () => {
    client = new Redis({ host: '127.0.0.1', port, keyPrefix: PREFIX });
    await waitReady(client);
    room = new TetrisBattleRoomService();
    room.setRedisClient(client);
  });

  afterAll(async () => {
    const raw = new Redis({ host: '127.0.0.1', port });
    const keys = await raw.keys(`${PREFIX}*`);
    if (keys.length) await raw.del(...keys);
    await raw.quit();
    await client.quit();
  });

  it('시작 시 플레이어별 토큰 해시·방 이름을 매치 Hash에 복사한다', async () => {
    const { matchId, tokens } = await start();
    const h = await client.hgetall(matchKey(matchId));
    expect(h['p:p1:tokenHash']).toBe(sha256(tokens[0]));
    expect(h['p:p2:tokenHash']).toBe(sha256(tokens[1]));
    expect(h.roomName).toBe('검증방');
  });

  it('lock Lua가 sent > 0인 lock만 "seq:sent"로 기록한다 — 중복·거부 lock은 기록하지 않는다, TTL 있음', async () => {
    const { code, matchId } = await start();
    const lock = (seq: number, frame: number, sent: number) =>
      room.lock(code, who(1).socketId, { matchId, seq, frame, sent, combo: 0, b2b: false, board: EMPTY_BOARD, pending: 0 }, T0);

    await lock(1, 10, 0);
    await lock(2, 20, 3);
    await lock(2, 20, 3); // 재전송
    await lock(3, 30, 2);
    await lock(5, 31, 4).catch(() => undefined); // seq 간격 위반 → 거부

    expect(await store.sentLog(client, matchId, 'p1')).toEqual([
      { seq: 2, sent: 3 },
      { seq: 3, sent: 2 },
    ]);
    expect(await client.ttl(sentLogKey(matchId, 'p1'))).toBeGreaterThan(0);
  });

  it('가비지 로그에 보낸 Redis 시각(at)을 남기고, 탈락 Redis 시각(koClock)을 남긴다 — 재연결 missedGarbage에는 at이 없다 (D-022)', async () => {
    const { code, matchId } = await start();
    await room.lock(code, who(1).socketId, { matchId, seq: 1, frame: 10, sent: 2, combo: 0, b2b: false, board: EMPTY_BOARD, pending: 0 }, T0);
    const [sec] = await client.time();

    const log = await store.garbageLog(client, matchId, 'p2');
    expect(log).toEqual([{ id: 1, lines: 2, hole: expect.any(Number), at: expect.any(Number) }]);
    expect(Math.abs((log[0].at as number) - Number(sec) * 1000)).toBeLessThan(5_000);
    expect(await store.garbageSince(client, matchId, 'p2', 0)).toEqual([
      { matchId, id: 1, lines: 2, hole: log[0].hole, from: 'p1' },
    ]);

    await room.topOut(code, who(2).socketId, { matchId, frame: 20 }, T0);
    const snap = await store.snapshot(client, matchId);
    expect(snap?.players.find((p) => p.playerId === 'p2')?.koClock).toEqual(expect.any(Number));
  });

  it('종료 시 Redis 시각(endedClock)을 기록한다', async () => {
    const { code, matchId } = await start();
    await room.topOut(code, who(2).socketId, { matchId, frame: 10 }, T0);
    const snap = await store.snapshot(client, matchId);
    expect(snap?.status).toBe('ENDED');
    expect(snap?.endedClock).toEqual(expect.any(Number));
    expect(snap?.endedAt).toBe(T0);
  });

  it('제출은 1번만, 저장 진행 가드는 SET NX + 짧은 TTL(≤120초), 풀면 다시 잡힌다 (리뷰 L8)', async () => {
    const { matchId } = await start();
    await expect(store.claimSubmission(client, matchId, 'p1', '{"a":1}')).resolves.toBe('CLAIMED');
    await expect(store.claimSubmission(client, matchId, 'p1', '{"a":2}')).resolves.toBe('DUPLICATE');
    expect(await store.submissions(client, matchId)).toEqual({ p1: '{"a":1}' });

    await expect(store.claimSave(client, matchId)).resolves.toBe(true);
    await expect(store.claimSave(client, matchId)).resolves.toBe(false);
    const ttl = await client.ttl(savedGuardKey(matchId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
    await store.releaseSave(client, matchId);
    await expect(store.claimSave(client, matchId)).resolves.toBe(true);
    expect(await client.ttl(submissionsKey(matchId))).toBeGreaterThan(0);
  });

  it('닫힘(리뷰 L2): 닫기 전 제출은 닫을 때 돌려준 목록에 반드시 있고, 닫은 뒤 제출은 CLOSED — 예약 필드는 목록에 없다', async () => {
    const { matchId } = await start();
    await expect(store.claimSubmission(client, matchId, 'p1', 'A')).resolves.toBe('CLAIMED');
    await expect(store.closeSubmissions(client, matchId, T0)).resolves.toEqual({ p1: 'A' });
    await expect(store.claimSubmission(client, matchId, 'p2', 'B')).resolves.toBe('CLOSED');
    // 다시 닫아도(저장 재시도) 같은 목록
    await expect(store.closeSubmissions(client, matchId, T0 + 1)).resolves.toEqual({ p1: 'A' });
    await store.markSaved(client, matchId);
    await expect(store.isSaved(client, matchId)).resolves.toBe(true);
    expect(await store.submissions(client, matchId)).toEqual({ p1: 'A' });
  });

  it('닫기와 제출이 동시에 와도 "목록에 들었거나 CLOSED" 둘 중 하나다(유실 없음)', async () => {
    const { matchId } = await start();
    const [claim, list] = await Promise.all([
      store.claimSubmission(client, matchId, 'p1', 'A'),
      store.closeSubmissions(client, matchId, T0),
    ]);
    expect(claim === 'CLAIMED' ? list.p1 === 'A' : claim === 'CLOSED' && list.p1 === undefined).toBe(true);
  });

  it('토큰 해시 갱신(리뷰 L7)은 매치 키가 있을 때만 — 없는 키를 만들지 않는다', async () => {
    const { code, matchId } = await start();
    const again = await room.joinRoom({ code, playerName: '플2' }, who(2), T0 + 1); // 같은 소켓 재입장 → 재발급
    expect(await client.hget(matchKey(matchId), 'p:p2:tokenHash')).toBe(sha256(again.playerToken));

    await store.setTokenHash(client, 'NoSuchMatch00000', 'p1', 'x');
    expect(await client.exists(matchKey('NoSuchMatch00000'))).toBe(0);
  });

  it('실제 lock 흐름으로 쌓인 서버 기록 + 골든 리플레이 제출 → VERIFIED, 1회 저장 · 변조 제출은 INVALID', async () => {
    const replay = (golden as unknown as { name: string; input: BattleReplayInput }[]).find((c) => c.name === 'attack-combo')!.input;
    const { locks, topOutFrame } = locksOf(replay);
    expect(topOutFrame).not.toBeNull();

    const { code, matchId, tokens } = await start();
    await client.hset(matchKey(matchId), 'seed', String(replay.seed)); // 골든 seed로 맞춘다
    for (const l of locks) {
      await room.lock(code, who(1).socketId, { matchId, seq: l.seq, frame: l.frame, sent: l.sent, combo: 0, b2b: false, board: EMPTY_BOARD, pending: 0 }, T0);
    }
    await room.topOut(code, who(1).socketId, { matchId, frame: topOutFrame as number }, T0); // p1 탈락 → p2 우승·종료

    const saves: unknown[] = [];
    const manager = {
      findOne: async () => null,
      create: (_e: unknown, row: unknown) => row,
      save: async (row: unknown) => (saves.push(row), row),
    };
    const result = new TetrisBattleResultService(
      room,
      createMockRepository() as never,
      createMockRepository() as never,
      createMockRepository() as never,
      createMockRepository() as never,
      { transaction: (run: (m: typeof manager) => unknown) => run(manager) } as unknown as DataSource,
    );
    const submit = (token: string, r: BattleReplayInput) =>
      result.submitReplay({ matchId, playerToken: token, replay: r, userId: null, now: T0 + 1_000 });

    await expect(submit(tokens[0], replay)).resolves.toEqual({ verdict: 'VERIFIED' });
    await expect(submit(tokens[0], replay)).rejects.toMatchObject({ status: 409 });

    // p2가 p1의 리플레이를 자기 것이라고 내면 INVALID — 그리고 예상 제출자 전원(생존자 p2·topout p1) 제출이라 저장
    await expect(submit(tokens[1], replay)).resolves.toEqual({ verdict: 'INVALID' });
    expect(saves.length).toBe(1 + 2 + 2);
    expect(saves[0]).toMatchObject({ matchId, status: 'DISPUTED', roomName: '검증방', seed: replay.seed });
    await expect(store.isSaved(client, matchId)).resolves.toBe(true);
  });

  it('리뷰 L2 실제 흐름: 기권 탈락자만 남으면 생존자 제출로 즉시 저장 → 그 뒤 기권자 제출은 410', async () => {
    const { code, matchId, tokens } = await start();
    await room.leaveRoom(code, who(2).socketId, T0); // p2 기권 → p1 우승·종료 (p2는 예상 제출자 아님)

    const saves: unknown[] = [];
    const manager = {
      findOne: async () => null,
      create: (_e: unknown, row: unknown) => row,
      save: async (row: unknown) => (saves.push(row), row),
    };
    const result = new TetrisBattleResultService(
      room,
      createMockRepository() as never,
      createMockRepository() as never,
      createMockRepository() as never,
      createMockRepository() as never,
      { transaction: (run: (m: typeof manager) => unknown) => run(manager) } as unknown as DataSource,
    );
    const replay = (golden as unknown as { name: string; input: BattleReplayInput }[]).find((c) => c.name === 'survivor')!.input;

    await result.submitReplay({ matchId, playerToken: tokens[0], replay, userId: null, now: T0 + 1_000 });
    expect(saves.length).toBe(1 + 2 + 1);
    await expect(
      result.submitReplay({ matchId, playerToken: tokens[1], replay, userId: null, now: T0 + 2_000 }),
    ).rejects.toMatchObject({ status: 410, code: 'TETRIS_BATTLE_SUBMISSION_CLOSED' });
    expect(saves.length).toBe(1 + 2 + 1);
  });

  it('로비 방 수 REST(D-025): 실제 로비 인덱스로 센다 — 대기 방 +1·경기 방 +1, 2초 캐시', async () => {
    await client.del('tetris-battle:lobby-counts');
    const before = await room.lobbyCounts(T0);
    if (!before) throw new Error('Redis 준비 안 됨');

    await room.createRoom({ name: '대기방', maxPlayers: 2, playerName: '대기' }, who(50), T0); // WAITING
    await start(); // PLAYING
    await client.del('tetris-battle:lobby-counts');
    const after = await room.lobbyCounts(T0);
    expect(after).toEqual({ waitingRooms: before.waitingRooms + 1, playingRooms: before.playingRooms + 1 });
    const ttl = await client.pttl('tetris-battle:lobby-counts');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2_000);

    // 캐시가 살아 있는 동안은 새 방이 생겨도 같은 숫자
    await room.createRoom({ name: '또대기', maxPlayers: 2, playerName: '또' }, who(51), T0);
    await expect(room.lobbyCounts(T0)).resolves.toEqual(after);
  });
});

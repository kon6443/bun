import { Redis } from 'ioredis';
import {
  SocketIdentity,
  TetrisBattleRoomService,
} from '../src/modules/tetris-battle/tetris-battle-room.service';
import { TetrisBattleMatchStore, garbageLogKey, matchKey } from '../src/modules/tetris-battle/tetris-battle-match.store';
import { TetrisBattleError } from '../src/modules/tetris-battle/tetris-battle.errors';
import { BOARD_BYTES, MatchEndedPayload } from '../src/modules/tetris-battle/tetris-battle.events';
import { DISCONNECT_GRACE_MS, LOCK_FRAME_SLACK } from '../src/modules/tetris-battle/tetris-battle.constants';
import {
  type BattleLock,
  type BattleReplayInput,
  createBattle,
  receiveGarbage,
  stepBattle,
} from '../src/modules/tetris-battle/battle-engine';
import golden from '../src/modules/tetris-battle/battle-engine/__fixtures__/golden-battle-replays.json';

/**
 * 실제 Redis 대상 대전 매치(P2) 검증 — **opt-in** (`TETRIS_BATTLE_REDIS_TEST_PORT`).
 * 로컬: `TETRIS_BATTLE_REDIS_TEST_PORT=6380 npx jest --config ./test/jest-e2e.json --testPathPatterns 'test/tetris-battle-'`
 * 실행마다 다른 keyPrefix 아래에 쓰고 끝나면 지운다(남아도 전부 TTL). 운영 Redis를 가리키지 말 것.
 *
 * 매치 규칙(대상 순환·가비지 id·KO 귀속·순위·seq 검증·끊김 유예 KO·종료 1회)은 Lua 안에 있어서
 * mock으로는 의미를 검증할 수 없다 — 여기가 그 규칙의 정본 테스트다. 두 서비스 인스턴스(= 두 레플리카)로 돌린다.
 */
const port = Number(process.env.TETRIS_BATTLE_REDIS_TEST_PORT);
const describeIfRedis = port ? describe : describe.skip;

const PREFIX = `tbtest:${Date.now()}:${Math.random().toString(36).slice(2, 8)}:`;
const EMPTY_BOARD = Buffer.alloc(BOARD_BYTES).toString('base64');
const T0 = 1_900_000_000_000;

const waitReady = (client: Redis) =>
  new Promise<void>((resolve, reject) => {
    if (client.status === 'ready') return resolve();
    const timer = setTimeout(() => reject(new Error('Redis 연결 대기 초과')), 3000);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TetrisBattleError ? e.code : `UNEXPECTED:${String(e)}`),
  );

const who = (n: number): SocketIdentity => ({ socketId: `m-sock-${n}`, userId: null, ip: '127.0.0.1' });

describeIfRedis('테트리스 대전 매치 — 실제 Redis (Lua)', () => {
  const clients: Redis[] = [];
  let a: TetrisBattleRoomService;
  let b: TetrisBattleRoomService;
  let seqs: Record<string, number>;

  /** n명 방을 만들고 전원 ready 후 시작 — { code, matchId, tokens } */
  const startMatchWith = async (n: number, now = T0) => {
    const created = await a.createRoom({ name: '매치', maxPlayers: 4, playerName: '플1' }, who(1), now);
    const code = created.room.code;
    const tokens = [created.playerToken];
    for (let i = 2; i <= n; i++) tokens.push((await a.joinRoom({ code, playerName: `플${i}` }, who(i), now)).playerToken);
    for (let i = 1; i <= n; i++) await a.setReady(code, who(i).socketId, true, now);
    const started = await a.startMatch(code, who(1).socketId, now);
    const matchId = started.starting.matchId;
    // 게임 시간 상한(lock frame ≤ 경과 시간)이 이 스펙의 프레임 값을 막지 않게 경기 시계를 1시간 전으로 돌린다.
    // 상한 자체는 아래 '게임 시간 상한' 절에서 실제 시계로 검증한다
    await backdate(matchId, 3_600_000);
    return { code, matchId, seed: started.starting.seed, tokens };
  };

  /** Redis 기준 현재(ms) */
  const redisNowMs = async () => {
    const [sec, usec] = await clients[0].time();
    return Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
  };
  /** 경기 0프레임 시각을 지금보다 elapsedMs 전으로 */
  const backdate = async (matchId: string, elapsedMs: number) => {
    await clients[0].hset(matchKey(matchId), 'clockStart', String((await redisNowMs()) - elapsedMs));
  };

  /** 플레이어 i의 다음 lock (seq·frame 자동 증가) */
  const lock = (svc: TetrisBattleRoomService, code: string, matchId: string, i: number, sent: number, now = T0) => {
    const key = `${code}:${i}`;
    seqs[key] = (seqs[key] ?? 0) + 1;
    return svc.lock(
      code,
      who(i).socketId,
      { matchId, seq: seqs[key], frame: seqs[key] * 10, sent, combo: sent > 0 ? 1 : -1, b2b: false, board: EMPTY_BOARD, pending: 0 },
      now,
    );
  };

  beforeAll(async () => {
    a = new TetrisBattleRoomService();
    b = new TetrisBattleRoomService();
    for (const svc of [a, b]) {
      const c = new Redis({ host: '127.0.0.1', port, keyPrefix: PREFIX });
      clients.push(c);
      await waitReady(c);
      svc.setRedisClient(c);
    }
  });

  beforeEach(() => {
    seqs = {};
  });

  afterAll(async () => {
    const raw = new Redis({ host: '127.0.0.1', port });
    const keys = await raw.keys(`${PREFIX}*`);
    if (keys.length) await raw.del(...keys);
    await raw.quit();
    await Promise.all(clients.map((c) => c.quit()));
  });

  it('시작: 방 PLAYING, seed 범위, 매치·가비지 키 TTL, 시작 후 새 입장 불가', async () => {
    const { code, matchId, seed } = await startMatchWith(2);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(4294967295);
    expect(await clients[0].ttl(matchKey(matchId))).toBeGreaterThan(0);

    await lock(a, code, matchId, 1, 2);
    expect(await clients[0].ttl(garbageLogKey(matchId, 'p2'))).toBeGreaterThan(0);
    await expect(codeOf(a.joinRoom({ code, playerName: '늦은자' }, who(9)))).resolves.toBe('MATCH_ALREADY_STARTED');
  });

  it('대상 순환(공격자별 커서): 3인에서 p1의 공격은 p2→p3→p2…, 받는 쪽 id는 각자 1부터 단조 증가', async () => {
    const { code, matchId } = await startMatchWith(3);
    const outs = [];
    for (let k = 0; k < 4; k++) outs.push(await lock(a, code, matchId, 1, 1));

    expect(outs.map((o) => o.garbage?.payload.from)).toEqual(['p1', 'p1', 'p1', 'p1']);
    expect(outs.map((o) => o.attack?.to)).toEqual(['p2', 'p3', 'p2', 'p3']);
    expect(outs.map((o) => o.garbage?.payload.id)).toEqual([1, 1, 2, 2]);
    expect(outs.map((o) => o.targetId)).toEqual(['p3', 'p2', 'p3', 'p2']); // ack = 다음 대상
    for (const o of outs) expect(o.garbage?.payload.hole).toEqual(expect.any(Number));

    // p2의 공격은 p2 자신의 커서로 돈다 (p1의 순서에 영향 없음)
    const fromP2 = await lock(b, code, matchId, 2, 3);
    expect(fromP2.attack).toEqual({ matchId, from: 'p2', to: 'p3', lines: 3 });
    expect(fromP2.garbage?.payload.id).toBe(3); // p3가 받은 세 번째

    // 공격 없는 lock은 라우팅 없음, 대상 미리보기만
    const quiet = await lock(a, code, matchId, 1, 0);
    expect(quiet.garbage).toBeNull();
    expect(quiet.targetId).toBe('p2'); // 마지막 대상이 p3였으니 다음은 p2
  });

  it('seq 중복은 성공·방송 없음, seq 역행·frame 비증가는 INVALID_PAYLOAD', async () => {
    const { code, matchId } = await startMatchWith(2);
    const base = { matchId, combo: -1, b2b: false, board: EMPTY_BOARD, pending: 0 };
    const first = await a.lock(code, who(1).socketId, { ...base, seq: 5, frame: 100, sent: 2 }, T0);
    const dup = await b.lock(code, who(1).socketId, { ...base, seq: 5, frame: 100, sent: 2 }, T0);

    expect(first.garbage?.payload.id).toBe(1);
    expect(dup).toMatchObject({ duplicate: true, garbage: null, attack: null, opponentUpdate: null, targetId: 'p2' });
    await expect(codeOf(a.lock(code, who(1).socketId, { ...base, seq: 4, frame: 200, sent: 0 }, T0))).resolves.toBe('INVALID_PAYLOAD');
    await expect(codeOf(a.lock(code, who(1).socketId, { ...base, seq: 6, frame: 100, sent: 0 }, T0))).resolves.toBe('INVALID_PAYLOAD');
    // 다음 정상 lock의 가비지 id는 2 (중복이 id를 소모하지 않았다)
    const next = await a.lock(code, who(1).socketId, { ...base, seq: 6, frame: 101, sent: 1 }, T0);
    expect(next.garbage?.payload.id).toBe(2);
  });

  it('KO 귀속·순위·종료 1회: by = 마지막 공격자, place = 남은 생존자 + 1, 우승자 place 1, 방 RESULT', async () => {
    const { code, matchId } = await startMatchWith(3);
    await lock(a, code, matchId, 1, 2); // p1 → p2
    await lock(a, code, matchId, 3, 1); // p3 → p1

    const ko1 = await b.topOut(code, who(2).socketId, { matchId, frame: 999 }, T0);
    expect(ko1.match.kos).toEqual([{ matchId, playerId: 'p2', by: 'p1', place: 3, reason: 'topout' }]);
    expect(ko1.match.ended).toBeNull();

    // 탈락한 플레이어의 늦은 lock / 중복 topOut
    await expect(codeOf(lock(a, code, matchId, 2, 1))).resolves.toBe('PLAYER_NOT_ALIVE');
    await expect(a.topOut(code, who(2).socketId, { matchId, frame: 999 }, T0)).resolves.toMatchObject({ match: { kos: [] } });

    // 3인에서 p1은 이제 p3만 공격한다
    expect((await lock(a, code, matchId, 1, 1)).attack?.to).toBe('p3');

    const ko2 = await a.topOut(code, who(3).socketId, { matchId, frame: 1200 }, T0);
    expect(ko2.match.kos).toEqual([{ matchId, playerId: 'p3', by: 'p1', place: 2, reason: 'topout' }]);
    const ended = ko2.match.ended as MatchEndedPayload;
    expect(ended.results.map((r) => [r.playerId, r.place, r.kos])).toEqual([
      ['p1', 1, 2],
      ['p3', 2, 0],
      ['p2', 3, 0],
    ]);
    expect(ended.results.find((r) => r.playerId === 'p2')).toMatchObject({ received: 2, frames: 999 });
    expect(ended.results.find((r) => r.playerId === 'p1')).toMatchObject({ sent: 3, received: 1, pieces: 2 });
    expect(ko2.roomChange?.room?.status).toBe('RESULT');

    // 끝난 매치에 늦게 온 lock은 무시하고 성공(리뷰 H7) — 다른 matchId는 MATCH_NOT_FOUND
    await expect(lock(a, code, matchId, 1, 1)).resolves.toMatchObject({ targetId: null, garbage: null });
    await expect(
      codeOf(a.lock(code, who(1).socketId, { matchId: 'z'.repeat(16), seq: 99, frame: 9999, sent: 0, combo: -1, b2b: false, board: EMPTY_BOARD, pending: 0 }, T0)),
    ).resolves.toBe('MATCH_NOT_FOUND');
  });

  it('경기 중 이탈 = 기권 KO(leave) — 2인이면 바로 종료·RESULT', async () => {
    const { code, matchId } = await startMatchWith(2);
    await lock(a, code, matchId, 2, 4); // p2 → p1
    const left = await a.leaveRoom(code, who(1).socketId, T0);

    expect(left.match?.kos).toEqual([{ matchId, playerId: 'p1', by: 'p2', place: 2, reason: 'leave' }]);
    expect(left.match?.ended?.results.map((r) => r.playerId)).toEqual(['p2', 'p1']);
    expect(left.room).toMatchObject({ status: 'RESULT', hostId: 'p2' });
  });

  it('끊김 유예(10초) 초과는 다른 플레이어의 lock에서 KO(disconnect) — 그 전에는 아니다', async () => {
    const { code, matchId } = await startMatchWith(3);
    await a.markDisconnected(code, who(3).socketId, T0);

    const before = await lock(a, code, matchId, 1, 0, T0 + DISCONNECT_GRACE_MS - 1);
    expect(before.match.kos).toEqual([]);
    const after = await lock(b, code, matchId, 2, 0, T0 + DISCONNECT_GRACE_MS);
    expect(after.match.kos).toEqual([{ matchId, playerId: 'p3', by: null, place: 3, reason: 'disconnect' }]);
  });

  it('재연결: lastGarbageId 이후 가비지·상대 판 복구, 끊김 표시를 지워 유예 KO되지 않는다', async () => {
    const { code, matchId, tokens } = await startMatchWith(2);
    await a.markDisconnected(code, who(2).socketId, T0);
    await lock(a, code, matchId, 1, 2, T0 + 1); // p2가 끊긴 동안 받은 가비지 id 1, 2
    await lock(a, code, matchId, 1, 3, T0 + 2);

    const back = await b.joinRoom({ code, playerName: '플2', playerToken: tokens[1], lastGarbageId: 1 }, who(20), T0 + 3);
    expect(back.rejoin).toEqual({
      match: { matchId, seed: expect.any(Number), status: 'PLAYING', alive: true },
      missedGarbage: [{ matchId, id: 2, lines: 3, hole: expect.any(Number), from: 'p1' }],
      opponents: [{ playerId: 'p1', board: EMPTY_BOARD, pending: 0, alive: true }],
    });

    // 유예가 지나도 KO되지 않는다(재연결로 끊김 표시가 지워짐)
    const later = await lock(a, code, matchId, 1, 0, T0 + DISCONNECT_GRACE_MS * 3);
    expect(later.match.kos).toEqual([]);
  });

  it('리뷰 J1: 재연결 처리 중 그 소켓이 끊기면 끊김 기록이 남아 유예 뒤 KO된다(영구 생존 아님)', async () => {
    const { code, matchId, tokens } = await startMatchWith(2);
    await a.markDisconnected(code, who(2).socketId, T0);

    await a.joinRoom({ code, playerName: '플2', playerToken: tokens[1] }, who(21), T0 + 1, undefined, async () => {
      await a.markDisconnected(code, who(21).socketId, T0 + 1); // 채널 입장 시점에 이미 끊김
    });
    expect(await clients[0].hget(matchKey(matchId), 'p:p2:discAt')).toBe(String(T0 + 1));

    const later = await lock(b, code, matchId, 1, 0, T0 + 1 + DISCONNECT_GRACE_MS);
    expect(later.match.kos).toEqual([{ matchId, playerId: 'p2', by: null, place: 2, reason: 'disconnect' }]);
  });

  it('유예가 지난 뒤의 재연결은 먼저 KO 처리되고 rejoin.match.alive=false', async () => {
    const { code, tokens } = await startMatchWith(3);
    await a.markDisconnected(code, who(3).socketId, T0);
    const back = await a.joinRoom({ code, playerName: '플3', playerToken: tokens[2] }, who(30), T0 + DISCONNECT_GRACE_MS);

    expect(back.match?.kos.map((k) => [k.playerId, k.reason])).toEqual([['p3', 'disconnect']]);
    expect(back.rejoin?.match.alive).toBe(false);
  });

  it('S1(리뷰 H3): 상대가 유예를 넘겨 끊긴 상태에서 내가 topOut — 유예 KO로 이미 끝났으면 승자인 나는 KO되지 않는다', async () => {
    const { code, matchId } = await startMatchWith(2);
    await a.markDisconnected(code, who(2).socketId, T0);

    const out = await a.topOut(code, who(1).socketId, { matchId, frame: 500 }, T0 + DISCONNECT_GRACE_MS);

    expect(out.match.kos).toEqual([{ matchId, playerId: 'p2', by: null, place: 2, reason: 'disconnect' }]);
    expect(out.match.ended?.results.map((r) => [r.playerId, r.place])).toEqual([
      ['p1', 1],
      ['p2', 2],
    ]);
  });

  it('S2(리뷰 H3): 둘 다 유예를 넘겨 끊김 — 정리는 한 명만 KO하고 남은 한 명이 우승', async () => {
    const { code, tokens } = await startMatchWith(2);
    await a.markDisconnected(code, who(1).socketId, T0);
    await a.markDisconnected(code, who(2).socketId, T0);

    // p1이 늦게 재연결 → 정리(sweep)가 p1부터 KO → 2인이라 그 즉시 끝 → p2는 KO되지 않는다
    const back = await a.joinRoom({ code, playerName: '플1', playerToken: tokens[0] }, who(10), T0 + DISCONNECT_GRACE_MS);

    expect(back.match?.kos).toEqual([expect.objectContaining({ playerId: 'p1', place: 2, reason: 'disconnect' })]);
    expect(back.match?.ended?.results.map((r) => [r.playerId, r.place])).toEqual([
      ['p2', 1],
      ['p1', 2],
    ]);
    expect(back.rejoin?.match).toMatchObject({ status: 'ENDED', alive: false });
  });

  it('리뷰 H7: 끝난 매치에 늦게 온 승자의 topOut·lock은 무시하고 성공(이벤트 없음)', async () => {
    const { code, matchId } = await startMatchWith(2);
    await a.topOut(code, who(2).socketId, { matchId, frame: 100 }, T0);

    await expect(b.topOut(code, who(1).socketId, { matchId, frame: 101 }, T0)).resolves.toEqual({
      match: { matchId, kos: [], ended: null },
      roomChange: null,
    });
    await expect(lock(b, code, matchId, 1, 2)).resolves.toMatchObject({ targetId: null, garbage: null, attack: null });
  });

  it('리뷰 H6: 매치가 끝난 뒤의 끊김은 매치 키를 건드리지 않는다(PLAYING일 때만 기록)', async () => {
    const { code, matchId } = await startMatchWith(2);
    await a.topOut(code, who(2).socketId, { matchId, frame: 100 }, T0);
    await clients[0].hdel(matchKey(matchId), 'p:p1:discAt');

    await a.markDisconnected(code, who(1).socketId, T0); // 방은 RESULT
    expect(await clients[0].hexists(matchKey(matchId), 'p:p1:discAt')).toBe(0);

    // 없는 매치 키에 기록해도 키를 만들지 않는다(TTL 없는 키 방지)
    await clients[0].del(matchKey(matchId));
    await new TetrisBattleMatchStore().setDisconnectedAt(clients[0], matchId, 'p1', T0);
    expect(await clients[0].exists(matchKey(matchId))).toBe(0);
  });

  it('rematch: RESULT → WAITING, 전원 ready=false, 방장만', async () => {
    const { code, matchId } = await startMatchWith(2);
    await a.topOut(code, who(2).socketId, { matchId, frame: 10 }, T0);

    await expect(codeOf(a.rematch(code, who(2).socketId, T0))).resolves.toBe('NOT_HOST');
    const change = await b.rematch(code, who(1).socketId, T0);
    expect(change.room).toMatchObject({ status: 'WAITING' });
    expect(change.room?.players.every((p) => !p.ready)).toBe(true);
    // 이전 매치 기록은 TTL 동안 남는다(P5)
    expect(await clients[0].exists(matchKey(matchId))).toBe(1);
  });

  describe('lock 남발 상한 — 게임 시간 근거 (메인 결정 7)', () => {
    const base = (matchId: string) => ({ matchId, sent: 0, combo: -1, b2b: false, board: EMPTY_BOARD, pending: 0 });

    it('경기 시작(카운트다운 3초) 전의 lock은 거부한다', async () => {
      const created = await a.createRoom({ name: '시계', maxPlayers: 2, playerName: '플1' }, who(1), T0);
      const code = created.room.code;
      await a.joinRoom({ code, playerName: '플2' }, who(2), T0);
      for (const i of [1, 2]) await a.setReady(code, who(i).socketId, true, T0);
      const { starting } = await a.startMatch(code, who(1).socketId, T0); // 시계를 돌리지 않는다

      // 지금은 서버 기준 약 -3초 → 상한 ≈ -180 + 120 = -60프레임
      await expect(codeOf(a.lock(code, who(1).socketId, { ...base(starting.matchId), seq: 1, frame: 1 }, T0))).resolves.toBe(
        'INVALID_PAYLOAD',
      );
    });

    it(`frame 상한 = 경과 시간 × 60 + ${LOCK_FRAME_SLACK}: 경계 안쪽은 통과, 미래 프레임은 거부`, async () => {
      const { code, matchId } = await startMatchWith(2);
      await backdate(matchId, 10_000); // 10초 경과 → 상한 ≈ 600 + 120 = 720 (테스트가 도는 동안 조금씩 커진다)

      await expect(codeOf(a.lock(code, who(1).socketId, { ...base(matchId), seq: 1, frame: 715 }, T0))).resolves.toBe('OK');
      await expect(codeOf(a.lock(code, who(1).socketId, { ...base(matchId), seq: 2, frame: 1_000 }, T0))).resolves.toBe(
        'INVALID_PAYLOAD',
      );
      // 거부된 보고는 상태를 바꾸지 않았다 — 같은 seq를 정상 프레임으로 다시 보낼 수 있다
      await expect(codeOf(a.lock(code, who(1).socketId, { ...base(matchId), seq: 2, frame: 716 }, T0))).resolves.toBe('OK');
    });

    it('seq 증가분 ≤ floor(frame 증가분 / 6) + 1 — 경계 통과·초과 거부', async () => {
      const { code, matchId } = await startMatchWith(2);
      const send = (seq: number, frame: number) => codeOf(a.lock(code, who(1).socketId, { ...base(matchId), seq, frame }, T0));

      await expect(send(3, 6)).resolves.toBe('INVALID_PAYLOAD'); // 첫 보고: 0→6프레임에 3개 (허용 2)
      await expect(send(2, 6)).resolves.toBe('OK'); //                              2개는 허용
      await expect(send(4, 17)).resolves.toBe('OK'); // +2개, +11프레임 → 허용 floor(11/6)+1 = 2
      await expect(send(6, 22)).resolves.toBe('INVALID_PAYLOAD'); // +2개, +5프레임 → 허용 1
      await expect(send(5, 22)).resolves.toBe('OK'); // +1개는 간격과 무관하게 허용
    });

    it.each((golden as unknown as { name: string; input: BattleReplayInput }[]).map((c) => [c.name, c.input] as const))(
      '정상 플레이 골든 입력(%s)의 모든 고정 보고가 거부되지 않는다',
      async (_name, input) => {
        // 골든 리플레이를 래퍼로 재생해 실제 lock 순서(seq·frame·sent)를 뽑는다 (simulateBattleReplay와 같은 루프)
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
          const { lock: l } = stepBattle(bs, buffer, count);
          if (l) locks.push(l);
        }
        expect(locks.length).toBeGreaterThan(0);

        const { code, matchId } = await startMatchWith(2);
        // 경과 시간 = 마지막 고정 프레임만큼(여유 없이) — 실제 속도로 플레이한 것과 같은 조건
        await backdate(matchId, Math.ceil((locks[locks.length - 1].frame * 1000) / 60));
        const rejected: string[] = [];
        for (const l of locks) {
          const r = await codeOf(
            a.lock(code, who(1).socketId, { ...base(matchId), seq: l.seq, frame: l.frame, sent: Math.min(l.sent, 22) }, T0),
          );
          if (r !== 'OK') rejected.push(`seq ${l.seq} frame ${l.frame}: ${r}`);
        }
        expect(rejected).toEqual([]);
      },
    );
  });

  it('부하: 4인이 두 레플리카에서 각자 60번 lock을 동시에 보내도 ROOM_BUSY 등 오류 0, 가비지 id 연속·송수신 합 일치', async () => {
    const { code, matchId } = await startMatchWith(4);
    const LOCKS = 60;
    const sentBy: Record<string, number> = {};

    const outcomes = await Promise.all(
      [1, 2, 3, 4].map(async (i) => {
        const errors: string[] = [];
        for (let k = 0; k < LOCKS; k++) {
          const sent = (k * i) % 4; // 0~3 섞어서
          const r = await codeOf(lock(i % 2 ? a : b, code, matchId, i, sent));
          if (r !== 'OK') errors.push(r);
          else sentBy[`p${i}`] = (sentBy[`p${i}`] ?? 0) + sent;
        }
        return errors;
      }),
    );
    expect(outcomes.flat()).toEqual([]);

    const snap = await clients[0].hgetall(matchKey(matchId));
    let totalReceived = 0;
    for (const pid of ['p1', 'p2', 'p3', 'p4']) {
      const log = (await clients[0].lrange(garbageLogKey(matchId, pid), 0, -1)).map(
        (e) => JSON.parse(e) as { id: number; lines: number },
      );
      expect(log.map((e) => e.id)).toEqual(log.map((_, idx) => idx + 1)); // 1..n 연속
      expect(Number(snap[`p:${pid}:recv`] ?? 0)).toBe(log.reduce((s, e) => s + e.lines, 0));
      expect(Number(snap[`p:${pid}:sent`] ?? 0)).toBe(sentBy[pid] ?? 0);
      expect(Number(snap[`p:${pid}:seq`])).toBe(LOCKS);
      totalReceived += Number(snap[`p:${pid}:recv`] ?? 0);
    }
    expect(totalReceived).toBe(Object.values(sentBy).reduce((s, v) => s + v, 0));
  });
});

import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DISCONNECT_GRACE_MS, MATCH_START_DELAY_MS } from './tetris-battle.constants';
import { BOARD_BYTES } from './tetris-battle.events';
import { MatchSnapshot, TetrisBattleMatchStore } from './tetris-battle-match.store';
import { SocketIdentity, TetrisBattleRoomService } from './tetris-battle-room.service';
import { createRedisMock, expectCode } from './__spec__/redis-mock';

const T0 = 1_800_000_000_000;
const A: SocketIdentity = { socketId: 'sock-a', userId: 42, ip: '10.0.0.1' };
const B: SocketIdentity = { socketId: 'sock-b', userId: null, ip: '10.0.0.2' };
const C: SocketIdentity = { socketId: 'sock-c', userId: null, ip: '10.0.0.3' };
const BOARD = Buffer.alloc(BOARD_BYTES).toString('base64');

const lockInput = (matchId: string, over: Partial<{ seq: number; frame: number; sent: number; board: string }> = {}) => ({
  matchId,
  seq: 1,
  frame: 10,
  sent: 0,
  combo: -1,
  b2b: false,
  board: BOARD,
  pending: 0,
  ...over,
});

const okLock = (over: Partial<Awaited<ReturnType<TetrisBattleMatchStore['lock']>>> = {}) => ({
  ok: true,
  dup: false,
  target: null,
  gid: 0,
  nextTarget: 'p2',
  kos: [],
  ended: false,
  ...over,
});

const snapshotOf = (matchId: string, players: Partial<MatchSnapshot['players'][number]>[]): MatchSnapshot => ({
  matchId,
  code: 'X',
  seed: 1,
  startedAt: T0,
  status: 'ENDED',
  roomName: '방',
  clockStart: null,
  endedClock: null,
  endedAt: null,
  players: players.map((p, i) => ({
    playerId: `p${i + 1}`,
    name: `n${i + 1}`,
    userId: null,
    alive: false,
    seq: 0,
    frame: 0,
    pieces: 0,
    sent: 0,
    received: 0,
    maxCombo: 0,
    kos: 0,
    board: null,
    pending: 0,
    combo: -1,
    b2b: false,
    place: null,
    frames: null,
    koReason: null,
    disconnectedAt: null,
    tokenHash: null,
    koClock: null,
    ...p,
  })),
});

/**
 * 매치(P2)의 **TS 쪽 조립** — 매치 저장소(Lua)는 경계에서 대역으로 바꾼다.
 * Lua 안의 규칙(대상 순환·KO 귀속·순위·seq 검증·유예 KO)은 실제 Redis 스펙 `test/tetris-battle-match.redis.e2e-spec.ts`가 정본이다.
 * 여기서는: 시작 조건, 방 상태 전이(PLAYING·RESULT·WAITING), 멤버·matchId·판 검증, 저장소 결과 → 방송 이벤트 변환,
 * 끊김·이탈·재연결이 매치 저장소를 올바르게 부르는지를 본다.
 */
describe('TetrisBattleRoomService — 매치(P2)', () => {
  let service: TetrisBattleRoomService;
  let mock: ReturnType<typeof createRedisMock>;
  let store: Record<
    'create' | 'remove' | 'lock' | 'knockOut' | 'setDisconnectedAt' | 'snapshot' | 'garbageSince' | 'setTokenHash',
    jest.SpyInstance
  >;

  /** 2~3인 방, 전원 ready */
  const readyRoom = async (players: SocketIdentity[] = [A, B]) => {
    const created = await service.createRoom({ name: '방', maxPlayers: 4, playerName: '방장' }, players[0], T0);
    const code = created.room.code;
    const tokens = [created.playerToken];
    for (const [i, who] of players.slice(1).entries()) {
      tokens.push((await service.joinRoom({ code, playerName: `참가${i}` }, who, T0)).playerToken);
    }
    for (const who of players) await service.setReady(code, who.socketId, true, T0);
    return { code, tokens };
  };

  const started = async (players: SocketIdentity[] = [A, B]) => {
    const room = await readyRoom(players);
    const s = await service.startMatch(room.code, A.socketId, T0);
    return { ...room, matchId: s.starting.matchId };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mock = createRedisMock();
    service = new TetrisBattleRoomService();
    service.setRedisClient(mock.redis as unknown as Redis);
    const proto = TetrisBattleMatchStore.prototype;
    store = {
      create: jest.spyOn(proto, 'create').mockResolvedValue(undefined),
      remove: jest.spyOn(proto, 'remove').mockResolvedValue(undefined),
      lock: jest.spyOn(proto, 'lock').mockResolvedValue(okLock()),
      knockOut: jest.spyOn(proto, 'knockOut').mockResolvedValue({ ok: true, kos: [], ended: false }),
      setDisconnectedAt: jest.spyOn(proto, 'setDisconnectedAt').mockResolvedValue(undefined),
      snapshot: jest.spyOn(proto, 'snapshot').mockResolvedValue(null),
      garbageSince: jest.spyOn(proto, 'garbageSince').mockResolvedValue([]),
      setTokenHash: jest.spyOn(proto, 'setTokenHash').mockResolvedValue(undefined),
    };
  });

  afterEach(() => jest.restoreAllMocks());

  describe('startMatch', () => {
    it('방장·WAITING·2명↑·전원 연결·준비면 PLAYING + matchStarting(3초 뒤, seed, 참가자)', async () => {
      const { code } = await readyRoom([A, B, C]);
      const result = await service.startMatch(code, A.socketId, T0);

      expect(result.room?.status).toBe('PLAYING');
      expect(result.lobbyChanged).toBe(true);
      expect(result.starting).toEqual({
        matchId: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
        seed: expect.any(Number),
        startInMs: MATCH_START_DELAY_MS,
        startAt: new Date(T0 + MATCH_START_DELAY_MS).toISOString(),
        players: [
          { playerId: 'p1', name: '방장' },
          { playerId: 'p2', name: '참가0' },
          { playerId: 'p3', name: '참가1' },
        ],
      });
      expect(result.starting.seed).toBeGreaterThanOrEqual(0);
      expect(result.starting.seed).toBeLessThanOrEqual(4294967295);
      expect(store.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ matchId: result.starting.matchId, code, players: expect.arrayContaining([expect.objectContaining({ playerId: 'p1', userId: 42 })]) }),
      );
      expect(mock.readRoom(code)?.match).toMatchObject({ matchId: result.starting.matchId, playerIds: ['p1', 'p2', 'p3'] });
    });

    it.each([
      ['방장이 아님', async (code: string) => service.startMatch(code, B.socketId, T0), 'NOT_HOST'],
      ['비멤버', async (code: string) => service.startMatch(code, C.socketId, T0), 'NOT_IN_ROOM'],
    ] as const)('%s → %s (매치를 만들지 않는다)', async (_label, call, errorCode) => {
      const { code } = await readyRoom();
      await expectCode(call(code), errorCode);
      expect(store.create).not.toHaveBeenCalled();
    });

    it('방장은 ready가 아니어도 시작할 수 있다(시작 버튼이 곧 준비, D-019)', async () => {
      const { code } = await readyRoom([A, B, C]);
      await service.setReady(code, A.socketId, false, T0);
      await expect(service.startMatch(code, A.socketId, T0)).resolves.toMatchObject({ room: { status: 'PLAYING' } });
    });

    it('혼자면 NOT_ENOUGH_PLAYERS', async () => {
      const created = await service.createRoom({ name: '방', maxPlayers: 4, playerName: '방장' }, A, T0);
      await service.setReady(created.room.code, A.socketId, true, T0);
      await expectCode(service.startMatch(created.room.code, A.socketId, T0), 'NOT_ENOUGH_PLAYERS');
    });

    it('방장 외 한 명이라도 준비 안 했거나, 누구든(방장 포함) 끊겨 있으면 NOT_ALL_READY', async () => {
      const { code } = await readyRoom([A, B, C]);
      await service.setReady(code, C.socketId, false, T0);
      await expectCode(service.startMatch(code, A.socketId, T0), 'NOT_ALL_READY');

      await service.setReady(code, C.socketId, true, T0);
      await service.markDisconnected(code, C.socketId, T0);
      await expectCode(service.startMatch(code, A.socketId, T0 + 1), 'NOT_ALL_READY');
    });

    it('이미 진행 중이면 MATCH_ALREADY_STARTED', async () => {
      const { code } = await started();
      await expectCode(service.startMatch(code, A.socketId, T0), 'MATCH_ALREADY_STARTED');
    });

    it('매치 생성과 방 저장 사이에 참가자가 바뀌면 ROOM_BUSY, 만든 매치 키는 지운다', async () => {
      const { code } = await readyRoom([A, B, C]);
      store.create.mockImplementationOnce(async () => {
        mock.patchRoom(code, (r) => r.players.pop()); // 그 사이 C가 나감 (남은 2명은 시작 조건을 만족)
      });
      await expectCode(service.startMatch(code, A.socketId, T0), 'ROOM_BUSY');
      expect(store.remove).toHaveBeenCalled();
      expect(mock.readRoom(code)?.status).toBe('WAITING');
    });
  });

  describe('lock', () => {
    it('대상이 있으면 대상 소켓에 garbage, 방에 attack, 본인 제외에 opponentUpdate, ack는 다음 대상', async () => {
      const { code, matchId } = await started();
      store.lock.mockResolvedValueOnce(okLock({ target: 'p2', gid: 3, nextTarget: 'p2' }));

      const out = await service.lock(code, A.socketId, lockInput(matchId, { sent: 4 }), T0);

      expect(store.lock).toHaveBeenCalledWith(
        expect.anything(),
        matchId,
        ['p1', 'p2'],
        expect.objectContaining({ playerId: 'p1', seq: 1, frame: 10, sent: 4, hole: expect.any(Number) }),
        T0,
      );
      const hole = (store.lock.mock.calls[0][3] as { hole: number }).hole;
      expect(hole).toBeGreaterThanOrEqual(0);
      expect(hole).toBeLessThanOrEqual(9);
      expect(out).toMatchObject({
        targetId: 'p2',
        duplicate: false,
        garbage: { toPlayerId: 'p2', payload: { matchId, id: 3, lines: 4, hole, from: 'p1' } },
        attack: { matchId, from: 'p1', to: 'p2', lines: 4 },
        opponentUpdate: { matchId, playerId: 'p1', board: BOARD, pending: 0, combo: -1, b2b: false },
        roomChange: null,
      });
    });

    it('대상이 끊겨 있어도 garbage는 대상 플레이어 채널로 보낸다(재연결 직후 소켓이 받거나 lastGarbageId로 복구, 리뷰 H2)', async () => {
      const { code, matchId } = await started();
      await service.markDisconnected(code, B.socketId, T0);
      store.lock.mockResolvedValueOnce(okLock({ target: 'p2', gid: 1 }));

      const out = await service.lock(code, A.socketId, lockInput(matchId, { sent: 1 }), T0);
      expect(out.garbage?.toPlayerId).toBe('p2');
    });

    it('종료 판정을 받았어도 방이 이미 RESULT(다른 요청이 먼저 전이)면 matchEnded를 싣지 않는다 (리뷰 H4)', async () => {
      const { code, matchId } = await started();
      store.lock.mockImplementationOnce(async () => {
        mock.patchRoom(code, (r) => (r.status = 'RESULT'));
        return okLock({ ended: true, kos: [{ playerId: 'p2', by: 'p1', place: 2, reason: 'disconnect' }] });
      });

      const out = await service.lock(code, A.socketId, lockInput(matchId), T0);
      expect(out.match.kos).toHaveLength(1);
      expect(out.match.ended).toBeNull();
      expect(out.roomChange).toBeNull();
    });

    it('종료 반영(방 CAS)이 실패해도 lock은 성공하고 확정된 KO는 싣는다 (리뷰 H5)', async () => {
      const { code, matchId } = await started();
      store.lock.mockImplementationOnce(async () => {
        mock.state.forceCasConflicts = 100; // 이후 방 CAS가 전부 충돌 → ROOM_BUSY
        return okLock({ ended: true, kos: [{ playerId: 'p2', by: 'p1', place: 2, reason: 'topout' }] });
      });

      const out = await service.lock(code, A.socketId, lockInput(matchId), T0);
      mock.state.forceCasConflicts = 0;
      expect(out.match.kos).toEqual([{ matchId, playerId: 'p2', by: 'p1', place: 2, reason: 'topout' }]);
      expect(out.match.ended).toBeNull();
      expect(mock.readRoom(code)?.status).toBe('PLAYING'); // 생존 확인 경로가 나중에 마저 반영
    });

    it('이 방의 직전 매치가 끝난(RESULT) 뒤 늦게 온 lock·topOut은 무시하고 성공, 다른 matchId는 MATCH_NOT_FOUND (리뷰 H7)', async () => {
      const { code, matchId } = await started();
      mock.patchRoom(code, (r) => (r.status = 'RESULT'));

      await expect(service.lock(code, A.socketId, lockInput(matchId), T0)).resolves.toMatchObject({
        targetId: null,
        garbage: null,
        attack: null,
        opponentUpdate: null,
      });
      await expect(service.topOut(code, A.socketId, { matchId, frame: 10 }, T0)).resolves.toEqual({
        match: { matchId, kos: [], ended: null },
        roomChange: null,
      });
      expect(store.lock).not.toHaveBeenCalled();
      expect(store.knockOut).not.toHaveBeenCalled();
      await expectCode(service.lock(code, A.socketId, lockInput('z'.repeat(16)), T0), 'MATCH_NOT_FOUND');
    });

    it('Lua MATCH_ENDED인데 방이 PLAYING(종료 반영 실패 후)이면 lock이 RESULT 전이·matchEnded를 마저 한다 (리뷰 J3)', async () => {
      const listener = jest.fn();
      service.setMatchListener(listener);
      const { code, matchId } = await started();
      store.lock.mockResolvedValueOnce(okLock({ ok: false, code: 'MATCH_ENDED' }));
      store.snapshot.mockResolvedValueOnce(snapshotOf(matchId, [{ place: 1 }, { place: 2 }]));

      const out = await service.lock(code, A.socketId, lockInput(matchId), T0);
      expect(out).toMatchObject({ targetId: null, garbage: null, roomChange: { room: { status: 'RESULT' } } });
      expect(out.match.ended?.matchId).toBe(matchId); // 결과로 돌려줘 게이트웨이가 방송
      expect(mock.readRoom(code)?.status).toBe('RESULT');
      expect(listener).not.toHaveBeenCalled();
    });

    it('topOut도 MATCH_ENDED면 종료 반영을 마저 한다 (리뷰 J3)', async () => {
      const { code, matchId } = await started();
      store.knockOut.mockResolvedValueOnce({ ok: false, code: 'MATCH_ENDED', kos: [], ended: false });
      store.snapshot.mockResolvedValueOnce(snapshotOf(matchId, [{ place: 1 }, { place: 2 }]));

      const out = await service.topOut(code, A.socketId, { matchId, frame: 10 }, T0);
      expect(out.roomChange?.room?.status).toBe('RESULT');
      expect(out.match.ended?.results).toHaveLength(2);
    });

    it('Lua가 MATCH_ENDED(방은 아직 PLAYING)를 돌려주면 lock·topOut 모두 무시하고 성공 (리뷰 H7)', async () => {
      const { code, matchId } = await started();
      store.lock.mockResolvedValueOnce(okLock({ ok: false, code: 'MATCH_ENDED' }));
      store.knockOut.mockResolvedValueOnce({ ok: false, code: 'MATCH_ENDED', kos: [], ended: false });

      await expect(service.lock(code, A.socketId, lockInput(matchId), T0)).resolves.toMatchObject({ targetId: null, garbage: null });
      await expect(service.topOut(code, A.socketId, { matchId, frame: 10 }, T0)).resolves.toMatchObject({ match: { kos: [] } });
    });

    it('seq 중복(재전송)이면 방송할 것이 없다', async () => {
      const { code, matchId } = await started();
      store.lock.mockResolvedValueOnce(okLock({ dup: true }));
      await expect(service.lock(code, A.socketId, lockInput(matchId), T0)).resolves.toMatchObject({
        duplicate: true,
        garbage: null,
        attack: null,
        opponentUpdate: null,
      });
    });

    it.each([
      ['PLAYER_NOT_ALIVE', 'PLAYER_NOT_ALIVE'],
      ['LOCK_OUT_OF_ORDER', 'INVALID_PAYLOAD'],
      ['LOCK_TOO_FAST', 'INVALID_PAYLOAD'],
      ['MATCH_NOT_FOUND', 'MATCH_NOT_FOUND'],
    ] as const)('저장소 거부 %s → %s', async (scriptCode, errorCode) => {
      const { code, matchId } = await started();
      store.lock.mockResolvedValueOnce(okLock({ ok: false, code: scriptCode }));
      await expectCode(service.lock(code, A.socketId, lockInput(matchId), T0), errorCode);
    });

    it.each([
      ['칸 값 9', (() => { const b = Buffer.alloc(BOARD_BYTES); b[5] = 9; return b.toString('base64'); })()],
      ['199바이트', Buffer.alloc(BOARD_BYTES - 1).toString('base64').padEnd(268, '=')],
      ['base64 아님', '!'.repeat(268)],
    ])('판이 잘못되면(%s) INVALID_PAYLOAD, 저장소를 부르지 않는다', async (_label, board) => {
      const { code, matchId } = await started();
      await expectCode(service.lock(code, A.socketId, lockInput(matchId, { board }), T0), 'INVALID_PAYLOAD');
      expect(store.lock).not.toHaveBeenCalled();
    });

    it('멤버가 아니면 NOT_IN_ROOM, matchId가 다르거나 경기 중이 아니면 MATCH_NOT_FOUND', async () => {
      const { code, matchId } = await started();
      await expectCode(service.lock(code, C.socketId, lockInput(matchId), T0), 'NOT_IN_ROOM');
      await expectCode(service.lock(code, A.socketId, lockInput('x'.repeat(16)), T0), 'MATCH_NOT_FOUND');

      const waiting = await readyRoom([C, A]);
      await expectCode(service.lock(waiting.code, C.socketId, lockInput(matchId), T0), 'MATCH_NOT_FOUND');
      expect(store.lock).not.toHaveBeenCalled();
    });

    it('종료 판정을 받으면 방을 RESULT로 바꾸고 순위순 결과를 싣는다', async () => {
      const { code, matchId } = await started();
      store.lock.mockResolvedValueOnce(
        okLock({ kos: [{ playerId: 'p2', by: null, place: 2, reason: 'disconnect' }], ended: true, nextTarget: null }),
      );
      store.snapshot.mockResolvedValueOnce(
        snapshotOf(matchId, [
          { place: 1, kos: 0, sent: 5, frame: 400 },
          { place: 2, frames: 300, received: 5 },
        ]),
      );

      const out = await service.lock(code, A.socketId, lockInput(matchId), T0);

      expect(out.match).toEqual({
        matchId,
        kos: [{ matchId, playerId: 'p2', by: null, place: 2, reason: 'disconnect' }],
        ended: {
          matchId,
          results: [
            { playerId: 'p1', name: 'n1', place: 1, kos: 0, sent: 5, received: 0, pieces: 0, maxCombo: 0, frames: 400 },
            { playerId: 'p2', name: 'n2', place: 2, kos: 0, sent: 0, received: 5, pieces: 0, maxCombo: 0, frames: 300 },
          ],
        },
      });
      expect(out.roomChange?.room?.status).toBe('RESULT');
      expect(mock.readRoom(code)?.status).toBe('RESULT');
    });

    it('거부된 lock이라도 그 사이 생긴 KO·종료는 matchListener로 방송한다', async () => {
      const listener = jest.fn();
      service.setMatchListener(listener);
      const { code, matchId } = await started();
      store.lock.mockResolvedValueOnce(
        okLock({ ok: false, code: 'MATCH_NOT_FOUND', kos: [{ playerId: 'p2', by: 'p1', place: 2, reason: 'disconnect' }], ended: true }),
      );

      await expectCode(service.lock(code, A.socketId, lockInput(matchId), T0), 'MATCH_NOT_FOUND');
      expect(listener).toHaveBeenCalledWith(code, expect.objectContaining({ kos: [expect.objectContaining({ playerId: 'p2' })], ended: expect.anything() }));
    });
  });

  describe('topOut · 이탈 · 끊김', () => {
    it('topOut은 KO(topout, 보고 프레임)를 요청하고 KO 이벤트를 돌려준다', async () => {
      const { code, matchId } = await started([A, B, C]);
      store.knockOut.mockResolvedValueOnce({ ok: true, kos: [{ playerId: 'p2', by: 'p1', place: 3, reason: 'topout' }], ended: false });

      const out = await service.topOut(code, B.socketId, { matchId, frame: 777 }, T0);

      expect(store.knockOut).toHaveBeenCalledWith(expect.anything(), matchId, ['p1', 'p2', 'p3'], 'p2', 'topout', 777, T0);
      expect(out).toEqual({
        match: { matchId, kos: [{ matchId, playerId: 'p2', by: 'p1', place: 3, reason: 'topout' }], ended: null },
        roomChange: null,
      });
    });

    it('경기 중 leaveRoom은 기권 KO(leave) 후 방에서 빼고, 그로 끝나면 RESULT', async () => {
      const { code, matchId } = await started();
      store.knockOut.mockResolvedValueOnce({ ok: true, kos: [{ playerId: 'p1', by: null, place: 2, reason: 'leave' }], ended: true });
      store.snapshot.mockResolvedValueOnce(snapshotOf(matchId, [{ place: 2 }, { place: 1 }]));

      const change = await service.leaveRoom(code, A.socketId, T0);

      expect(store.knockOut).toHaveBeenCalledWith(expect.anything(), matchId, ['p1', 'p2'], 'p1', 'leave', null, T0);
      expect(change.match?.kos).toEqual([{ matchId, playerId: 'p1', by: null, place: 2, reason: 'leave' }]);
      expect(change.match?.ended?.results.map((r) => r.playerId)).toEqual(['p2', 'p1']);
      expect(change.room).toMatchObject({ status: 'RESULT', hostId: 'p2' });
    });

    it('이탈 판정은 이탈을 커밋한 방 상태로 — 읽을 땐 WAITING이어도 그 사이 시작이 커밋되면 기권 KO (리뷰 H1)', async () => {
      const { code } = await readyRoom();
      const ref = { matchId: 'm'.repeat(16), seed: 1, startedAt: T0, playerIds: ['p1', 'p2'] };
      // 이탈의 첫 CAS 직전에 다른 요청이 시작을 커밋했다
      mock.redis.eval.mockImplementationOnce(async () => {
        mock.patchRoom(code, (r) => {
          r.status = 'PLAYING';
          r.match = ref;
        });
        return 0;
      });

      const change = await service.leaveRoom(code, B.socketId, T0);

      expect(store.knockOut).toHaveBeenCalledWith(expect.anything(), ref.matchId, ['p1', 'p2'], 'p2', 'leave', null, T0);
      expect(change.match?.matchId).toBe(ref.matchId);
    });

    it('경기 중 이탈 후 KO가 실패해도 이탈은 성공하고, 끊김 시각을 남겨 유예 정리가 회수하게 한다 (리뷰 J2)', async () => {
      const { code, matchId } = await started([A, B, C]);
      store.knockOut.mockRejectedValueOnce(new Error('redis down'));

      const change = await service.leaveRoom(code, B.socketId, T0);

      expect(change.room?.players.map((p) => p.playerId)).toEqual(['p1', 'p3']);
      expect(change.match).toBeUndefined();
      expect(store.setDisconnectedAt).toHaveBeenCalledWith(expect.anything(), matchId, 'p2', T0);
    });

    it('KO도 끊김 기록도 실패해도 이탈은 성공한다(로그만) (리뷰 J2)', async () => {
      const { code } = await started([A, B, C]);
      store.knockOut.mockRejectedValueOnce(new Error('redis down'));
      store.setDisconnectedAt.mockRejectedValueOnce(new Error('redis down'));
      await expect(service.leaveRoom(code, B.socketId, T0)).resolves.toMatchObject({ room: { players: [{}, {}] } });
    });

    it('대기실(WAITING) 이탈은 매치를 건드리지 않는다', async () => {
      const { code } = await readyRoom();
      await service.leaveRoom(code, B.socketId, T0);
      expect(store.knockOut).not.toHaveBeenCalled();
    });

    it('경기 중 끊기면 매치에 끊김 시각을 기록한다(유예 뒤 lazy KO의 근거)', async () => {
      const { code, matchId } = await started();
      await service.markDisconnected(code, B.socketId, T0 + 5);
      expect(store.setDisconnectedAt).toHaveBeenCalledWith(expect.anything(), matchId, 'p2', T0 + 5);
      expect(store.setDisconnectedAt).toHaveBeenCalledTimes(1);
    });

    it('끊김 기록 직후 그 플레이어가 이미 다른 소켓으로 재연결돼 있으면 기록을 지운다 (리뷰 H6)', async () => {
      const { code, matchId } = await started();
      store.setDisconnectedAt.mockImplementationOnce(async () => {
        // 끊김 커밋과 이 기록 사이에 재연결이 커밋됐다
        mock.patchRoom(code, (r) => {
          r.players[1].socketId = 'sock-new';
          r.players[1].connected = true;
        });
      });

      await service.markDisconnected(code, B.socketId, T0 + 5);

      expect(store.setDisconnectedAt.mock.calls.map((c) => c[3])).toEqual([T0 + 5, null]);
      expect(store.setDisconnectedAt).toHaveBeenLastCalledWith(expect.anything(), matchId, 'p2', null);
    });

    it('경기 중엔 끊긴 플레이어를 유예가 지나도 방에서 빼지 않는다(순위·결과에 남아야 함)', async () => {
      const { code, matchId } = await started();
      await service.markDisconnected(code, B.socketId, T0);
      await service.lock(code, A.socketId, lockInput(matchId), T0 + DISCONNECT_GRACE_MS * 5);
      expect(mock.readRoom(code)?.players.map((p) => p.playerId)).toEqual(['p1', 'p2']);
    });
  });

  describe('rematch', () => {
    it('RESULT에서 방장이 누르면 WAITING, 전원 ready=false, 매치 참조 제거', async () => {
      const { code } = await started();
      mock.patchRoom(code, (r) => (r.status = 'RESULT'));

      const change = await service.rematch(code, A.socketId, T0);

      expect(change.room).toMatchObject({ status: 'WAITING' });
      expect(change.room?.players.every((p) => !p.ready)).toBe(true);
      expect(mock.readRoom(code)?.match).toBeNull();
    });

    it('PLAYING인데 매치 Hash가 ENDED(종료 반영 실패)면 먼저 RESULT로 반영하고 재대결한다 (리뷰 J3)', async () => {
      const listener = jest.fn();
      service.setMatchListener(listener);
      const { code, matchId } = await started();
      store.snapshot.mockResolvedValue({ ...snapshotOf(matchId, [{ place: 1 }, { place: 2 }]), status: 'ENDED' });

      const change = await service.rematch(code, A.socketId, T0);

      expect(change.room).toMatchObject({ status: 'WAITING' });
      expect(listener).toHaveBeenCalledWith(code, expect.objectContaining({ ended: expect.objectContaining({ matchId }) }));
    });

    it('PLAYING이고 매치도 진행 중이면 그대로 MATCH_ALREADY_STARTED', async () => {
      const { code, matchId } = await started();
      store.snapshot.mockResolvedValue({ ...snapshotOf(matchId, [{}, {}]), status: 'PLAYING' });
      await expectCode(service.rematch(code, A.socketId, T0), 'MATCH_ALREADY_STARTED');
    });

    it.each([
      ['방장이 아님', 'RESULT', B, 'NOT_HOST'],
      ['경기 중', 'PLAYING', A, 'MATCH_ALREADY_STARTED'],
      ['대기 중', 'WAITING', A, 'MATCH_NOT_FOUND'],
    ] as const)('%s → %s', async (_label, status, who, errorCode) => {
      const { code } = await started();
      mock.patchRoom(code, (r) => (r.status = status));
      await expectCode(service.rematch(code, who.socketId, T0), errorCode);
    });
  });

  describe('재연결 복구', () => {
    it('경기 중 토큰 재연결: 유예 정리 → 생존이면 끊김 표시 해제 → 놓친 가비지·상대 판(없으면 빈 판)', async () => {
      const { code, matchId, tokens } = await started();
      await service.markDisconnected(code, B.socketId, T0);
      store.snapshot.mockResolvedValueOnce({
        ...snapshotOf(matchId, [{ alive: true, board: 'BOARD-P1', pending: 3 }, { alive: true }]),
        status: 'PLAYING',
        seed: 77,
      });
      store.garbageSince.mockResolvedValueOnce([{ matchId, id: 2, lines: 3, hole: 4, from: 'p1' }]);

      const back = await service.joinRoom({ code, playerName: '참가0', playerToken: tokens[1], lastGarbageId: 1 }, C, T0 + 1);

      expect(store.knockOut).toHaveBeenCalledWith(expect.anything(), matchId, ['p1', 'p2'], null, 'disconnect', null, T0 + 1);
      expect(store.setDisconnectedAt).toHaveBeenLastCalledWith(expect.anything(), matchId, 'p2', null);
      expect(store.garbageSince).toHaveBeenCalledWith(expect.anything(), matchId, 'p2', 1);
      expect(back.rejoin).toEqual({
        match: { matchId, seed: expect.any(Number), status: 'PLAYING', alive: true },
        missedGarbage: [{ matchId, id: 2, lines: 3, hole: 4, from: 'p1' }],
        opponents: [{ playerId: 'p1', board: 'BOARD-P1', pending: 3, alive: true }],
      });
    });

    it('이미 탈락했으면 alive=false, 끊김 표시는 건드리지 않는다 · 상대가 아직 lock 전이면 빈 판', async () => {
      const { code, matchId, tokens } = await started();
      store.snapshot.mockResolvedValueOnce({ ...snapshotOf(matchId, [{ alive: true }, { alive: false }]), status: 'PLAYING' });

      const back = await service.joinRoom({ code, playerName: '참가0', playerToken: tokens[1] }, C, T0 + 1);

      expect(back.rejoin?.match.alive).toBe(false);
      expect(back.rejoin?.opponents[0].board).toBe(Buffer.alloc(BOARD_BYTES).toString('base64'));
      expect(store.setDisconnectedAt).not.toHaveBeenCalledWith(expect.anything(), matchId, 'p2', null);
    });

    it('채널 입장(afterCommit)은 놓친 가비지 조회보다 먼저 일어난다 (리뷰 H2)', async () => {
      const { code, matchId, tokens } = await started();
      const order: string[] = [];
      store.snapshot.mockResolvedValueOnce({ ...snapshotOf(matchId, [{ alive: true }, { alive: true }]), status: 'PLAYING' });
      store.garbageSince.mockImplementationOnce(async () => (order.push('lrange'), []));

      await service.joinRoom(
        { code, playerName: '참가0', playerToken: tokens[1] },
        C,
        T0 + 1,
        undefined,
        async () => void order.push('join-channels'),
      );
      expect(order).toEqual(['join-channels', 'lrange']);
    });

    it('재연결 처리 중 이 소켓이 끊기면 끊김 기록을 지우지 않는다(영구 생존 방지, 리뷰 J1)', async () => {
      const { code, matchId, tokens } = await started();
      await service.markDisconnected(code, B.socketId, T0);
      store.setDisconnectedAt.mockClear();
      store.snapshot.mockResolvedValueOnce({ ...snapshotOf(matchId, [{ alive: true }, { alive: true }]), status: 'PLAYING' });

      // 커밋 직후(채널 입장 시점) 이 소켓이 끊겨 끊김 처리가 먼저 반영됐다
      const back = await service.joinRoom({ code, playerName: '참가0', playerToken: tokens[1] }, C, T0 + 1, undefined, async () => {
        await service.markDisconnected(code, C.socketId, T0 + 1);
      });

      expect(back.rejoin?.match.alive).toBe(true);
      expect(store.setDisconnectedAt.mock.calls.map((c) => c[3])).toEqual([T0 + 1]); // 끊김 기록만, 해제(null) 없음
    });

    it('경기 중 같은 소켓이 토큰 없이 재입장해 토큰이 재발급되면 매치의 토큰 해시도 갱신한다 (리뷰 L7)', async () => {
      const { code, matchId } = await started();
      const again = await service.joinRoom({ code, playerName: '참가0' }, B, T0 + 1);

      const newHash = mock.readRoom(code)?.players[1].tokenHash;
      expect(store.setTokenHash).toHaveBeenCalledWith(expect.anything(), matchId, 'p2', newHash);
      expect(newHash).toBe(createHash('sha256').update(again.playerToken).digest('hex'));
    });

    it('매치가 없는 방(WAITING)에서의 토큰 재발급은 매치를 건드리지 않는다', async () => {
      const { code } = await readyRoom();
      await service.joinRoom({ code, playerName: '참가0' }, B, T0 + 1);
      expect(store.setTokenHash).not.toHaveBeenCalled();
    });

    it('매치가 없는 방(WAITING)의 재연결은 rejoin 없음', async () => {
      const { code, tokens } = await readyRoom();
      const back = await service.joinRoom({ code, playerName: '참가0', playerToken: tokens[1] }, C, T0);
      expect(back.rejoin).toBeUndefined();
      expect(store.snapshot).not.toHaveBeenCalled();
    });
  });
});

import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { type Action, type MatchConfig, ENGINE_VERSION, applyAction, createMatch, eventsEndTick, stateHash } from './engine';
import { turnDurationMs } from './fortress-match.rules';
import { FortressMatchService, MatchBroadcast } from './fortress-match.service';
import { MATCH_DISCONNECT_GRACE_MS, MATCH_START_DELAY_MS, SWEEP_INTERVAL_MS, WAKE_MARGIN_MS } from './fortress.constants';
import { MatchEndedPayload, TurnResolvedPayload } from './fortress.events';
import { DEADLINES_KEY, createRedisMock, expectCode } from './__spec__/redis-mock';

const T0 = 1_800_000_000_000;
/** 시작 카운트다운이 끝난 시각 — 이보다 이른 제출은 MATCH_NOT_STARTED */
const STARTED = T0 + MATCH_START_DELAY_MS;
const MATCH_ID = 'AAAAAAAAAAAAAAAA';
const CODE = 'ABCDEF';
const FIRST_TURN_MS = turnDurationMs(0);

const configOf = (n: number, mode: 'ffa' | 'team' = 'ffa', seed = 12345): MatchConfig => ({
  seed,
  mapId: 'hills',
  mode,
  players: Array.from({ length: n }, (_, slot) => ({ slot, team: mode === 'team' ? slot % 2 : 0, tankId: 0 })),
});
const slotsOf = (n: number) => Array.from({ length: n }, (_, slot) => ({ slot, playerId: `p${slot + 1}`, name: `플레이어${slot + 1}`, userId: null }));
/** 엔진으로 첫 턴 주인을 구한다(seed가 정한다) */
const firstSlot = (config: MatchConfig) => {
  const created = createMatch(config);
  if (!created.ok) throw new Error('config');
  return created.state.turn.slot;
};
const PASS = { move: 0, angle: 45, power: 0, weaponId: 0 };

/**
 * 포트리스 턴 매치 서비스 — 판정 순서·마감·서버 행동(skip·resign)·CAS 멱등·스위퍼 게이트.
 * 엔진은 진짜(사본)를 쓴다 — 서버가 엔진 결과(해시·다음 턴·연출 길이)를 그대로 싣는지가 계약이다.
 */
describe('FortressMatchService', () => {
  let mock: ReturnType<typeof createRedisMock>;
  let service: FortressMatchService;
  let broadcasts: { code: string; b: MatchBroadcast }[];
  let wakes: { task: () => void; delayMs: number }[];
  let endedHook: jest.Mock;
  let saveHook: jest.Mock;

  const newReplica = () => {
    const replica = new FortressMatchService();
    replica.setRedisClient(mock.redis as unknown as Redis);
    replica.setBroadcastListener((code, b) => broadcasts.push({ code, b }));
    replica.setWakeScheduler((task, delayMs) => wakes.push({ task, delayMs }));
    replica.setEndedHook(endedHook);
    replica.setSaveHook(saveHook);
    return replica;
  };
  const resolved = () => broadcasts.filter((x) => x.b.event === 'turnResolved').map((x) => x.b.payload as TurnResolvedPayload);
  const ended = () => broadcasts.filter((x) => x.b.event === 'matchEnded').map((x) => x.b.payload as MatchEndedPayload);
  const createOnly = (n = 2, mode: 'ffa' | 'team' = 'ffa', now = T0) =>
    service.create({ matchId: MATCH_ID, code: CODE, roomName: '한판', config: configOf(n, mode), slots: slotsOf(n) }, now);
  /** 방 CAS까지 성공한 시작 — 생성 + 마감 걸기(activate). 마감 처리 테스트의 기본 */
  const create = async (n = 2, mode: 'ffa' | 'team' = 'ffa', now = T0) => {
    const match = await createOnly(n, mode, now);
    await service.activate(match, now);
    return match;
  };
  const playerAt = (slot: number) => `p${slot + 1}`;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mock = createRedisMock();
    broadcasts = [];
    wakes = [];
    endedHook = jest.fn().mockResolvedValue(undefined);
    saveHook = jest.fn().mockResolvedValue(undefined);
    service = newReplica();
  });

  afterEach(() => {
    service.onModuleDestroy();
    delete process.env.TASK_SLOT;
    jest.restoreAllMocks();
  });

  describe('create', () => {
    it('첫 state·해시·첫 턴 마감(카운트다운 + 첫 턴 길이)을 저장하고, 마감 ZSET·깨우기는 activate가 건다', async () => {
      const match = await createOnly();
      const engine = createMatch(configOf(2));
      if (!engine.ok) throw new Error('config');

      expect(match.stateHash).toBe(stateHash(engine.state));
      expect(match.turnMs).toBe(FIRST_TURN_MS);
      expect(match.deadlineAt).toBe(T0 + MATCH_START_DELAY_MS + FIRST_TURN_MS);
      // 리뷰 B1: 방 CAS 전에는 마감이 없다 — 그 사이 레플리카가 죽어도 스위퍼가 방 없는 경기를 진행하지 않는다
      expect(mock.deadlineOf(MATCH_ID)).toBeUndefined();
      expect(wakes).toEqual([]);

      await service.activate(match, T0);
      expect(mock.deadlineOf(MATCH_ID)).toBe(match.deadlineAt);
      expect(wakes).toEqual([{ task: expect.any(Function), delayMs: MATCH_START_DELAY_MS + FIRST_TURN_MS + WAKE_MARGIN_MS }]);
      expect(service.turnInfo(match, T0)).toEqual({
        seq: 0,
        turnNo: 0,
        slot: engine.state.turn.slot,
        deadlineAt: new Date(T0 + MATCH_START_DELAY_MS + FIRST_TURN_MS).toISOString(),
        turnMs: FIRST_TURN_MS,
        remainingMs: MATCH_START_DELAY_MS + FIRST_TURN_MS,
      });
    });
  });

  describe('submit', () => {
    it('턴 주인의 fire → 엔진 결과 그대로 turnResolved(해시·다음 턴·연출 길이 반영 마감) 1번', async () => {
      await create();
      const first = firstSlot(configOf(2));
      const input = { move: 10, angle: 60, power: 70, weaponId: 0 };
      const now = T0 + 5_000;

      await service.submit(MATCH_ID, playerAt(first), { seq: 0, ...input }, now);

      const engine = createMatch(configOf(2));
      if (!engine.ok) throw new Error('config');
      const action: Action = { kind: 'fire', ...input };
      const expected = applyAction(engine.state, action);
      if (!expected.ok) throw new Error('engine');
      const turnMs = turnDurationMs(eventsEndTick(expected.events));
      expect(resolved()).toEqual([
        {
          matchId: MATCH_ID,
          seq: 0,
          action,
          cause: 'player',
          stateHash: stateHash(expected.state),
          next: {
            seq: 1,
            turnNo: expected.state.turn.no,
            slot: expected.state.turn.slot,
            deadlineAt: new Date(now + turnMs).toISOString(),
            turnMs,
            remainingMs: turnMs,
          },
        },
      ]);
      expect(turnMs).toBeGreaterThan(FIRST_TURN_MS); // 연출 시간이 실제로 더해졌다
      expect(mock.readMatch(MATCH_ID)?.actions).toEqual([action]);
      expect(mock.deadlineOf(MATCH_ID)).toBe(now + turnMs);
    });

    it('파워 0은 유효한 넘기기(D-010) — 다음 턴 길이는 첫 턴과 같다(연출 없음)', async () => {
      await create();
      const first = firstSlot(configOf(2));
      await service.submit(MATCH_ID, playerAt(first), { seq: 0, ...PASS }, STARTED);
      expect(resolved()[0].next).toMatchObject({ seq: 1, slot: 1 - first, turnMs: FIRST_TURN_MS });
    });

    it('경기 없음 → MATCH_NOT_FOUND · 참가자 아님 → MATCH_NOT_FOUND', async () => {
      await expectCode(service.submit(MATCH_ID, 'p1', { seq: 0, ...PASS }, STARTED), 'MATCH_NOT_FOUND');
      await create();
      await expectCode(service.submit(MATCH_ID, 'p9', { seq: 0, ...PASS }, STARTED), 'MATCH_NOT_FOUND');
    });

    it('seq가 지금 턴과 다르면 TURN_MISMATCH (늦은·중복 제출)', async () => {
      await create();
      const first = firstSlot(configOf(2));
      await service.submit(MATCH_ID, playerAt(first), { seq: 0, ...PASS }, STARTED);
      // 같은 seq 재전송
      await expectCode(service.submit(MATCH_ID, playerAt(first), { seq: 0, ...PASS }, STARTED), 'TURN_MISMATCH');
      await expectCode(service.submit(MATCH_ID, playerAt(1 - first), { seq: 5, ...PASS }, STARTED), 'TURN_MISMATCH');
      expect(resolved()).toHaveLength(1);
    });

    it('턴 주인이 아니면 NOT_YOUR_TURN', async () => {
      await create();
      const first = firstSlot(configOf(2));
      await expectCode(service.submit(MATCH_ID, playerAt(1 - first), { seq: 0, ...PASS }, STARTED), 'NOT_YOUR_TURN');
      expect(resolved()).toHaveLength(0);
    });

    it('시작 카운트다운 중이면 턴 주인이어도 MATCH_NOT_STARTED — 끝나는 시각부터 받는다', async () => {
      await create();
      const first = firstSlot(configOf(2));
      await expectCode(service.submit(MATCH_ID, playerAt(first), { seq: 0, ...PASS }, STARTED - 1), 'MATCH_NOT_STARTED');
      expect(resolved()).toHaveLength(0);
      expect(mock.readMatch(MATCH_ID)?.actions).toEqual([]);

      await service.submit(MATCH_ID, playerAt(first), { seq: 0, ...PASS }, STARTED);
      expect(resolved()).toHaveLength(1);
    });

    it('마감이 지났으면 그 자리에서 skip(timeout)을 넣어 방송하고 TURN_EXPIRED', async () => {
      const match = await create();
      const first = firstSlot(configOf(2));
      await expectCode(service.submit(MATCH_ID, playerAt(first), { seq: 0, ...PASS }, match.deadlineAt as number), 'TURN_EXPIRED');
      expect(resolved()).toEqual([expect.objectContaining({ seq: 0, action: { kind: 'skip' }, cause: 'timeout' })]);
      expect(mock.readMatch(MATCH_ID)?.actions).toEqual([{ kind: 'skip' }]);
    });

    it.each([
      ['각도 범위 밖', { angle: 500 }, 'ANGLE_RANGE'],
      ['파워 범위 밖', { power: 101 }, 'POWER_RANGE'],
      ['없는 무기', { weaponId: 42 }, 'WEAPON_UNKNOWN'],
      ['연료보다 큰 이동', { move: 5000 }, 'MOVE_RANGE'],
    ] as const)('엔진 거부(%s) → ACTION_REJECTED, message = 엔진 reason(%s), 아무것도 쓰지 않는다', async (_label, patch, reason) => {
      await create();
      const first = firstSlot(configOf(2));
      await expectCode(service.submit(MATCH_ID, playerAt(first), { seq: 0, ...PASS, ...patch }, STARTED), 'ACTION_REJECTED', reason);
      expect(resolved()).toHaveLength(0);
      expect(mock.readMatch(MATCH_ID)?.actions).toEqual([]);
    });

    it('버전 충돌이면 다시 읽어 판정한다 — 그 사이 행동이 들어갔으면 TURN_MISMATCH', async () => {
      await create();
      const first = firstSlot(configOf(2));
      const other = newReplica();
      // 이 제출이 읽은 직후 다른 레플리카가 skip을 넣는 경합을 흉내: eval 직전에 skip 반영
      const realEval = mock.redis.eval.getMockImplementation() as NonNullable<ReturnType<typeof mock.redis.eval.getMockImplementation>>;
      let raced = false;
      mock.redis.eval.mockImplementation(async (...args: Parameters<typeof realEval>) => {
        if (!raced) {
          raced = true;
          await other.processDue(MATCH_ID, T0 + MATCH_START_DELAY_MS + FIRST_TURN_MS);
        }
        return realEval(...args);
      });
      await expectCode(service.submit(MATCH_ID, playerAt(first), { seq: 0, ...PASS }, STARTED), 'TURN_MISMATCH');
      expect(mock.readMatch(MATCH_ID)?.actions).toEqual([{ kind: 'skip' }]);
    });
  });

  describe('마감 처리 (processDue)', () => {
    it('마감 전에는 아무것도 하지 않고, 지나면 skip(timeout) 1개 — 다음 턴은 다른 사람', async () => {
      const match = await create();
      const first = firstSlot(configOf(2));
      const deadline = match.deadlineAt as number;

      await service.processDue(MATCH_ID, deadline - 1);
      expect(resolved()).toHaveLength(0);

      await service.processDue(MATCH_ID, deadline);
      expect(resolved()).toEqual([
        expect.objectContaining({ seq: 0, action: { kind: 'skip' }, cause: 'timeout', next: expect.objectContaining({ seq: 1, slot: 1 - first }) }),
      ]);
    });

    it('로컬 깨우기 타이머가 그 경로를 부른다', async () => {
      const match = await create();
      jest.spyOn(Date, 'now').mockReturnValue(match.deadlineAt as number);
      wakes[0].task();
      await new Promise((r) => setImmediate(r));
      expect(resolved()).toEqual([expect.objectContaining({ cause: 'timeout' })]);
    });

    it('연속 3회 시간 초과면 엔진이 탈락시키고 경기가 끝난다 — matchEnded·종료 훅 1번, 마감 ZSET에서 빠진다', async () => {
      await create();
      const first = firstSlot(configOf(2));
      let now = T0;
      for (let i = 0; i < 6 && ended().length === 0; i++) {
        now = (mock.readMatch(MATCH_ID)?.deadlineAt as number) + 1;
        await service.processDue(MATCH_ID, now);
      }
      // 두 사람이 번갈아 skip — 먼저 둔 사람이 5번째 행동에서 3번째 skip
      expect(resolved()).toHaveLength(5);
      expect(resolved()[4]).toMatchObject({ seq: 4, cause: 'timeout', next: null });
      expect(ended()).toHaveLength(1);
      const result = ended()[0];
      expect(result.result).toEqual({ kind: 'win', slots: [1 - first] });
      expect(result.players.map((p) => [p.slot, p.place])).toEqual([
        [1 - first, 1],
        [first, 2],
      ]);
      expect(result.players.find((p) => p.slot === first)).toMatchObject({ hp: 0, damage: 0, kos: 0, team: null });
      expect(endedHook).toHaveBeenCalledTimes(1);
      expect(endedHook).toHaveBeenCalledWith(CODE, MATCH_ID);
      expect(mock.deadlineOf(MATCH_ID)).toBeUndefined();
      expect(mock.readMatch(MATCH_ID)).toMatchObject({ status: 'ENDED', deadlineAt: null, endedAt: now, roomName: '한판', engineVersion: ENGINE_VERSION });
      // F6: replay id = matchId · 끝내는 행동은 저장 대기에 들어가고(CAS 전) 방송 뒤 저장 훅이 1번 불린다
      expect(result.replay).toEqual({ id: MATCH_ID });
      expect(mock.pendingSaveOf(MATCH_ID)).toBe(now);
      expect(saveHook).toHaveBeenCalledTimes(1);
      expect(saveHook).toHaveBeenCalledWith(MATCH_ID);

      // 끝난 경기에는 더 넣지 않는다
      await service.processDue(MATCH_ID, now + 1_000_000);
      expect(resolved()).toHaveLength(5);
      await expectCode(service.submit(MATCH_ID, 'p1', { seq: 5, ...PASS }, now), 'MATCH_NOT_FOUND');
    });

    it('D-010 서버 경로: skip, skip, 넘기기(파워 0), skip, skip이면 탈락하지 않고 — 이어진 3번째 연속 skip에서 탈락', async () => {
      await create();
      const first = firstSlot(configOf(2));
      // first의 자기 턴 순서대로: 시간 초과 · 시간 초과 · 넘기기 · 시간 초과 · 시간 초과 · 시간 초과
      const plan: ('skip' | 'pass')[] = ['skip', 'skip', 'pass', 'skip', 'skip', 'skip'];
      let now = STARTED;
      let mine = 0;
      while (mine < plan.length) {
        const match = mock.readMatch(MATCH_ID);
        if (!match || match.status !== 'PLAYING') break;
        const seq = match.actions.length;
        if (match.state.turn.slot !== first) {
          // 상대는 매 턴 넘기기(파워 0) — 자기 skips가 쌓이지 않게
          await service.submit(MATCH_ID, playerAt(1 - first), { seq, ...PASS }, now);
          continue;
        }
        if (mine === 5) expect(match.state.tanks[first]).toMatchObject({ alive: true, skips: 2 }); // 넘기기가 0으로 되돌렸다
        if (plan[mine] === 'pass') {
          await service.submit(MATCH_ID, playerAt(first), { seq, ...PASS }, now);
        } else {
          now = (match.deadlineAt as number) + 1;
          await service.processDue(MATCH_ID, now);
        }
        mine += 1;
        if (mine === 5) expect(mock.readMatch(MATCH_ID)?.state.tanks[first]).toMatchObject({ alive: true, skips: 2 });
      }
      expect(mine).toBe(6);
      const final = mock.readMatch(MATCH_ID);
      expect(final?.state.tanks[first]).toMatchObject({ alive: false, skips: 3 });
      expect(ended()).toHaveLength(1);
      expect(ended()[0].result).toEqual({ kind: 'win', slots: [1 - first] });
    });

    it('CAS 멱등: 두 레플리카가 같은 마감을 동시에 처리해도 skip은 1번만 들어가고 방송도 1번', async () => {
      const match = await create();
      const replicaB = newReplica();
      const at = match.deadlineAt as number;

      await Promise.all([service.processDue(MATCH_ID, at), replicaB.processDue(MATCH_ID, at), service.processDue(MATCH_ID, at)]);

      expect(mock.readMatch(MATCH_ID)?.actions).toEqual([{ kind: 'skip' }]);
      expect(resolved()).toHaveLength(1);
    });
  });

  describe('기권 (resign)', () => {
    it('남의 턴 이탈(leave): 턴·마감 유지, next는 진행 중 턴 그대로(remainingMs만 갱신)', async () => {
      const match = await create(3);
      const first = firstSlot(configOf(3));
      const leaver = (first + 1) % 3;
      const now = T0 + 7_000;

      await expect(service.resign(MATCH_ID, playerAt(leaver), 'leave', now)).resolves.toBe(true);

      expect(resolved()).toEqual([
        {
          matchId: MATCH_ID,
          seq: 0,
          action: { kind: 'resign', slot: leaver },
          cause: 'leave',
          stateHash: mock.readMatch(MATCH_ID)?.stateHash,
          next: {
            seq: 1,
            turnNo: 0,
            slot: first,
            deadlineAt: new Date(match.deadlineAt as number).toISOString(),
            turnMs: FIRST_TURN_MS,
            remainingMs: (match.deadlineAt as number) - now,
          },
        },
      ]);
      // 이미 탈락했으면 아무것도 하지 않는다
      await expect(service.resign(MATCH_ID, playerAt(leaver), 'leave', now)).resolves.toBe(false);
      expect(resolved()).toHaveLength(1);
    });

    it('2인 경기에서 기권하면 바로 끝난다 — 남은 사람 1위', async () => {
      await create(2);
      await service.resign(MATCH_ID, 'p2', 'leave', T0);
      expect(resolved()[0]).toMatchObject({ cause: 'leave', next: null });
      expect(ended()[0].players.map((p) => [p.playerId, p.place])).toEqual([
        ['p1', 1],
        ['p2', 2],
      ]);
    });

    it('끊김 유예(30초): 표시하면 ZSET 처리 시각이 유예 끝으로 당겨지고, 유예 전엔 그대로, 지나면 resign(disconnect)', async () => {
      await create(3);
      // 유예 끝(at + 30초)이 첫 턴 마감(T0 + 25초)보다 이르게 — ZSET 점수는 둘 중 이른 쪽
      const at = T0 - 6_000;
      await service.setDisconnected(MATCH_ID, 'p2', at, T0);
      expect(mock.deadlineOf(MATCH_ID)).toBe(at + MATCH_DISCONNECT_GRACE_MS);
      expect(wakes[wakes.length - 1]?.delayMs).toBe(at + MATCH_DISCONNECT_GRACE_MS - T0 + WAKE_MARGIN_MS);

      await service.processDue(MATCH_ID, at + MATCH_DISCONNECT_GRACE_MS - 1);
      expect(resolved()).toHaveLength(0);
      await service.processDue(MATCH_ID, at + MATCH_DISCONNECT_GRACE_MS);
      expect(resolved()).toEqual([expect.objectContaining({ action: { kind: 'resign', slot: 1 }, cause: 'disconnect' })]);
    });

    it('유예 안에 재연결(끊김 해제)하면 resign하지 않는다', async () => {
      const match = await create(3);
      const at = T0 - 6_000;
      await service.setDisconnected(MATCH_ID, 'p2', at, T0);
      await service.setDisconnected(MATCH_ID, 'p2', null, T0 + 1_000);
      expect(mock.deadlineOf(MATCH_ID)).toBe(match.deadlineAt);
      await service.processDue(MATCH_ID, at + MATCH_DISCONNECT_GRACE_MS + 1);
      expect(resolved()).toHaveLength(0);
    });
  });

  describe('snapshot (resync·rejoin)', () => {
    it('engineVersion·config·actions·해시·지금 턴·slots — 액션 재적용으로 같은 해시가 나온다', async () => {
      await create();
      const first = firstSlot(configOf(2));
      await service.submit(MATCH_ID, playerAt(first), { seq: 0, move: 0, angle: 80, power: 40, weaponId: 2 }, STARTED);

      const snap = await service.snapshot(MATCH_ID, T0 + 1_000);
      expect(snap).toMatchObject({ matchId: MATCH_ID, engineVersion: ENGINE_VERSION, config: configOf(2), slots: slotsOf(2).map(({ slot, playerId, name }) => ({ slot, playerId, name, skin: { id: 'default', level: 1 } })) });
      expect(snap?.turn).toMatchObject({ seq: 1, slot: 1 - first });

      const engine = createMatch(configOf(2));
      if (!engine.ok) throw new Error('config');
      let state = engine.state;
      for (const action of snap?.actions ?? []) {
        const r = applyAction(state, action);
        if (!r.ok) throw new Error(r.reason);
        state = r.state;
      }
      expect(stateHash(state)).toBe(snap?.stateHash);
    });

    it('없는 경기는 null, 끝난 경기는 turn null', async () => {
      await expect(service.snapshot(MATCH_ID, T0)).resolves.toBeNull();
      await create();
      await service.resign(MATCH_ID, 'p1', 'leave', T0);
      await expect(service.snapshot(MATCH_ID, T0)).resolves.toMatchObject({ turn: null });
    });
  });

  describe('스위퍼 (TASK_SLOT)', () => {
    it('TASK_SLOT이 1이 아니면 스위퍼를 켜지 않는다', () => {
      const interval = jest.spyOn(global, 'setInterval');
      process.env.TASK_SLOT = '2';
      service.onModuleInit();
      delete process.env.TASK_SLOT;
      service.onModuleInit();
      expect(interval).not.toHaveBeenCalled();
    });

    it('TASK_SLOT=1이면 1초 주기로 켜고, 스윕은 처리 시각이 지난 경기만 처리한다', async () => {
      const interval = jest.spyOn(global, 'setInterval');
      process.env.TASK_SLOT = '1';
      service.onModuleInit();
      expect(interval).toHaveBeenCalledWith(expect.any(Function), SWEEP_INTERVAL_MS);

      const match = await create();
      await service.sweep((match.deadlineAt as number) - 1);
      expect(resolved()).toHaveLength(0);
      await service.sweep(match.deadlineAt as number);
      expect(resolved()).toEqual([expect.objectContaining({ cause: 'timeout' })]);
    });

    it('activate 전의 경기는 스위퍼가 진행하지 않는다(리뷰 B1)', async () => {
      await createOnly();
      await service.sweep(T0 + 10 * 60_000);
      expect(resolved()).toHaveLength(0);
      expect(mock.readMatch(MATCH_ID)?.actions).toEqual([]);
    });

    it('리뷰 B1·2차: activate 전에 다른 레플리카가 행동을 적용했으면(이탈 resign으로 끝남) 첫 마감으로 덮지 않는다', async () => {
      const match = await createOnly();
      await service.resign(MATCH_ID, 'p1', 'leave', T0);
      expect(mock.readMatch(MATCH_ID)?.status).toBe('ENDED');

      await service.activate(match, T0);
      expect(mock.deadlineOf(MATCH_ID)).toBeUndefined();
      expect(wakes).toEqual([]);
    });

    it('키가 사라진(TTL) 경기는 마감 ZSET에서 뺀다', async () => {
      await create();
      mock.hashes.clear();
      await service.sweep(T0 + 10 * 60_000);
      expect(mock.zsets.get(DEADLINES_KEY)?.size).toBe(0);
    });
  });

  it('Redis가 준비되지 않았으면 SERVICE_UNAVAILABLE', async () => {
    mock.state.status = 'reconnecting';
    await expectCode(create(), 'SERVICE_UNAVAILABLE');
  });
});

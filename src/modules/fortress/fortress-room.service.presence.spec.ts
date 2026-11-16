import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { FortressMatchService } from './fortress-match.service';
import { DISCONNECT_GRACE_MS, FINISH_RETRY_DELAY_MS, FINISH_RETRY_MAX_ATTEMPTS, FORTRESS_RATE_LIMITS, HEARTBEAT_TTL_MS, LIVENESS_MIN_CONNECTED_MS } from './fortress.constants';
import { RoomSettings } from './fortress.events';
import { FortressRoomService, SocketIdentity } from './fortress-room.service';
import { createRedisMock, expectCode } from './__spec__/redis-mock';

const T0 = 1_800_000_000_000;
const who = (n: number, userId: number | null = null): SocketIdentity => ({ socketId: `sock-${n}`, userId, ip: `10.0.0.${n}` });
const A = who(1, 42);
const B = who(2);
const C = who(3);

/** 하트비트·생존 확인(void로 도는 판정)이 끝날 때까지 — 판정 안의 await 사슬을 다 비운다 */
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * 포트리스 방 서비스 — 연결 감시(하트비트·생존 확인)·강퇴·로비 목록·이모트.
 * 판정은 레플리카 공통 SET NX 게이트 뒤에서 void로 돈다 — mock의 set은 NX라 게이트는 테스트마다 한 번 열린다.
 */
describe('FortressRoomService — 연결 감시·강퇴·로비', () => {
  let mock: ReturnType<typeof createRedisMock>;
  let matches: FortressMatchService;
  let service: FortressRoomService;
  let evicted: string[][];
  let changes: { code: string; status: string | null }[];

  const create = (settings: Partial<RoomSettings> = {}, host = A, heartbeat = false) =>
    service.createRoom({ name: '포트리스 한판', mode: 'ffa', mapId: 'hills', maxPlayers: 4, playerName: '방장', heartbeat, ...settings }, host, T0);
  const join = (code: string, w: SocketIdentity, name = '도전자', heartbeat = false, now = T0) =>
    service.joinRoom({ code, playerName: name, heartbeat }, w, now);
  const connectedOf = (code: string) =>
    Object.fromEntries((mock.readRoom(code)?.players ?? []).map((p) => [p.playerId, p.connected]));

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mock = createRedisMock();
    matches = new FortressMatchService();
    matches.setRedisClient(mock.redis as unknown as Redis);
    matches.setBroadcastListener(() => undefined);
    matches.setWakeScheduler(() => undefined);
    service = new FortressRoomService(matches);
    service.setRedisClient(mock.redis as unknown as Redis);
    service.setWakeScheduler(() => undefined);
    evicted = [];
    service.setSocketEvictor((ids) => evicted.push(ids));
    changes = [];
    service.setChangeListener((code, room) => changes.push({ code, status: room?.status ?? null }));
  });

  afterEach(() => jest.restoreAllMocks());

  describe('하트비트', () => {
    it('하트비트를 켠 자리가 TTL 동안 응답이 없으면 끊김 표시 + 그 소켓을 서버에서 끊는다', async () => {
      const { room } = await create({}, A, true);
      await join(room.code, B, '도전자', true);
      changes = [];

      await service.recordHeartbeat(room.code, A.socketId, T0 + HEARTBEAT_TTL_MS);
      await flush();

      expect(connectedOf(room.code)).toEqual({ p1: true, p2: false });
      expect(mock.readRoom(room.code)?.players[1]).toMatchObject({ socketId: null, disconnectedAt: T0 + HEARTBEAT_TTL_MS });
      expect(evicted).toEqual([[B.socketId]]);
      expect(changes).toEqual([{ code: room.code, status: 'WAITING' }]);
    });

    it('판정 제외 — TTL이 안 지난 자리, 하트비트를 안 켠 자리(옛 클라이언트), 응답한 자리', async () => {
      const { room } = await create({}, A, true);
      await join(room.code, B, '옛클라', false);
      await join(room.code, C, '늦게온', true, T0 + 5_000);
      await service.recordHeartbeat(room.code, A.socketId, T0 + HEARTBEAT_TTL_MS);
      await flush();

      expect(connectedOf(room.code)).toEqual({ p1: true, p2: true, p3: true });
      expect(evicted).toEqual([]);
    });

    it('게이트 — 같은 방의 판정은 간격 안에 한 번만 돈다', async () => {
      const { room } = await create({}, A, true);
      await join(room.code, B, '도전자', true);
      await service.recordHeartbeat(room.code, A.socketId, T0 + 1_000);
      await flush();
      mock.redis.mget.mockClear();

      await service.recordHeartbeat(room.code, A.socketId, T0 + HEARTBEAT_TTL_MS);
      await flush();

      expect(mock.redis.mget).not.toHaveBeenCalled();
      expect(connectedOf(room.code)).toEqual({ p1: true, p2: true });
    });

    it('경기 중 유령은 경기에도 끊김 시각을 남긴다(30초 유예 resign의 출발점)', async () => {
      const { room } = await create({}, A, true);
      await join(room.code, B, '도전자', true);
      await service.setReady(room.code, B.socketId, true, T0);
      const { starting } = await service.startMatch(room.code, A.socketId, T0);

      await service.recordHeartbeat(room.code, A.socketId, T0 + HEARTBEAT_TTL_MS);
      await flush();

      expect(mock.readMatch(starting.matchId)?.slots[1].disconnectedAt).toBe(T0 + HEARTBEAT_TTL_MS);
      expect(mock.readRoom(room.code)?.players).toHaveLength(2); // 경기 중에는 방 유예로 자리를 빼지 않는다
    });

    it('Redis가 준비되지 않았으면 기록하지 않고 던지지도 않는다', async () => {
      const { room } = await create({}, A, true);
      mock.state.status = 'connecting';
      await expect(service.recordHeartbeat(room.code, A.socketId, T0)).resolves.toBeUndefined();
    });
  });

  describe('생존 확인(유령 정리)', () => {
    it('방 채널에 없는 소켓은 최소 연결 시간이 지나면 끊김 표시 — 소켓 끊기는 하지 않는다', async () => {
      const { room } = await create();
      await join(room.code, B);
      service.setLiveSocketProbe(async () => new Set([A.socketId]));

      await service.listRooms(T0 + LIVENESS_MIN_CONNECTED_MS);
      await flush();

      expect(connectedOf(room.code)).toEqual({ p1: true, p2: false });
      expect(evicted).toEqual([]);
    });

    it('최소 연결 시간 전에는 건드리지 않는다(입장 직후 채널 가입 전 경합)', async () => {
      const { room } = await create();
      await join(room.code, B);
      service.setLiveSocketProbe(async () => new Set([A.socketId]));

      await service.listRooms(T0 + LIVENESS_MIN_CONNECTED_MS - 1);
      await flush();

      expect(connectedOf(room.code)).toEqual({ p1: true, p2: true });
    });

    it('probe가 없거나(단일 노드 테스트) 실패하면 아무것도 바꾸지 않는다', async () => {
      const { room } = await create();
      await join(room.code, B);
      await service.listRooms(T0 + LIVENESS_MIN_CONNECTED_MS);
      await flush();
      expect(connectedOf(room.code)).toEqual({ p1: true, p2: true });

      const other = await service.createRoom({ name: '둘째 방', mode: 'ffa', mapId: 'hills', maxPlayers: 2, playerName: '방장' }, C, T0);
      service.setLiveSocketProbe(async () => {
        throw new Error('adapter timeout');
      });
      await service.listRooms(T0 + LIVENESS_MIN_CONNECTED_MS);
      await flush();
      expect(connectedOf(other.room.code)).toEqual({ p1: true });
    });
  });

  describe('kickPlayer', () => {
    it('방장이 대기실에서 강퇴 — 자리를 빼고 그 소켓 id를 돌려준다', async () => {
      const { room } = await create();
      await join(room.code, B);
      await join(room.code, C, '셋째');

      const result = await service.kickPlayer(room.code, A.socketId, 'p2', T0);

      expect(result.kickedSocketId).toBe(B.socketId);
      expect(result.room?.players.map((p) => p.playerId)).toEqual(['p1', 'p3']);
      expect(mock.readRoom(room.code)?.players.map((p) => p.playerId)).toEqual(['p1', 'p3']);
    });

    it('끊긴 자리를 강퇴하면 kickedSocketId는 null', async () => {
      const { room } = await create();
      await join(room.code, B);
      await service.markDisconnected(room.code, B.socketId, T0 + 1_000);

      const result = await service.kickPlayer(room.code, A.socketId, 'p2', T0 + 2_000);

      expect(result.kickedSocketId).toBeNull();
      expect(result.room?.players).toHaveLength(1);
    });

    it('거부 — 방장 아님 NOT_HOST, 자기 자신·없는 자리 PLAYER_NOT_FOUND, 방 멤버 아님 NOT_IN_ROOM', async () => {
      const { room } = await create();
      await join(room.code, B);
      await expectCode(service.kickPlayer(room.code, B.socketId, 'p1', T0), 'NOT_HOST');
      await expectCode(service.kickPlayer(room.code, A.socketId, 'p1', T0), 'PLAYER_NOT_FOUND');
      await expectCode(service.kickPlayer(room.code, A.socketId, 'p9', T0), 'PLAYER_NOT_FOUND');
      await expectCode(service.kickPlayer(room.code, C.socketId, 'p2', T0), 'NOT_IN_ROOM');
      expect(mock.readRoom(room.code)?.players).toHaveLength(2);
    });

    it('빈도 제한을 넘으면 RATE_LIMITED', async () => {
      const { room } = await create();
      for (let i = 0; i < FORTRESS_RATE_LIMITS.kick.limit; i += 1) {
        await expectCode(service.kickPlayer(room.code, A.socketId, 'p9', T0), 'PLAYER_NOT_FOUND');
      }
      await expectCode(service.kickPlayer(room.code, A.socketId, 'p9', T0), 'RATE_LIMITED');
    });
  });

  describe('listRooms', () => {
    it('WAITING → PLAYING → RESULT 순, 같은 상태는 로비 인덱스 순서 · 유예가 지난 끊긴 자리만 남은 방은 뺀다', async () => {
      const waiting = await create({}, A);
      const playing = await service.createRoom({ name: '경기 방', mode: 'ffa', mapId: 'hills', maxPlayers: 2, playerName: '방장' }, B, T0);
      await join(playing.room.code, C);
      await service.setReady(playing.room.code, C.socketId, true, T0);
      await service.startMatch(playing.room.code, B.socketId, T0);
      const empty = await service.createRoom({ name: '빈 방', mode: 'ffa', mapId: 'hills', maxPlayers: 2, playerName: '방장' }, who(9), T0);
      await service.markDisconnected(empty.room.code, who(9).socketId, T0);

      const list = await service.listRooms(T0 + DISCONNECT_GRACE_MS, { reconcile: false });

      expect(list.map((s) => [s.code, s.status])).toEqual([
        [waiting.room.code, 'WAITING'],
        [playing.room.code, 'PLAYING'],
      ]);
    });
  });

  describe('prepareEmote', () => {
    it('방 멤버의 이모트 — 보낸 사람·시각, 멤버 아님 NOT_IN_ROOM, 빈도 제한 RATE_LIMITED', async () => {
      const { room } = await create();
      await expect(service.prepareEmote(room.code, A.socketId, 'gg', T0)).resolves.toEqual({
        playerId: 'p1',
        emoteId: 'gg',
        at: new Date(T0).toISOString(),
      });
      await expectCode(service.prepareEmote(room.code, B.socketId, 'gg', T0), 'NOT_IN_ROOM');
      for (let i = 1; i < FORTRESS_RATE_LIMITS.emote.limit; i += 1) await service.prepareEmote(room.code, A.socketId, 'gg', T0);
      await expectCode(service.prepareEmote(room.code, A.socketId, 'gg', T0), 'RATE_LIMITED');
    });
  });
  describe('finishMatch 재시도', () => {
    it('방 반영이 계속 실패하면 FINISH_RETRY_MAX_ATTEMPTS번까지만 다시 시도하고 멈춘다(그 뒤는 repairEndedMatch 몫)', async () => {
      const { room } = await create();
      await join(room.code, B);
      await service.setReady(room.code, B.socketId, true, T0);
      const { starting } = await service.startMatch(room.code, A.socketId, T0);
      const wakes: { task: () => void; delayMs: number }[] = [];
      service.setWakeScheduler((task, delayMs) => wakes.push({ task, delayMs }));
      mock.redis.eval.mockRejectedValue(new Error('redis down'));

      await service.finishMatch(room.code, starting.matchId);
      for (let i = 0; i < FINISH_RETRY_MAX_ATTEMPTS + 2 && wakes.length > i; i += 1) {
        wakes[i].task();
        await flush();
      }

      expect(wakes).toHaveLength(FINISH_RETRY_MAX_ATTEMPTS);
      expect(wakes.every((w) => w.delayMs === FINISH_RETRY_DELAY_MS)).toBe(true);
      expect(mock.readRoom(room.code)?.status).toBe('PLAYING');
    });
  });
});

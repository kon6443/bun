import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  DISCONNECT_GRACE_MS,
  PASSWORD_FAILURE_LIMIT,
  PASSWORD_FAILURE_LIMIT_IP,
  ROOM_CAS_MAX_ATTEMPTS,
  HEARTBEAT_PROBE_INTERVAL_MS,
  HEARTBEAT_TTL_MS,
  LOBBY_SCAN_LIMIT,
  TETRIS_BATTLE_RATE_LIMITS,
  WAKE_MARGIN_MS,
} from './tetris-battle.constants';
import { ROOM_CODE_ALPHABET } from './tetris-battle.events';
import { SocketIdentity, TetrisBattleRoomService } from './tetris-battle-room.service';
import { roomPasswordCheck } from './tetris-battle-room-tokens';
import { codeOf, createRedisMock, expectCode, roomKey } from './__spec__/redis-mock';

const T0 = 1_800_000_000_000;
const LOBBY = 'tetris-battle:rooms';

const A: SocketIdentity = { socketId: 'sock-a', userId: 42, ip: '10.0.0.1' };
const B: SocketIdentity = { socketId: 'sock-b', userId: null, ip: '10.0.0.2' };
const C: SocketIdentity = { socketId: 'sock-c', userId: null, ip: '10.0.0.3' };
const D: SocketIdentity = { socketId: 'sock-d', userId: null, ip: '10.0.0.4' };
const E: SocketIdentity = { socketId: 'sock-e2', userId: null, ip: '10.0.0.7' };
const F: SocketIdentity = { socketId: 'sock-f2', userId: null, ip: '10.0.0.8' };
const G: SocketIdentity = { socketId: 'sock-g', userId: null, ip: '10.0.0.9' };

/**
 * 대전 방 서비스 — 방 상태 전부가 Redis 한 키(Hash: 버전 + JSON)에 있고, 모든 변경은
 * "읽기 → 순수 변경 → 버전 CAS"로 원자적이다. 여기서는 규칙(입장·비밀번호·정원·방장 이양·끊김 정리·재연결)을 본다.
 *
 * 깨지면 가장 위험한 것: **멤버십이 소켓 id로 판정되는가**(NOT_IN_ROOM), **토큰·비밀번호 원문이 저장되지 않는가**,
 * **충돌 시 다시 읽고 재시도하는가**(덮어쓰기면 다른 레플리카의 입장이 사라진다).
 */
describe('TetrisBattleRoomService', () => {
  let service: TetrisBattleRoomService;
  let mock: ReturnType<typeof createRedisMock>;
  /** 깨우기 타이머(D-009) 대역 — 실제 타이머를 남기지 않고, 테스트가 직접 깨운다 */
  let wakes: { task: () => void; delayMs: number }[];

  const create = (who = A, overrides: Partial<{ name: string; maxPlayers: number; password: string; playerName: string }> = {}, now = T0) =>
    service.createRoom({ name: '한판 해요', maxPlayers: 4, playerName: '방장', ...overrides }, who, now);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mock = createRedisMock();
    service = new TetrisBattleRoomService();
    service.setRedisClient(mock.redis as unknown as Redis);
    wakes = [];
    service.setWakeScheduler((task, delayMs) => wakes.push({ task, delayMs }));
  });

  afterEach(() => jest.restoreAllMocks());

  describe('createRoom', () => {
    it('6자 코드(혼동 문자 제외)로 방을 만들고 만든 사람이 p1·방장으로 들어간다', async () => {
      const result = await create();

      expect(result.room.code).toMatch(new RegExp(`^[${ROOM_CODE_ALPHABET}]{6}$`));
      expect(result.room.code).not.toMatch(/[01OIL]/);
      expect(result.playerId).toBe('p1');
      expect(result.playerToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(result.lobbyChanged).toBe(true);
      expect(result.room).toEqual({
        code: result.room.code,
        name: '한판 해요',
        maxPlayers: 4,
        locked: false,
        hostId: 'p1',
        status: 'WAITING',
        players: [{ playerId: 'p1', name: '방장', ready: false, connected: true, isGuest: false, skins: { block: 'default', effect: 'default', board: 'default' } }],
      });
      expect(mock.zset.has(result.room.code)).toBe(true);
    });

    it('비밀번호·토큰 원문은 저장하지 않는다 (scrypt 해시·sha256 해시만)', async () => {
      const result = await create(A, { password: 'secret12' });
      const stored = JSON.stringify(mock.hashes.get(roomKey(result.room.code)));

      expect(result.room.locked).toBe(true);
      expect(stored).not.toContain('secret12');
      expect(stored).not.toContain(result.playerToken);
      expect(mock.readRoom(result.room.code)?.passwordHash).toMatch(/^scrypt\$/);
    });

    it('방 이름에 ZWJ 이모지는 허용한다 (리뷰 G5)', async () => {
      await expect(create(A, { name: '👩‍💻 개발자방' })).resolves.toMatchObject({ room: { name: '👩‍💻 개발자방' } });
    });

    it('게스트가 만들면 isGuest=true', async () => {
      const result = await create(B);
      expect(result.room.players[0].isGuest).toBe(true);
    });

    it('코드가 이미 있으면(CAS 0) 새 코드로 다시 시도한다', async () => {
      mock.state.forceCasConflicts = 1;
      const result = await create();
      expect(mock.redis.eval).toHaveBeenCalledTimes(2);
      expect(mock.readRoom(result.room.code)).not.toBeNull();
    });

    it('코드 충돌이 재시도 한도를 넘으면 ROOM_BUSY', async () => {
      mock.state.forceCasConflicts = 100;
      await expectCode(create(), 'ROOM_BUSY');
    });

    it.each([
      ['플레이어 이름 형식 위반', { playerName: '!!' }, 'NAME_INVALID'],
      ['플레이어 이름 금칙어', { playerName: '운영자' }, 'NAME_FORBIDDEN'],
      ['방 이름 빈 값', { name: '' }, 'ROOM_NAME_INVALID'],
      ['방 이름 21자', { name: '가'.repeat(21) }, 'ROOM_NAME_INVALID'],
      ['방 이름 제어문자', { name: '방\u0007' }, 'ROOM_NAME_INVALID'],
      ['방 이름 bidi 오버라이드', { name: '방\u202E이름' }, 'ROOM_NAME_INVALID'],
      ['방 이름 금칙어', { name: '씨발 방' }, 'ROOM_NAME_FORBIDDEN'],
    ] as const)('%s → %s (Redis에 쓰지 않는다)', async (_label, overrides, code) => {
      await expectCode(create(A, overrides), code);
      expect(mock.redis.eval).not.toHaveBeenCalled();
    });

    it('Redis가 ready가 아니면 SERVICE_UNAVAILABLE', async () => {
      mock.state.status = 'reconnecting';
      await expectCode(create(), 'SERVICE_UNAVAILABLE');
    });
  });

  describe('lobbySummary (REST 방 수, D-025)', () => {
    it('listRooms와 같은 정리 규칙으로 센다 — 대기(WAITING) / 입장 불가(PLAYING·RESULT), 사라진 방·유예 지난 빈 방 제외', async () => {
      await create(A, { name: '대기1' }, T0);
      await create(B, { name: '대기2' }, T0 + 1);
      const playing = await create(C, { name: '경기' }, T0 + 2);
      const result = await create(D, { name: '결과' }, T0 + 3);
      mock.patchRoom(playing.room.code, (r) => (r.status = 'PLAYING'));
      mock.patchRoom(result.room.code, (r) => (r.status = 'RESULT'));
      const gone = await create({ socketId: 'sock-e', userId: null, ip: '10.0.0.5' }, { name: '사라짐' }, T0 + 4);
      mock.hashes.delete(roomKey(gone.room.code));
      const empty = await create({ socketId: 'sock-f', userId: null, ip: '10.0.0.6' }, { name: '빈방' }, T0 + 5);
      await service.markDisconnected(empty.room.code, 'sock-f', T0);

      await expect(service.lobbySummary(T0 + DISCONNECT_GRACE_MS)).resolves.toMatchObject({ waitingRooms: 2, playingRooms: 2 });
    });

    it('방 미리보기: 빈자리 있는 대기 방만, 사람 많은 순 → 같으면 최근 생성 순, 최대 3개, 공개 필드만 (games-polish D-009)', async () => {
      const lone1 = await create(A, { name: '혼자1' }, T0);
      const pair = await create(B, { name: '둘', password: 'pw' }, T0 + 1);
      await service.joinRoom({ code: pair.room.code, playerName: '둘째', password: 'pw' }, E, T0 + 1);
      const full = await create(C, { name: '꽉참', maxPlayers: 2 }, T0 + 2);
      await service.joinRoom({ code: full.room.code, playerName: '둘째' }, F, T0 + 2);
      const lone2 = await create(D, { name: '혼자2' }, T0 + 3);
      const lone3 = await create(G, { name: '혼자3' }, T0 + 4);

      const summary = await service.lobbySummary(T0 + 5);

      expect(summary?.waitingRooms).toBe(5);
      expect(summary?.rooms).toEqual([
        { code: pair.room.code, name: '둘', playerCount: 2, maxPlayers: 4, locked: true },
        { code: lone3.room.code, name: '혼자3', playerCount: 1, maxPlayers: 4, locked: false },
        { code: lone2.room.code, name: '혼자2', playerCount: 1, maxPlayers: 4, locked: false },
      ]);
      expect(summary?.rooms.map((r) => r.code)).not.toContain(full.room.code);
      expect(summary?.rooms.map((r) => r.code)).not.toContain(lone1.room.code);
    });

    it('2초 캐시(레플리카 공통 Redis) — 캐시가 있으면 로비를 다시 읽지 않는다', async () => {
      const first = await create(A, {}, T0);
      const expected = {
        waitingRooms: 1,
        playingRooms: 0,
        rooms: [{ code: first.room.code, name: '한판 해요', playerCount: 1, maxPlayers: 4, locked: false }],
      };
      await expect(service.lobbySummary(T0)).resolves.toEqual(expected);
      expect(mock.redis.set).toHaveBeenCalledWith('tetris-battle:lobby-summary', JSON.stringify(expected), 'PX', 2_000);

      await create(B, {}, T0);
      mock.redis.zrevrange.mockClear();
      await expect(service.lobbySummary(T0)).resolves.toEqual(expected);
      expect(mock.redis.zrevrange).not.toHaveBeenCalled();
    });

    it('Redis를 못 쓰면 null', async () => {
      mock.state.status = 'reconnecting';
      await expect(service.lobbySummary(T0)).resolves.toBeNull();
    });

    it('조회 중 Redis 명령이 실패해도 던지지 않고 null(→ 503) (리뷰 N3)', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      mock.redis.zrevrange.mockRejectedValueOnce(new Error('Connection is closed.'));
      await expect(service.lobbySummary(T0)).resolves.toBeNull();
    });
  });

  describe('listRooms', () => {
    it('WAITING 방이 먼저, 같은 상태면 최근 생성 순', async () => {
      const old = await create(A, { name: '오래된 방' }, T0);
      const playing = await create(B, { name: '진행 중' }, T0 + 1000);
      const recent = await create(C, { name: '최근 방', password: 'pw' }, T0 + 2000);
      mock.patchRoom(playing.room.code, (r) => (r.status = 'PLAYING'));

      const rooms = await service.listRooms(T0 + 3000);

      expect(rooms.map((r) => r.code)).toEqual([recent.room.code, old.room.code, playing.room.code]);
      expect(rooms[0]).toEqual({
        code: recent.room.code,
        name: '최근 방',
        playerCount: 1,
        maxPlayers: 4,
        locked: true,
        status: 'WAITING',
      });
    });

    it('방 키가 TTL로 사라진 코드는 목록에서 빼고 로비 인덱스에서 지운다', async () => {
      const room = await create();
      mock.hashes.delete(roomKey(room.room.code));

      await expect(service.listRooms()).resolves.toEqual([]);
      expect(mock.redis.zrem).toHaveBeenCalledWith(LOBBY, room.room.code);
    });

    it(`인덱스가 읽는 범위(${LOBBY_SCAN_LIMIT}개)보다 크면 가장 오래된 쪽의 사라진 코드도 지운다 (BE-03)`, async () => {
      const live = await create(A);
      for (let i = 0; i < LOBBY_SCAN_LIMIT + 5; i++) mock.zset.set(`OLD${String(i).padStart(3, '0')}`, i); // 방 키 없음(TTL 만료)
      mock.zset.set(live.room.code, T0);

      await service.listRooms(T0);
      await new Promise((r) => setImmediate(r));

      // 최근 200개는 기존 정리, 그 밖의 가장 오래된 쪽은 끝 정리 — 살아 있는 방은 남는다
      expect(mock.zset.has('OLD000')).toBe(false);
      expect(mock.zset.has(live.room.code)).toBe(true);
    });

    it('유예가 지난 끊긴 플레이어는 인원에서 빼고, 남은 사람이 없으면 목록에서 숨긴다', async () => {
      const room = await create(A);
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.markDisconnected(room.room.code, B.socketId, T0);

      const within = await service.listRooms(T0 + DISCONNECT_GRACE_MS - 1);
      const after = await service.listRooms(T0 + DISCONNECT_GRACE_MS);
      expect(within[0].playerCount).toBe(2);
      expect(after[0].playerCount).toBe(1);

      await service.markDisconnected(room.room.code, A.socketId, T0);
      await expect(service.listRooms(T0 + DISCONNECT_GRACE_MS)).resolves.toEqual([]);
    });
  });

  describe('joinRoom — 새 입장', () => {
    it('공개 방에 p2로 들어가고 로비 인원이 바뀐다', async () => {
      const room = await create();
      const result = await service.joinRoom({ code: room.room.code, playerName: '도전자' }, B, T0);

      expect(result.playerId).toBe('p2');
      expect(result.lobbyChanged).toBe(true);
      expect(result.replacedSocketId).toBeNull();
      expect(result.room.hostId).toBe('p1');
      expect(result.room.players.map((p) => p.playerId)).toEqual(['p1', 'p2']);
    });

    it('없는 방이면 ROOM_NOT_FOUND', async () => {
      await expectCode(service.joinRoom({ code: 'ABCDEF', playerName: '도전자' }, B), 'ROOM_NOT_FOUND');
    });

    it('정원이 차면 ROOM_FULL', async () => {
      const room = await create(A, { maxPlayers: 2 });
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await expectCode(service.joinRoom({ code: room.room.code, playerName: '셋째' }, C, T0), 'ROOM_FULL');
    });

    it('WAITING이 아니면 MATCH_ALREADY_STARTED', async () => {
      const room = await create();
      mock.patchRoom(room.room.code, (r) => (r.status = 'PLAYING'));
      await expectCode(service.joinRoom({ code: room.room.code, playerName: '늦은자' }, B), 'MATCH_ALREADY_STARTED');
    });

    it('이름 금칙어면 NAME_FORBIDDEN', async () => {
      const room = await create();
      await expectCode(service.joinRoom({ code: room.room.code, playerName: '관리자' }, B), 'NAME_FORBIDDEN');
    });

    it('나간 사람의 playerId를 재사용하지 않는다', async () => {
      const room = await create();
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.leaveRoom(room.room.code, B.socketId, T0);
      const again = await service.joinRoom({ code: room.room.code, playerName: '셋째' }, C, T0);
      expect(again.playerId).toBe('p3');
    });
  });

  describe('joinRoom — 비밀번호', () => {
    const PW = 'letmein';
    let code: string;
    // scrypt를 십여 번 연달아 돌리는 테스트가 있다 — 전체 스위트를 병렬로 돌리면 CPU 경합으로 기본 5초를 넘겨 간헐 실패했다
    const SCRYPT_HEAVY_TIMEOUT_MS = 30_000;

    beforeEach(async () => {
      code = (await create(A, { password: PW })).room.code;
    });

    it('맞으면 입장', async () => {
      await expect(service.joinRoom({ code, password: PW, playerName: '도전자' }, B)).resolves.toMatchObject({
        playerId: 'p2',
      });
    });

    it.each([
      ['틀린 비밀번호', 'wrong'],
      ['비밀번호 없음', undefined],
    ])('%s → ROOM_WRONG_PASSWORD', async (_label, password) => {
      await expectCode(service.joinRoom({ code, password, playerName: '도전자' }, B), 'ROOM_WRONG_PASSWORD');
      expect(mock.readRoom(code)?.players).toHaveLength(1);
    });

    it(`같은 소켓은 ${PASSWORD_FAILURE_LIMIT.maxFailures}번까지 검증, 그 다음 시도부터 맞아도 ROOM_PASSWORD_LOCKED`, async () => {
      for (let i = 0; i < PASSWORD_FAILURE_LIMIT.maxFailures; i++) {
        await expectCode(service.joinRoom({ code, password: 'x', playerName: '도전자' }, B), 'ROOM_WRONG_PASSWORD');
      }
      await expectCode(service.joinRoom({ code, password: PW, playerName: '도전자' }, B), 'ROOM_PASSWORD_LOCKED');

      // 다른 소켓·다른 IP는 영향 없음
      await expect(service.joinRoom({ code, password: PW, playerName: '다른이' }, C)).resolves.toMatchObject({
        playerId: 'p2',
      });
    }, SCRYPT_HEAVY_TIMEOUT_MS);

    it('동시에 여러 번 시도해도 한도를 넘는 시도는 검증(scrypt) 없이 잠금 — 리뷰 F1', async () => {
      const verify = jest.spyOn(roomPasswordCheck, 'matches');
      const attempts = PASSWORD_FAILURE_LIMIT.maxFailures * 3;

      const outcomes = await Promise.all(
        Array.from({ length: attempts }, () => codeOf(service.joinRoom({ code, password: 'x', playerName: '도전자' }, B))),
      );

      expect(outcomes.filter((o) => o === 'ROOM_WRONG_PASSWORD')).toHaveLength(PASSWORD_FAILURE_LIMIT.maxFailures);
      expect(outcomes.filter((o) => o === 'ROOM_PASSWORD_LOCKED')).toHaveLength(attempts - PASSWORD_FAILURE_LIMIT.maxFailures);
      expect(verify).toHaveBeenCalledTimes(PASSWORD_FAILURE_LIMIT.maxFailures);
    }, SCRYPT_HEAVY_TIMEOUT_MS);

    it(`소켓을 바꿔 가며 시도해도 같은 IP는 ${PASSWORD_FAILURE_LIMIT_IP.maxFailures}번까지 — 그 다음부터 IP 전체 잠금`, async () => {
      const sameIp = (i: number): SocketIdentity => ({ socketId: `sock-ip-${i}`, userId: null, ip: '203.0.113.7' });
      for (let i = 0; i < PASSWORD_FAILURE_LIMIT_IP.maxFailures; i++) {
        await expectCode(service.joinRoom({ code, password: 'x', playerName: '도전자' }, sameIp(i)), 'ROOM_WRONG_PASSWORD');
      }
      // 새 소켓이 맞는 비밀번호를 내도 같은 IP면 잠금
      await expectCode(service.joinRoom({ code, password: PW, playerName: '도전자' }, sameIp(999)), 'ROOM_PASSWORD_LOCKED');
      // 다른 IP는 영향 없음
      await expect(service.joinRoom({ code, password: PW, playerName: '다른이' }, C)).resolves.toMatchObject({
        playerId: 'p2',
      });
    }, SCRYPT_HEAVY_TIMEOUT_MS);

    it('IP 카운터는 방 단위다 — 다른 방 비밀번호에는 영향 없음', async () => {
      const other = (await create(D, { password: PW })).room.code;
      const sameIp = (i: number): SocketIdentity => ({ socketId: `sock-ip-${i}`, userId: null, ip: '203.0.113.8' });
      for (let i = 0; i <= PASSWORD_FAILURE_LIMIT_IP.maxFailures; i++) {
        await codeOf(service.joinRoom({ code, password: 'x', playerName: '도전자' }, sameIp(i)));
      }
      await expect(service.joinRoom({ code: other, password: PW, playerName: '도전자' }, sameIp(99))).resolves.toMatchObject({
        playerId: 'p2',
      });
    }, SCRYPT_HEAVY_TIMEOUT_MS);

    it.each([
      ['오답', { password: 'x' }, 'ROOM_WRONG_PASSWORD'],
      ['이름 금칙어', { password: PW, playerName: '관리자' }, 'NAME_FORBIDDEN'],
      ['잘못된 재연결 토큰', { playerToken: 'y'.repeat(32) }, 'INVALID_PLAYER_TOKEN'],
    ] as const)('사전 검증 실패(%s)면 beforeCommit(이전 방 이탈)을 부르지 않는다 (리뷰 G6)', async (_label, extra, errorCode) => {
      const beforeCommit = jest.fn();
      await expectCode(
        service.joinRoom({ code, playerName: '도전자', ...extra }, B, T0, beforeCommit),
        errorCode,
      );
      expect(beforeCommit).not.toHaveBeenCalled();
    });

    it('만원·경기 중이면 비밀번호 검증 전에 거절하고 beforeCommit도 부르지 않는다 (리뷰 G6)', async () => {
      const full = (await create(D, { maxPlayers: 2, password: PW })).room.code;
      await service.joinRoom({ code: full, password: PW, playerName: '둘째' }, C, T0);
      const beforeCommit = jest.fn();
      const verify = jest.spyOn(roomPasswordCheck, 'matches');

      await expectCode(service.joinRoom({ code: full, password: PW, playerName: '셋째' }, B, T0, beforeCommit), 'ROOM_FULL');
      mock.patchRoom(code, (r) => (r.status = 'PLAYING'));
      await expectCode(
        service.joinRoom({ code, password: PW, playerName: '셋째' }, B, T0, beforeCommit),
        'MATCH_ALREADY_STARTED',
      );

      expect(beforeCommit).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    });

    it('검증을 통과하면 beforeCommit은 저장(CAS) 전에 정확히 1번 불린다 (리뷰 G6)', async () => {
      const writesAtCommit: number[] = [];
      const beforeCommit = jest.fn(async () => {
        writesAtCommit.push(mock.redis.eval.mock.calls.length);
      });
      const writesBefore = mock.redis.eval.mock.calls.length;

      await service.joinRoom({ code, password: PW, playerName: '도전자' }, B, T0, beforeCommit);

      expect(beforeCommit).toHaveBeenCalledTimes(1);
      expect(writesAtCommit).toEqual([writesBefore]);
      expect(mock.redis.eval.mock.calls.length).toBe(writesBefore + 1);
    });

    it(`정답 입장은 잠금에 쌓이지 않는다 — 같은 IP가 ${PASSWORD_FAILURE_LIMIT_IP.maxFailures}번 넘게 정답으로 들고 나도 잠기지 않는다 (리뷰 G7)`, async () => {
      const sameIp = (i: number): SocketIdentity => ({ socketId: `sock-ok-${i}`, userId: null, ip: '203.0.113.50' });
      for (let i = 0; i < PASSWORD_FAILURE_LIMIT_IP.maxFailures + 3; i++) {
        await service.joinRoom({ code, password: PW, playerName: '도전자' }, sameIp(i), T0);
        await service.leaveRoom(code, sameIp(i).socketId, T0);
      }
      expect(mock.strings.get(`tetris-battle:pwfail-ip:${code}:203.0.113.50`)).toBe('0');

      // 오답은 여전히 센다
      await expectCode(service.joinRoom({ code, password: 'x', playerName: '도전자' }, sameIp(999), T0), 'ROOM_WRONG_PASSWORD');
      expect(mock.strings.get(`tetris-battle:pwfail-ip:${code}:203.0.113.50`)).toBe('1');
    }, SCRYPT_HEAVY_TIMEOUT_MS);

    it('읽을 때는 멤버(비밀번호 생략)였는데 커밋 전에 빠졌으면 새 플레이어로 추가하지 않는다 — ROOM_BUSY (리뷰 F4)', async () => {
      await service.joinRoom({ code, password: PW, playerName: '둘째' }, B, T0);
      // 첫 읽기(멤버 판정) 직후, CAS 전에 다른 레플리카가 B를 내보냈다
      mock.redis.hgetall.mockImplementationOnce(async (key: string) => {
        const snapshot = { ...(mock.hashes.get(key) ?? {}) };
        mock.patchRoom(code, (r) => (r.players = r.players.filter((p) => p.socketId !== B.socketId)));
        return snapshot;
      });

      await expectCode(service.joinRoom({ code, playerName: '둘째' }, B, T0), 'ROOM_BUSY');
      expect(mock.readRoom(code)?.players.map((p) => p.socketId)).toEqual([A.socketId]);
    });
  });

  describe('joinRoom — 재연결 토큰', () => {
    it('끊긴 뒤 새 소켓이 토큰으로 들어오면 같은 playerId로 복귀(connected=true), 비밀번호는 묻지 않는다', async () => {
      const room = await create(A, { password: 'pw' });
      const joined = await service.joinRoom({ code: room.room.code, password: 'pw', playerName: '둘째' }, B, T0);
      await service.markDisconnected(room.room.code, B.socketId, T0);

      const back = await service.joinRoom(
        { code: room.room.code, playerName: '둘째', playerToken: joined.playerToken },
        C,
        T0 + 1000,
      );

      expect(back.playerId).toBe('p2');
      expect(back.playerToken).toBe(joined.playerToken);
      expect(back.replacedSocketId).toBeNull();
      expect(back.room.players[1]).toMatchObject({ playerId: 'p2', connected: true });
      expect(mock.readRoom(room.room.code)?.players[1].socketId).toBe(C.socketId);
    });

    it('아직 연결된 플레이어를 토큰으로 넘겨받으면 이전 소켓 id를 돌려준다(방 채널에서 빼기 위해)', async () => {
      const room = await create(A);
      const back = await service.joinRoom({ code: room.room.code, playerName: '방장', playerToken: room.playerToken }, C);

      expect(back.playerId).toBe('p1');
      expect(back.replacedSocketId).toBe(A.socketId);
      // 이전 소켓은 더 이상 멤버가 아니다
      await expectCode(service.setReady(room.room.code, A.socketId, true), 'NOT_IN_ROOM');
    });

    it('맞는 플레이어가 없는 토큰이면 INVALID_PLAYER_TOKEN', async () => {
      const room = await create(A);
      await expectCode(
        service.joinRoom({ code: room.room.code, playerName: '누구', playerToken: 'x'.repeat(32) }, B),
        'INVALID_PLAYER_TOKEN',
      );
    });

    it('이 소켓이 이미 같은 방의 다른 플레이어면 남의 토큰으로 두 자리를 잡을 수 없다 — INVALID_PLAYER_TOKEN (리뷰 F4)', async () => {
      const room = await create(A);
      const joined = await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.markDisconnected(room.room.code, B.socketId, T0);

      await expectCode(
        service.joinRoom({ code: room.room.code, playerName: '방장', playerToken: joined.playerToken }, A, T0 + 1),
        'INVALID_PLAYER_TOKEN',
      );
      expect(mock.readRoom(room.room.code)?.players.map((p) => p.socketId)).toEqual([A.socketId, null]);
    });

    it('재연결이 아니면 이미 멤버인 소켓도 이름을 검증한다', async () => {
      const room = await create(A);
      await expectCode(service.joinRoom({ code: room.room.code, playerName: '관리자' }, A), 'NAME_FORBIDDEN');
    });

    it('유예가 지나 정리된 플레이어의 토큰은 INVALID_PLAYER_TOKEN', async () => {
      const room = await create(A);
      const joined = await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.markDisconnected(room.room.code, B.socketId, T0);

      await expectCode(
        service.joinRoom(
          { code: room.room.code, playerName: '둘째', playerToken: joined.playerToken },
          C,
          T0 + DISCONNECT_GRACE_MS,
        ),
        'INVALID_PLAYER_TOKEN',
      );
    });

    it('이미 멤버인 소켓이 토큰 없이 다시 입장하면 토큰만 재발급한다(자리 추가 없음)', async () => {
      const room = await create(A);
      const again = await service.joinRoom({ code: room.room.code, playerName: '방장' }, A);

      expect(again.playerId).toBe('p1');
      expect(again.playerToken).not.toBe(room.playerToken);
      expect(again.room.players).toHaveLength(1);
      await expectCode(
        service.joinRoom({ code: room.room.code, playerName: '방장', playerToken: room.playerToken }, B),
        'INVALID_PLAYER_TOKEN',
      );
    });
  });

  describe('joinRoom — 같은 사람 중복 방지 (tetris-audit D-003·D-007)', () => {
    /** A와 같은 로그인 유저(userId 42)의 다른 탭·기기 */
    const A2: SocketIdentity = { socketId: 'sock-a2', userId: 42, ip: '10.0.0.1' };
    const B2: SocketIdentity = { socketId: 'sock-b2', userId: null, ip: '10.0.0.2' };

    it('로그인 유저가 다른 소켓으로 토큰 없이 들어오면 새 자리 대신 기존 자리를 넘겨받는다 — 토큰 재발급', async () => {
      const room = await create(A);
      const again = await service.joinRoom({ code: room.room.code, playerName: '다른이름' }, A2, T0 + 1);

      expect(again.playerId).toBe('p1');
      expect(again.replacedSocketId).toBe(A.socketId);
      expect(again.playerToken).not.toBe(room.playerToken);
      expect(again.room.players).toEqual([expect.objectContaining({ playerId: 'p1', name: '방장', connected: true })]);
      expect(again.room.hostId).toBe('p1');
      await expectCode(service.setReady(room.room.code, A.socketId, true), 'NOT_IN_ROOM');
      await expectCode(
        service.joinRoom({ code: room.room.code, playerName: '방장', playerToken: room.playerToken }, B),
        'INVALID_PLAYER_TOKEN',
      );
    });

    it('끊긴 뒤 유예 안에 다른 탭으로 다시 들어와도 자리가 하나다 — 방장 유지(제보 시나리오)', async () => {
      const room = await create(A);
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.markDisconnected(room.room.code, A.socketId, T0);

      const again = await service.joinRoom({ code: room.room.code, playerName: '방장' }, A2, T0 + 1000);

      expect(again.room.players.map((p) => [p.playerId, p.connected])).toEqual([
        ['p1', true],
        ['p2', true],
      ]);
      expect(again.room.hostId).toBe('p1');
      expect(again.replacedSocketId).toBeNull();
    });

    it('넘겨받기는 정원·비밀번호를 보지 않는다(이미 들어와 있던 사람)', async () => {
      const room = await create(A, { maxPlayers: 2, password: 'pw' });
      await service.joinRoom({ code: room.room.code, password: 'pw', playerName: '둘째' }, B, T0);

      await expect(service.joinRoom({ code: room.room.code, playerName: '방장' }, A2, T0 + 1)).resolves.toMatchObject({
        playerId: 'p1',
      });
    });

    it('넘겨받기를 거부하지 않으면 beforeCommit(이전 방 이탈)을 부른다 — 대기실에서는 바로 넘겨받는다', async () => {
      const room = await create(A);
      const beforeCommit = jest.fn(async () => undefined);
      await service.joinRoom({ code: room.room.code, playerName: '방장' }, A2, T0 + 1, beforeCommit);
      expect(beforeCommit).toHaveBeenCalledTimes(1);
    });

    it('게스트는 같은 사람인지 알 수 없어 새 자리가 된다(수용한 한계 — 프론트가 토큰을 브라우저 공용 저장소에 둔다)', async () => {
      const room = await create(A);
      await service.joinRoom({ code: room.room.code, playerName: '손님' }, B, T0);
      const second = await service.joinRoom({ code: room.room.code, playerName: '손님' }, B2, T0 + 1);
      expect(second.room.players).toHaveLength(3);
    });

    it('자리에 tabId를 저장하고, 넘겨받으면 새 tabId로 바꾼다', async () => {
      const room = await service.createRoom({ name: '방', maxPlayers: 4, playerName: '방장', tabId: 'tab-1' }, A, T0);
      expect(mock.readRoom(room.room.code)?.players[0].tabId).toBe('tab-1');

      await service.joinRoom({ code: room.room.code, playerName: '방장', playerToken: room.playerToken, tabId: 'tab-2' }, C, T0 + 1);
      expect(mock.readRoom(room.room.code)?.players[0].tabId).toBe('tab-2');

      await service.joinRoom({ code: room.room.code, playerName: '방장' }, A2, T0 + 2);
      expect(mock.readRoom(room.room.code)?.players[0].tabId).toBeNull();
    });
  });

  describe('kickPlayer (tetris-audit D-011)', () => {
    const roomWithGuest = async () => {
      const room = await create(A);
      const joined = await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      return { code: room.room.code, guestToken: joined.playerToken };
    };

    it('방장이 대기실에서 내보내면 자리를 빼고 그 소켓 id를 돌려준다 — 그 토큰은 무효, 다시 들어오면 새 자리', async () => {
      const { code, guestToken } = await roomWithGuest();

      const result = await service.kickPlayer(code, A.socketId, 'p2', T0 + 1);

      expect(result.kickedSocketId).toBe(B.socketId);
      expect(result.room?.players.map((p) => p.playerId)).toEqual(['p1']);
      expect(result.lobbyChanged).toBe(true);
      await expectCode(service.joinRoom({ code, playerName: '둘째', playerToken: guestToken }, B, T0 + 2), 'INVALID_PLAYER_TOKEN');
      await expect(service.joinRoom({ code, playerName: '둘째' }, B, T0 + 3)).resolves.toMatchObject({ playerId: 'p3' });
    });

    it('결과 화면(RESULT)에서도 내보낼 수 있다', async () => {
      const { code } = await roomWithGuest();
      mock.patchRoom(code, (r) => (r.status = 'RESULT'));
      await expect(service.kickPlayer(code, A.socketId, 'p2', T0 + 1)).resolves.toMatchObject({ kickedSocketId: B.socketId });
    });

    it.each([
      ['방장이 아님', 'sock-b', 'p1', 'NOT_HOST'],
      ['비멤버', 'sock-x', 'p2', 'NOT_IN_ROOM'],
      ['대상 없음', 'sock-a', 'p9', 'PLAYER_NOT_FOUND'],
      ['방장 자신', 'sock-a', 'p1', 'PLAYER_NOT_FOUND'],
    ] as const)('%s → %s(자리 그대로)', async (_label, socketId, target, code) => {
      const room = await roomWithGuest();
      await expectCode(service.kickPlayer(room.code, socketId, target, T0 + 1), code);
      expect(mock.readRoom(room.code)?.players).toHaveLength(2);
    });

    it('경기 중이면 MATCH_ALREADY_STARTED', async () => {
      const { code } = await roomWithGuest();
      mock.patchRoom(code, (r) => (r.status = 'PLAYING'));
      await expectCode(service.kickPlayer(code, A.socketId, 'p2', T0 + 1), 'MATCH_ALREADY_STARTED');
    });

    it(`방·방장 단위 ${TETRIS_BATTLE_RATE_LIMITS.kick.limit}회/${TETRIS_BATTLE_RATE_LIMITS.kick.windowSec}초 넘으면 RATE_LIMITED`, async () => {
      const { code } = await roomWithGuest();
      for (let i = 0; i < TETRIS_BATTLE_RATE_LIMITS.kick.limit; i++) {
        await expectCode(service.kickPlayer(code, A.socketId, 'p9', T0 + 1), 'PLAYER_NOT_FOUND');
      }
      await expectCode(service.kickPlayer(code, A.socketId, 'p2', T0 + 1), 'RATE_LIMITED');
    });
  });

  describe('하트비트 판정 (tetris-audit D-010·D-012)', () => {
    const hbKey = (code: string, socketId: string) => `tetris-battle:hb:${code}:${socketId}`;
    const settle = () => new Promise((r) => setImmediate(r));

    const heartbeatRoom = async () => {
      const room = await service.createRoom({ name: '방', maxPlayers: 4, playerName: '방장', heartbeat: true }, A, T0);
      await service.joinRoom({ code: room.room.code, playerName: '둘째', heartbeat: true }, B, T0);
      await service.joinRoom({ code: room.room.code, playerName: '옛탭' }, C, T0); // 하트비트 선언 없음
      return room.room.code;
    };

    it('하트비트를 선언하고 TTL 넘게 답이 없는 연결 자리만 끊김 표시 + 소켓 끊기 + 정리 예약', async () => {
      const code = await heartbeatRoom();
      const evictor = jest.fn();
      service.setSocketEvictor(evictor);
      const now = T0 + HEARTBEAT_TTL_MS;

      await service.recordHeartbeat(code, A.socketId, now); // p1(A)만 답함
      await settle();

      expect(mock.readRoom(code)?.players.map((p) => [p.playerId, p.connected])).toEqual([
        ['p1', true],
        ['p2', false],
        ['p3', true], // 선언하지 않은 옛 클라이언트는 판정하지 않는다
      ]);
      expect(evictor).toHaveBeenCalledWith([B.socketId]);
      expect(mock.strings.has(hbKey(code, A.socketId))).toBe(true);
      expect(wakes.map((w) => w.delayMs)).toContain(DISCONNECT_GRACE_MS + WAKE_MARGIN_MS);
    });

    it('연결된 지 TTL이 안 된 자리는 답이 없어도 건드리지 않는다', async () => {
      const code = await heartbeatRoom();
      await service.recordHeartbeat(code, A.socketId, T0 + HEARTBEAT_TTL_MS - 1);
      await settle();
      expect(mock.readRoom(code)?.players.every((p) => p.connected)).toBe(true);
    });

    it(`방당 ${HEARTBEAT_PROBE_INTERVAL_MS}ms에 1번만 판정한다(게이트)`, async () => {
      const code = await heartbeatRoom();
      const now = T0 + HEARTBEAT_TTL_MS;
      mock.strings.set(`tetris-battle:hbprobe:${code}`, '1'); // 다른 레플리카가 방금 판정함
      await service.recordHeartbeat(code, A.socketId, now);
      await settle();
      expect(mock.readRoom(code)?.players[1].connected).toBe(true);
    });

    it('답이 있으면(키가 살아 있으면) 끊지 않는다', async () => {
      const code = await heartbeatRoom();
      mock.strings.set(hbKey(code, B.socketId), '1'); // p2(B)는 방금 답함
      await service.recordHeartbeat(code, A.socketId, T0 + HEARTBEAT_TTL_MS);
      await settle();
      expect(mock.readRoom(code)?.players[1].connected).toBe(true);
    });
  });

  describe('하트비트는 소켓 단위 (리뷰 R1)', () => {
    it('자리를 넘겨준 옛 소켓이 계속 답해도 넘겨받은 소켓의 생존으로 세지 않는다', async () => {
      const room = await service.createRoom({ name: '방', maxPlayers: 4, playerName: '방장', heartbeat: true }, A, T0);
      const code = room.room.code;
      await service.joinRoom({ code, playerName: '방장', playerToken: room.playerToken, heartbeat: true }, C, T0); // A → C 넘겨받음
      mock.strings.set(`tetris-battle:hb:${code}:${A.socketId}`, '1'); // 옛 탭(A)만 계속 답함

      await service.recordHeartbeat(code, A.socketId, T0 + HEARTBEAT_TTL_MS);
      await new Promise((r) => setImmediate(r));

      expect(mock.readRoom(code)?.players[0]).toMatchObject({ connected: false, socketId: null });
    });
  });

  describe('leaveRoom · 방장 이양 · 삭제', () => {
    it('방장이 나가면 다음 입장자가 방장', async () => {
      const room = await create(A);
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.joinRoom({ code: room.room.code, playerName: '셋째' }, C, T0);

      const change = await service.leaveRoom(room.room.code, A.socketId, T0);

      expect(change.room?.hostId).toBe('p2');
      expect(change.lobbyChanged).toBe(true);
    });

    it('다음 입장자가 끊겨 있으면 연결된 사람 중 가장 먼저 들어온 사람에게 이양', async () => {
      const room = await create(A);
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.joinRoom({ code: room.room.code, playerName: '셋째' }, C, T0);
      await service.markDisconnected(room.room.code, B.socketId, T0);

      const change = await service.leaveRoom(room.room.code, A.socketId, T0 + 1);
      expect(change.room?.hostId).toBe('p3');
    });

    it('마지막 사람이 나가면 방과 로비 인덱스를 지운다', async () => {
      const room = await create(A);
      const change = await service.leaveRoom(room.room.code, A.socketId, T0);

      expect(change).toEqual({ room: null, lobbyChanged: true });
      expect(mock.hashes.has(roomKey(room.room.code))).toBe(false);
      expect(mock.zset.has(room.room.code)).toBe(false);
    });

    it('멤버가 아닌 소켓이면 NOT_IN_ROOM (아무것도 바꾸지 않는다)', async () => {
      const room = await create(A);
      await expectCode(service.leaveRoom(room.room.code, B.socketId), 'NOT_IN_ROOM');
      expect(mock.readRoom(room.room.code)?.players).toHaveLength(1);
    });
  });

  describe('setReady', () => {
    it('멤버면 ready 반영, 로비 목록 값은 그대로(lobbyChanged=false)', async () => {
      const room = await create(A);
      const change = await service.setReady(room.room.code, A.socketId, true);
      expect(change.room?.players[0].ready).toBe(true);
      expect(change.lobbyChanged).toBe(false);
    });

    it('멤버가 아니면 NOT_IN_ROOM', async () => {
      const room = await create(A);
      await expectCode(service.setReady(room.room.code, D.socketId, true), 'NOT_IN_ROOM');
    });

    it('WAITING이 아니면 MATCH_ALREADY_STARTED', async () => {
      const room = await create(A);
      mock.patchRoom(room.room.code, (r) => (r.status = 'RESULT'));
      await expectCode(service.setReady(room.room.code, A.socketId, true), 'MATCH_ALREADY_STARTED');
    });

    it(`방·플레이어 단위 ${TETRIS_BATTLE_RATE_LIMITS.setReady.limit}회/${TETRIS_BATTLE_RATE_LIMITS.setReady.windowSec}초 넘으면 RATE_LIMITED — 재연결로도 초기화 안 됨 (리뷰 G4)`, async () => {
      const room = await create(A);
      const { limit } = TETRIS_BATTLE_RATE_LIMITS.setReady;
      for (let i = 0; i < limit; i++) await service.setReady(room.room.code, A.socketId, i % 2 === 0);

      await service.markDisconnected(room.room.code, A.socketId, T0);
      await service.joinRoom({ code: room.room.code, playerName: '방장', playerToken: room.playerToken }, D, T0 + 1);
      await expectCode(service.setReady(room.room.code, D.socketId, true), 'RATE_LIMITED');
      expect(mock.strings.get(`tetris-battle:rl:setReady:${room.room.code}:p1`)).toBe(String(limit + 1));
    });

    it('같은 값이면 쓰지 않는다', async () => {
      const room = await create(A);
      mock.redis.eval.mockClear();
      await service.setReady(room.room.code, A.socketId, false);
      expect(mock.redis.eval).not.toHaveBeenCalled();
    });
  });

  describe('markDisconnected · lazy 정리', () => {
    it('connected=false로 표시하고 자리는 유지한다', async () => {
      const room = await create(A);
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);

      const change = await service.markDisconnected(room.room.code, B.socketId, T0);

      expect(change?.room?.players[1]).toMatchObject({ playerId: 'p2', connected: false });
      expect(change?.lobbyChanged).toBe(false);
    });

    it('대표 소켓이 아니면(이미 넘겨줌) 아무것도 바꾸지 않는다', async () => {
      const room = await create(A);
      mock.redis.eval.mockClear();
      await expect(service.markDisconnected(room.room.code, 'other', T0)).resolves.toBeNull();
      expect(mock.redis.eval).not.toHaveBeenCalled();
    });

    it('방이 없으면 null (에러 아님)', async () => {
      await expect(service.markDisconnected('ABCDEF', A.socketId)).resolves.toBeNull();
    });

    it('유예가 지나면 다음 변경 때 빠지고, 방장이면 이양된다', async () => {
      const room = await create(A);
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.markDisconnected(room.room.code, A.socketId, T0);

      const change = await service.setReady(room.room.code, B.socketId, true, T0 + DISCONNECT_GRACE_MS);

      expect(change.room?.players.map((p) => p.playerId)).toEqual(['p2']);
      expect(change.room?.hostId).toBe('p2');
      expect(change.lobbyChanged).toBe(true);
    });

    it('PLAYING 방은 정리하지 않는다 (P2가 KO로 처리)', async () => {
      const room = await create(A);
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.markDisconnected(room.room.code, A.socketId, T0);
      mock.patchRoom(room.room.code, (r) => (r.status = 'PLAYING'));

      await service.prepareEmote(room.room.code, B.socketId, 'gg');
      const rooms = await service.listRooms(T0 + DISCONNECT_GRACE_MS * 10);
      expect(rooms[0].playerCount).toBe(2);
    });

    it('전원이 유예를 넘겨 끊긴 방은 다음 접근에서 지워지고 ROOM_NOT_FOUND', async () => {
      const room = await create(A);
      await service.markDisconnected(room.room.code, A.socketId, T0);

      await expectCode(
        service.joinRoom({ code: room.room.code, playerName: '새사람' }, B, T0 + DISCONNECT_GRACE_MS),
        'ROOM_NOT_FOUND',
      );
      expect(mock.hashes.has(roomKey(room.room.code))).toBe(false);
    });
  });

  describe('유예 만료 깨우기 (tetris-audit D-009)', () => {
    it('끊기면 유예 + 여유 뒤로 정리를 한 번 예약한다 · 바뀐 게 없으면 예약하지 않는다', async () => {
      const room = await create(A);
      await service.markDisconnected(room.room.code, 'other', T0);
      expect(wakes).toHaveLength(0);

      await service.markDisconnected(room.room.code, A.socketId, T0);
      expect(wakes.map((w) => w.delayMs)).toEqual([DISCONNECT_GRACE_MS + WAKE_MARGIN_MS]);
    });

    it('아무도 조작하지 않아도 유예가 지나면 끊긴 자리를 빼고 방장을 넘기고 roomState를 알린다', async () => {
      const listener = jest.fn();
      service.setChangeListener(listener);
      const room = await create(A);
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.markDisconnected(room.room.code, A.socketId, T0);
      listener.mockClear();

      await service.sweepExpired(room.room.code, T0 + DISCONNECT_GRACE_MS);

      expect(mock.readRoom(room.room.code)).toMatchObject({ hostId: 'p2', players: [expect.objectContaining({ playerId: 'p2' })] });
      expect(listener).toHaveBeenCalledWith(room.room.code, expect.objectContaining({ hostId: 'p2' }), true);
    });

    it('유예가 지난 사람만 남은 방은 지우고 (code, null, true)를 알린다', async () => {
      const listener = jest.fn();
      service.setChangeListener(listener);
      const room = await create(A);
      await service.markDisconnected(room.room.code, A.socketId, T0);

      await service.sweepExpired(room.room.code, T0 + DISCONNECT_GRACE_MS);

      expect(mock.hashes.has(roomKey(room.room.code))).toBe(false);
      expect(listener).toHaveBeenLastCalledWith(room.room.code, null, true);
    });

    it('그 사이 다시 연결했으면 아무것도 바꾸지 않는다(멱등)', async () => {
      const room = await create(A);
      await service.markDisconnected(room.room.code, A.socketId, T0);
      await service.joinRoom({ code: room.room.code, playerName: '방장', playerToken: room.playerToken }, C, T0 + 1);
      mock.redis.eval.mockClear();

      await service.sweepExpired(room.room.code, T0 + DISCONNECT_GRACE_MS);

      expect(mock.redis.eval).not.toHaveBeenCalled();
      expect(mock.readRoom(room.room.code)?.players).toHaveLength(1);
    });

    it('방이 없거나 Redis를 못 쓰면 조용히 끝난다', async () => {
      await expect(service.sweepExpired('ABCDEF', T0)).resolves.toBeUndefined();
    });
  });

  describe('생존 확인 — 유령 정리 (리뷰 F3·G1)', () => {
    let probe: jest.Mock;
    let listener: jest.Mock;
    /** 백그라운드 생존 확인이 끝날 때까지 이벤트 루프를 돌린다 */
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };

    beforeEach(() => {
      probe = jest.fn();
      listener = jest.fn();
      service.setLiveSocketProbe(probe);
      service.setChangeListener(listener);
    });

    it('채널에 없고 연결 후 5초가 지난 connected 플레이어를 끊김으로 표시하고 방송한다', async () => {
      const room = await create(A, {}, T0);
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await settle();
      mock.strings.clear(); // 생성·입장 때 잡힌 확인 게이트를 비운다
      probe.mockResolvedValue(new Set([A.socketId])); // B의 레플리카가 죽어 disconnect 이벤트가 없었다

      await service.setReady(room.room.code, A.socketId, true, T0 + 5_000);
      await settle();

      expect(probe).toHaveBeenCalledWith(room.room.code);
      expect(mock.readRoom(room.room.code)?.players[1]).toMatchObject({
        playerId: 'p2',
        connected: false,
        socketId: null,
        disconnectedAt: T0 + 5_000,
      });
      expect(listener).toHaveBeenCalledWith(
        room.room.code,
        expect.objectContaining({ players: expect.arrayContaining([expect.objectContaining({ playerId: 'p2', connected: false })]) }),
        false,
      );

      // 이후 기존 유예 정리가 이어서 뺀다
      const later = await service.setReady(room.room.code, A.socketId, false, T0 + 5_000 + DISCONNECT_GRACE_MS);
      expect(later.room?.players.map((p) => p.playerId)).toEqual(['p1']);
    });

    it('probe가 응답하지 않아도 요청은 기다리지 않고 바로 끝난다 (리뷰 G1)', async () => {
      const room = await create(A, {}, T0);
      mock.strings.clear();
      probe.mockReturnValue(new Promise(() => undefined)); // 영원히 응답 없음

      await expect(service.setReady(room.room.code, A.socketId, true, T0 + 6_000)).resolves.toMatchObject({
        room: { players: [{ ready: true }] },
      });
      await expect(service.leaveRoom(room.room.code, A.socketId, T0 + 6_000)).resolves.toEqual({
        room: null,
        lobbyChanged: true,
      });
      expect(probe).toHaveBeenCalled();
    });

    it('연결된 지 5초가 안 됐으면 채널에 없어도 건드리지 않는다(커밋과 채널 입장 사이 틈)', async () => {
      const room = await create(A, {}, T0);
      mock.strings.clear();
      probe.mockResolvedValue(new Set());

      await service.setReady(room.room.code, A.socketId, true, T0 + 4_999);
      await settle();
      expect(mock.readRoom(room.room.code)?.players[0].connected).toBe(true);
    });

    it('유령을 끊김으로 표시하면 유예 뒤 정리를 예약한다 — 하트비트 없는 옛 클라이언트도 남지 않게 (리뷰 R2)', async () => {
      const room = await create(A, {}, T0);
      mock.strings.clear();
      probe.mockResolvedValue(new Set());
      wakes.length = 0;

      await service.setReady(room.room.code, A.socketId, true, T0 + 60_000).catch(() => undefined);
      await settle();

      expect(wakes.map((w) => w.delayMs)).toContain(DISCONNECT_GRACE_MS + WAKE_MARGIN_MS);
    });

    it('방당 15초에 1번만 확인한다(Redis NX 게이트)', async () => {
      const room = await create(A, {}, T0);
      mock.strings.clear();
      probe.mockResolvedValue(new Set([A.socketId]));

      await service.setReady(room.room.code, A.socketId, true, T0 + 6_000);
      await settle();
      await service.setReady(room.room.code, A.socketId, false, T0 + 7_000);
      await settle();

      expect(probe).toHaveBeenCalledTimes(1);
      expect(mock.redis.set).toHaveBeenCalledWith(`tetris-battle:probe:${room.room.code}`, '1', 'PX', 15_000, 'NX');
    });

    it('확인이 실패(타임아웃 등)해도 요청은 그대로 처리한다', async () => {
      const room = await create(A, {}, T0);
      mock.strings.clear();
      probe.mockRejectedValue(new Error('timeout'));

      await expect(service.setReady(room.room.code, A.socketId, true, T0 + 6_000)).resolves.toMatchObject({
        room: { players: [{ ready: true, connected: true }] },
      });
      await settle();
    });

    it('listRooms도 보여 줄 방의 확인을 시작한다', async () => {
      const room = await create(A, {}, T0);
      mock.strings.clear();
      probe.mockResolvedValue(new Set([A.socketId]));

      await service.listRooms(T0 + 6_000);
      await settle();
      expect(probe).toHaveBeenCalledWith(room.room.code);
    });

    it('유령이 0명이어도 정리(유예 지난 플레이어 제거)로 방이 바뀌었으면 방송한다 (리뷰 G3)', async () => {
      const room = await create(A, {}, T0);
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.markDisconnected(room.room.code, B.socketId, T0);
      await settle();
      mock.strings.clear();
      listener.mockClear();
      probe.mockResolvedValue(new Set([A.socketId]));

      // listRooms는 읽기만 한다 → 정리 저장은 생존 확인 경로에서 일어난다
      await service.listRooms(T0 + DISCONNECT_GRACE_MS);
      await settle();

      expect(mock.readRoom(room.room.code)?.players.map((p) => p.playerId)).toEqual(['p1']);
      expect(listener).toHaveBeenCalledWith(
        room.room.code,
        expect.objectContaining({ players: [expect.objectContaining({ playerId: 'p1' })] }),
        true,
      );
    });
  });

  describe('정리만 일어난 변경도 방송한다 (리뷰 F7)', () => {
    let listener: jest.Mock;

    beforeEach(() => {
      listener = jest.fn();
      service.setChangeListener(listener);
    });

    it('요청이 거부돼도(비멤버) 유예 지난 플레이어 정리는 저장하고 roomState·roomsChanged를 알린다', async () => {
      const room = await create(A, {}, T0);
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.markDisconnected(room.room.code, B.socketId, T0);

      await expectCode(service.leaveRoom(room.room.code, D.socketId, T0 + DISCONNECT_GRACE_MS), 'NOT_IN_ROOM');

      expect(mock.readRoom(room.room.code)?.players.map((p) => p.playerId)).toEqual(['p1']);
      expect(listener).toHaveBeenCalledWith(
        room.room.code,
        expect.objectContaining({ players: [expect.objectContaining({ playerId: 'p1' })] }),
        true,
      );
    });

    it('끊김 대상이 없어도(이미 넘겨준 소켓) 정리로 방이 바뀌었으면 방송한다 (리뷰 G3)', async () => {
      const room = await create(A, {}, T0);
      await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);
      await service.markDisconnected(room.room.code, B.socketId, T0);
      listener.mockClear();

      await expect(service.markDisconnected(room.room.code, 'stale-socket', T0 + DISCONNECT_GRACE_MS)).resolves.toBeNull();

      expect(mock.readRoom(room.room.code)?.players.map((p) => p.playerId)).toEqual(['p1']);
      expect(listener).toHaveBeenCalledWith(room.room.code, expect.objectContaining({ hostId: 'p1' }), true);
    });

    it('전원 정리로 방이 지워지면 (code, null, true)를 알린다', async () => {
      const room = await create(A, {}, T0);
      await service.markDisconnected(room.room.code, A.socketId, T0);

      await expectCode(
        service.joinRoom({ code: room.room.code, playerName: '새사람' }, B, T0 + DISCONNECT_GRACE_MS),
        'ROOM_NOT_FOUND',
      );
      expect(listener).toHaveBeenCalledWith(room.room.code, null, true);
    });
  });

  describe('동시성 — CAS 충돌', () => {
    it('버전이 바뀌었으면(다른 레플리카가 먼저 씀) 다시 읽고 재시도한다', async () => {
      const room = await create(A);
      mock.redis.eval.mockClear();
      mock.state.forceCasConflicts = 2;

      const result = await service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0);

      expect(result.playerId).toBe('p2');
      expect(mock.redis.eval).toHaveBeenCalledTimes(3);
    });

    it('재시도 사이에 다른 입장이 끼어들면 그 결과 위에 쌓는다(덮어쓰지 않는다)', async () => {
      const room = await create(A, { maxPlayers: 2 });
      // 첫 CAS 직전에 다른 레플리카가 C를 넣었다고 가정
      mock.redis.eval.mockImplementationOnce(async () => {
        mock.patchRoom(room.room.code, (r) => {
          r.players.push({ ...r.players[0], playerId: 'p2', socketId: C.socketId, tokenHash: 'x' });
          r.nextPlayerSeq = 3;
        });
        return 0;
      });

      await expectCode(service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0), 'ROOM_FULL');
      expect(mock.readRoom(room.room.code)?.players.map((p) => p.socketId)).toEqual([A.socketId, C.socketId]);
    });

    it(`${ROOM_CAS_MAX_ATTEMPTS}번 모두 충돌하면 ROOM_BUSY`, async () => {
      const room = await create(A);
      mock.state.forceCasConflicts = ROOM_CAS_MAX_ATTEMPTS;
      await expectCode(service.joinRoom({ code: room.room.code, playerName: '둘째' }, B, T0), 'ROOM_BUSY');
    });
  });

  describe('prepareChat · prepareEmote', () => {
    let code: string;

    beforeEach(async () => {
      code = (await create(A)).room.code;
    });

    it('멤버면 브로드캐스트 페이로드를 만든다', async () => {
      await expect(service.prepareChat(code, A.socketId, '안녕', T0)).resolves.toEqual({
        playerId: 'p1',
        name: '방장',
        text: '안녕',
        at: new Date(T0).toISOString(),
      });
    });

    it('멤버가 아니면 NOT_IN_ROOM', async () => {
      await expectCode(service.prepareChat(code, B.socketId, '안녕'), 'NOT_IN_ROOM');
      await expectCode(service.prepareEmote(code, B.socketId, 'gg'), 'NOT_IN_ROOM');
    });

    it('없는 방이면 ROOM_NOT_FOUND', async () => {
      await expectCode(service.prepareChat('ABCDEF', A.socketId, '안녕'), 'ROOM_NOT_FOUND');
    });

    it('경기 중(PLAYING)에도 이모트는 허용 — 채팅의 생존자·탈락자 규칙은 매치 스펙(D-016)', async () => {
      mock.patchRoom(code, (r) => (r.status = 'PLAYING'));
      await expect(service.prepareEmote(code, A.socketId, 'gg')).resolves.toMatchObject({ emoteId: 'gg' });
    });

    it('RESULT에서는 채팅 허용', async () => {
      mock.patchRoom(code, (r) => (r.status = 'RESULT'));
      await expect(service.prepareChat(code, A.socketId, 'gg')).resolves.toMatchObject({ text: 'gg' });
    });

    it('금칙어면 CHAT_FORBIDDEN', async () => {
      await expectCode(service.prepareChat(code, A.socketId, '시 발 진짜'), 'CHAT_FORBIDDEN');
    });

    it.each([
      ['줄바꿈', '안녕\n하세요'],
      ['bidi 오버라이드', '안녕\u202E요세하'],
      ['방향 격리', '\u2066숨김\u2069'],
      ['제로폭 문자로 금칙어 쪼개기(금칙어 정규화가 잡는다)', '시\u200B발'],
    ])('금지 문자(%s)면 CHAT_FORBIDDEN — 리뷰 F8·G5', async (_label, text) => {
      await expectCode(service.prepareChat(code, A.socketId, text), 'CHAT_FORBIDDEN');
    });

    it.each([
      ['ZWJ 이모지', '코딩 중 👩‍💻'],
      ['변형 선택자 이모지', '좋아요 ❤️'],
      ['국기', '🇰🇷 화이팅'],
    ])('이모지 구성 문자(%s)는 허용한다 — 리뷰 G5', async (_label, text) => {
      await expect(service.prepareChat(code, A.socketId, text)).resolves.toMatchObject({ text });
    });

    it('빈도 제한은 플레이어 단위 — 재연결(새 소켓)로 초기화되지 않는다 (리뷰 F5)', async () => {
      const { limit } = TETRIS_BATTLE_RATE_LIMITS.chat;
      for (let i = 0; i < limit; i++) await service.prepareChat(code, A.socketId, `메시지${i}`);

      const token = (await service.joinRoom({ code, playerName: '방장' }, A)).playerToken;
      await service.markDisconnected(code, A.socketId, T0);
      await service.joinRoom({ code, playerName: '방장', playerToken: token }, D, T0 + 1);

      await expectCode(service.prepareChat(code, D.socketId, '새 소켓으로'), 'RATE_LIMITED');
    });

    it('소켓 단위 빈도 한도를 넘으면 RATE_LIMITED', async () => {
      const { limit } = TETRIS_BATTLE_RATE_LIMITS.chat;
      for (let i = 0; i < limit; i++) await service.prepareChat(code, A.socketId, `메시지${i}`);
      await expectCode(service.prepareChat(code, A.socketId, '하나 더'), 'RATE_LIMITED');
    });

    it('이모트도 빈도 한도를 넘으면 RATE_LIMITED', async () => {
      const { limit } = TETRIS_BATTLE_RATE_LIMITS.emote;
      for (let i = 0; i < limit; i++) await service.prepareEmote(code, A.socketId, 'wow');
      await expectCode(service.prepareEmote(code, A.socketId, 'wow'), 'RATE_LIMITED');
    });
  });

  describe('consumeRateLimit', () => {
    it('Redis 명령이 실패하면 통과시킨다(fail-open)', async () => {
      mock.redis.multi.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      await expect(service.consumeRateLimit('chat', 's')).resolves.toBe(true);
    });
  });
});

import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ENGINE_VERSION, MAP_IDS, createMatch } from './engine';
import { FortressMatchService, MatchBroadcast } from './fortress-match.service';
import { DISCONNECT_GRACE_MS, FORTRESS_RATE_LIMITS, MATCH_DISCONNECT_GRACE_MS, MATCH_START_DELAY_MS } from './fortress.constants';
import { RoomSettings, TurnResolvedPayload } from './fortress.events';
import { FortressRoomService, SocketIdentity } from './fortress-room.service';
import { DEADLINES_KEY, LOBBY_KEY, codeOf, createRedisMock, expectCode, matchKey } from './__spec__/redis-mock';

const T0 = 1_800_000_000_000;
const who = (n: number, userId: number | null = null): SocketIdentity => ({ socketId: `sock-${n}`, userId, ip: `10.0.0.${n}` });
const A = who(1, 42);
const B = who(2);
const C = who(3);
const D = who(4);
const E = who(5);

/**
 * 포트리스 방 서비스 — 방 설정·팀·탱크·시작 조건(DESIGN §11)과 입장 4갈래·경기 연동(이탈 resign·끊김·재연결 복원).
 * 경기 서비스는 진짜(같은 Redis 대역)를 붙인다 — 방과 경기가 같은 상태를 보는지가 검증 대상이다.
 */
describe('FortressRoomService', () => {
  let mock: ReturnType<typeof createRedisMock>;
  let matches: FortressMatchService;
  let service: FortressRoomService;
  let broadcasts: MatchBroadcast[];
  let changes: { code: string; status: string | null }[];

  const create = (settings: Partial<RoomSettings> = {}, host = A, extra: { password?: string } = {}) =>
    service.createRoom({ name: '포트리스 한판', mode: 'ffa', mapId: 'hills', maxPlayers: 4, playerName: '방장', ...settings, ...extra }, host, T0);
  const join = (code: string, w: SocketIdentity, name = '도전자', extra: { playerToken?: string; tabId?: string; password?: string } = {}, now = T0) =>
    service.joinRoom({ code, playerName: name, ...extra }, w, now);
  /** 방장 A + 나머지 입장, 전원 준비 */
  const readyRoom = async (settings: Partial<RoomSettings> = {}, others: SocketIdentity[] = [B]) => {
    const { room } = await create(settings);
    for (const [i, o] of others.entries()) await join(room.code, o, `도전자${i + 1}`);
    for (const o of others) await service.setReady(room.code, o.socketId, true, T0);
    return room.code;
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mock = createRedisMock();
    matches = new FortressMatchService();
    matches.setRedisClient(mock.redis as unknown as Redis);
    broadcasts = [];
    matches.setBroadcastListener((_code, b) => broadcasts.push(b));
    matches.setWakeScheduler(() => undefined);
    service = new FortressRoomService(matches);
    service.setRedisClient(mock.redis as unknown as Redis);
    service.setWakeScheduler(() => undefined);
    changes = [];
    service.setChangeListener((code, room) => changes.push({ code, status: room?.status ?? null }));
  });

  afterEach(() => jest.restoreAllMocks());

  describe('createRoom', () => {
    it('ffa: 설정 그대로, 방장 p1 team null·탱크 0·기본 스킨, 로비 인덱스에 들어간다', async () => {
      const result = await create({ maxPlayers: 3, mapId: 'random' });
      expect(result.room).toEqual({
        code: result.room.code,
        name: '포트리스 한판',
        mode: 'ffa',
        mapId: 'random',
        maxPlayers: 3,
        locked: false,
        hostId: 'p1',
        status: 'WAITING',
        players: [{ playerId: 'p1', name: '방장', ready: false, connected: true, isGuest: false, extra: { team: null, tankId: 0, skin: { id: 'default', level: 1 } } }],
      });
      expect(mock.zsets.get(LOBBY_KEY)?.has(result.room.code)).toBe(true);
      expect(mock.readRoom(result.room.code)?.match).toBeNull();
    });

    it('team: maxPlayers는 4로 고정, 방장은 team 0', async () => {
      const result = await create({ mode: 'team', maxPlayers: 2 });
      expect(result.room.maxPlayers).toBe(4);
      expect(result.room.players[0].extra.team).toBe(0);
    });

    it('이름 검사 — 방 이름 금칙어 ROOM_NAME_FORBIDDEN, 플레이어 이름 형식 NAME_INVALID (Redis에 쓰지 않는다)', async () => {
      await expectCode(service.createRoom({ name: '씨발 방', mode: 'ffa', mapId: 'hills', maxPlayers: 2, playerName: '방장' }, A, T0), 'ROOM_NAME_FORBIDDEN');
      await expectCode(service.createRoom({ name: '방', mode: 'ffa', mapId: 'hills', maxPlayers: 2, playerName: '!!' }, A, T0), 'NAME_INVALID');
      expect(mock.redis.eval).not.toHaveBeenCalled();
    });
  });

  describe('joinRoom — 입장 4갈래', () => {
    it('새 자리: team 모드는 입장 순서대로 0,1,0,1 (적은 팀, 같으면 0)', async () => {
      const { room } = await create({ mode: 'team' });
      await join(room.code, B, '둘');
      await join(room.code, C, '셋');
      const last = await join(room.code, D, '넷');
      expect(last.room.players.map((p) => p.extra.team)).toEqual([0, 1, 0, 1]);
      await expectCode(join(room.code, E, '다섯'), 'ROOM_FULL');
    });

    it('토큰 재연결: 같은 playerId로 복귀, 이전 소켓을 replacedSocketId로 돌려준다', async () => {
      const { room } = await create();
      const first = await join(room.code, B);
      const again = await join(room.code, C, '아무개', { playerToken: first.playerToken });
      expect(again.playerId).toBe(first.playerId);
      expect(again.playerToken).toBe(first.playerToken);
      expect(again.replacedSocketId).toBe(B.socketId);
      expect(again.room.players).toHaveLength(2);
    });

    it('같은 소켓 재입장: 토큰만 새로 준다(자리 그대로)', async () => {
      const { room, playerToken } = await create();
      const again = await join(room.code, A, '방장');
      expect(again.playerId).toBe('p1');
      expect(again.playerToken).not.toBe(playerToken);
      expect(again.replacedSocketId).toBeNull();
    });

    it('같은 계정 다른 탭: 그 자리를 넘겨받는다 — replacedSocketId', async () => {
      const { room } = await create();
      const otherTab = { ...who(9, 42) };
      const again = await join(room.code, otherTab, '방장');
      expect(again.playerId).toBe('p1');
      expect(again.replacedSocketId).toBe(A.socketId);
    });

    it('경기 중: 새 입장은 MATCH_ALREADY_STARTED, 다른 탭이 연결된 자리 넘겨받기는 SEAT_IN_USE', async () => {
      const code = await readyRoom();
      await service.startMatch(code, A.socketId, T0);
      await expectCode(join(code, C, '새사람'), 'MATCH_ALREADY_STARTED');
      await expectCode(join(code, who(9, 42), '방장'), 'SEAT_IN_USE');
    });

    it('잘못된 토큰 INVALID_PLAYER_TOKEN · 오답 ROOM_WRONG_PASSWORD · 없는 방 ROOM_NOT_FOUND', async () => {
      const { room } = await create({}, A, { password: 'pw' });
      await expectCode(join(room.code, B, '도전자', { playerToken: 'x'.repeat(32) }), 'INVALID_PLAYER_TOKEN');
      await expectCode(join(room.code, B, '도전자', { password: 'nope' }), 'ROOM_WRONG_PASSWORD');
      await expectCode(join('ZZZZZZ', B), 'ROOM_NOT_FOUND');
    });
  });

  describe('updateSettings', () => {
    it('방장만(NOT_HOST) · 바뀌면 전원 ready=false · 바뀐 게 없으면 ready 유지', async () => {
      const code = await readyRoom();
      await expectCode(service.updateSettings(code, B.socketId, { mapId: 'canyon' }, T0), 'NOT_HOST');

      const same = await service.updateSettings(code, A.socketId, { mapId: 'hills' }, T0);
      expect(same.room?.players[1].ready).toBe(true);

      const changed = await service.updateSettings(code, A.socketId, { mapId: 'canyon' }, T0);
      expect(changed.room).toMatchObject({ mapId: 'canyon' });
      expect(changed.room?.players.every((p) => !p.ready)).toBe(true);
      expect(changed.lobbyChanged).toBe(true);
    });

    it('현재 인원보다 작은 maxPlayers는 TOO_MANY_PLAYERS', async () => {
      const code = await readyRoom({}, [B, C]);
      await expectCode(service.updateSettings(code, A.socketId, { maxPlayers: 2 }, T0), 'TOO_MANY_PLAYERS');
    });

    it('team으로 바꾸면 maxPlayers 4·입장 순서 0,1,0,(1) 자동 배정(3명이어도 허용), ffa로 바꾸면 team null', async () => {
      const code = await readyRoom({ maxPlayers: 3 }, [B, C]);
      const team = await service.updateSettings(code, A.socketId, { mode: 'team', maxPlayers: 3 }, T0);
      expect(team.room).toMatchObject({ mode: 'team', maxPlayers: 4 });
      expect(team.room?.players.map((p) => p.extra.team)).toEqual([0, 1, 0]);

      const ffa = await service.updateSettings(code, A.socketId, { mode: 'ffa', maxPlayers: 3 }, T0);
      expect(ffa.room?.players.map((p) => p.extra.team)).toEqual([null, null, null]);
    });

    it('경기 중이면 MATCH_ALREADY_STARTED', async () => {
      const code = await readyRoom();
      await service.startMatch(code, A.socketId, T0);
      await expectCode(service.updateSettings(code, A.socketId, { mapId: 'canyon' }, T0), 'MATCH_ALREADY_STARTED');
    });
  });

  describe('setTeam·setTank', () => {
    it('setTeam: 다른 사람이 이미 2명인 팀은 TEAM_FULL, 옮겨도 ready 유지', async () => {
      const code = await readyRoom({ mode: 'team' }, [B, C]); // 0,1,0
      await expectCode(service.setTeam(code, B.socketId, 0, T0), 'TEAM_FULL');
      const moved = await service.setTeam(code, C.socketId, 1, T0);
      expect(moved.room?.players.map((p) => [p.extra.team, p.ready])).toEqual([
        [0, false],
        [1, true],
        [1, true],
      ]);
    });

    it('setTeam: ffa 방이면 INVALID_PAYLOAD', async () => {
      const code = await readyRoom();
      await expectCode(service.setTeam(code, B.socketId, 1, T0), 'INVALID_PAYLOAD');
    });

    it('setTank: 바꿔도 ready 유지 · 범위 밖 INVALID_PAYLOAD · 멤버 아님 NOT_IN_ROOM', async () => {
      const code = await readyRoom();
      const changed = await service.setTank(code, B.socketId, 2, T0);
      expect(changed.room?.players[1].extra).toMatchObject({ tankId: 2 });
      expect(changed.room?.players[1].ready).toBe(true);
      await expectCode(service.setTank(code, B.socketId, 3, T0), 'INVALID_PAYLOAD');
      await expectCode(service.setTank(code, C.socketId, 1, T0), 'NOT_IN_ROOM');
    });
  });

  describe('startMatch — 시작 조건', () => {
    it('방장 아님 NOT_HOST · 혼자 NOT_ENOUGH_PLAYERS · 준비 안 함 NOT_ALL_READY', async () => {
      const { room } = await create();
      await expectCode(service.startMatch(room.code, A.socketId, T0), 'NOT_ENOUGH_PLAYERS');
      await join(room.code, B);
      await expectCode(service.startMatch(room.code, B.socketId, T0), 'NOT_HOST');
      await expectCode(service.startMatch(room.code, A.socketId, T0), 'NOT_ALL_READY');
    });

    it('끊긴 참가자가 있으면 NOT_ALL_READY', async () => {
      const code = await readyRoom();
      await service.markDisconnected(code, B.socketId, T0);
      await expectCode(service.startMatch(code, A.socketId, T0 + 1), 'NOT_ALL_READY');
    });

    it('team: 정확히 2:2가 아니면 TEAM_UNBALANCED (3명·4명 1:3 모두)', async () => {
      const three = await readyRoom({ mode: 'team' }, [B, C]);
      await expectCode(service.startMatch(three, A.socketId, T0), 'TEAM_UNBALANCED');

      const four = await readyRoom({ mode: 'team' }, [B, C, D]); // 0,1,0,1
      // setTeam은 TEAM_FULL로 1:3을 막지만, 저장된 방이 1:3이어도(옛 기록·경합) 시작에서 다시 막는다
      mock.patchRoom(four, (room) => {
        room.players[1].team = 0;
      });
      await expectCode(service.startMatch(four, A.socketId, T0), 'TEAM_UNBALANCED');
    });

    it('성공: slot = 입장 순서, random 맵은 실제 맵으로, 엔진이 받는 config·첫 TurnInfo, 방 PLAYING', async () => {
      const code = await readyRoom({ mapId: 'random' }, [B, C]);
      await service.setTank(code, C.socketId, 2, T0);
      const result = await service.startMatch(code, A.socketId, T0);

      const { starting } = result;
      expect(MAP_IDS).toContain(starting.config.mapId);
      expect(starting.config.mode).toBe('ffa');
      expect(starting.config.players).toEqual([
        { slot: 0, team: 0, tankId: 0 },
        { slot: 1, team: 0, tankId: 0 },
        { slot: 2, team: 0, tankId: 2 },
      ]);
      expect(createMatch(starting.config).ok).toBe(true);
      expect(starting.slots).toEqual([
        { slot: 0, playerId: 'p1', name: '방장', skin: { id: 'default', level: 1 } },
        { slot: 1, playerId: 'p2', name: '도전자1', skin: { id: 'default', level: 1 } },
        { slot: 2, playerId: 'p3', name: '도전자2', skin: { id: 'default', level: 1 } },
      ]);
      expect(starting).toMatchObject({ engineVersion: ENGINE_VERSION, startInMs: MATCH_START_DELAY_MS, turn: { seq: 0, turnNo: 0 } });
      expect(result.room?.status).toBe('PLAYING');
      expect(mock.readRoom(code)?.match).toEqual({ matchId: starting.matchId, playerIds: ['p1', 'p2', 'p3'] });
      expect(mock.readMatch(starting.matchId)?.code).toBe(code);
      // 리뷰 B1: 방 CAS 성공 뒤 activate가 첫 마감을 건다
      expect(mock.deadlineOf(starting.matchId)).toBe(mock.readMatch(starting.matchId)?.deadlineAt);
    });

    it('리뷰 B1: 방 CAS가 실패하면(그 사이 탱크 변경) 경기 키를 지우고 마감은 걸지 않는다 — ROOM_BUSY', async () => {
      const code = await readyRoom({}, [B]);
      const realCreate = matches.create.bind(matches);
      let matchId = '';
      jest.spyOn(matches, 'create').mockImplementationOnce(async (input, now) => {
        const created = await realCreate(input, now);
        matchId = created.matchId;
        await service.setTank(code, B.socketId, 2, T0);
        return created;
      });
      const activate = jest.spyOn(matches, 'activate');

      await expectCode(service.startMatch(code, A.socketId, T0), 'ROOM_BUSY');
      expect(activate).not.toHaveBeenCalled();
      expect(mock.readMatch(matchId)).toBeNull();
      expect(mock.deadlineOf(matchId)).toBeUndefined();
      expect(mock.readRoom(code)?.status).toBe('WAITING');
    });

    it('리뷰 B1·2차: 방 CAS 뒤 마감 걸기가 실패하면 경기 키를 지우고 방을 WAITING으로 되돌려 알린다 — 방장이 다시 시작할 수 있다', async () => {
      const code = await readyRoom({}, [B]);
      const create = jest.spyOn(matches, 'create');
      jest.spyOn(matches, 'activate').mockRejectedValueOnce(new Error('redis down'));

      await expect(service.startMatch(code, A.socketId, T0)).rejects.toThrow('redis down');
      const failedMatchId = (await create.mock.results[0].value as { matchId: string }).matchId;
      expect(mock.readMatch(failedMatchId)).toBeNull();
      const room = mock.readRoom(code);
      expect(room?.status).toBe('WAITING');
      expect(room?.match).toBeNull();
      expect(changes).toContainEqual({ code, status: 'WAITING' });
      expect(mock.zsets.get(DEADLINES_KEY)?.size ?? 0).toBe(0);

      const { starting } = await service.startMatch(code, A.socketId, T0 + 1);
      expect(mock.readRoom(code)?.match?.matchId).toBe(starting.matchId);
    });

    it('team: config에 팀이 실린다', async () => {
      const code = await readyRoom({ mode: 'team' }, [B, C, D]);
      const { starting } = await service.startMatch(code, A.socketId, T0);
      expect(starting.config.players.map((p) => p.team)).toEqual([0, 1, 0, 1]);
    });
  });

  describe('경기 연동', () => {
    const started = async (others: SocketIdentity[] = [B]) => {
      const code = await readyRoom({}, others);
      const { starting } = await service.startMatch(code, A.socketId, T0);
      return { code, matchId: starting.matchId, first: starting.turn.slot };
    };
    const resolved = () => broadcasts.filter((b) => b.event === 'turnResolved').map((b) => b.payload as TurnResolvedPayload);

    it('턴 제출은 경기 서비스로 — 다른 matchId MATCH_NOT_FOUND, 멤버 아님 NOT_IN_ROOM', async () => {
      const { code, matchId, first } = await started();
      const turnOwner = first === 0 ? A : B;
      await service.turnSubmit(code, turnOwner.socketId, { matchId, seq: 0, move: 0, angle: 45, power: 0, weaponId: 0 }, T0 + MATCH_START_DELAY_MS);
      expect(resolved()).toHaveLength(1);
      await expectCode(service.turnSubmit(code, A.socketId, { matchId: 'BBBBBBBBBBBBBBBB', seq: 1, move: 0, angle: 45, power: 0, weaponId: 0 }, T0), 'MATCH_NOT_FOUND');
      await expectCode(service.turnSubmit(code, C.socketId, { matchId, seq: 1, move: 0, angle: 45, power: 0, weaponId: 0 }, T0), 'NOT_IN_ROOM');
    });

    it('경기 중 이탈 = 즉시 resign(leave) — 2인이면 끝나 방 RESULT, 돌려주는 room도 RESULT', async () => {
      const { code } = await started();
      const change = await service.leaveRoom(code, B.socketId, T0 + 1_000);
      expect(resolved()).toEqual([expect.objectContaining({ action: { kind: 'resign', slot: 1 }, cause: 'leave', next: null })]);
      expect(broadcasts.filter((b) => b.event === 'matchEnded')).toHaveLength(1);
      expect(change.room?.status).toBe('RESULT');
      expect(changes).toContainEqual({ code, status: 'RESULT' });
    });

    it('경기 중 끊김 → 경기에 끊김 시각, 30초 지나면 resign(disconnect) · 유예 안 재연결은 해제 + rejoin.match', async () => {
      const { code, matchId } = await started([B, C]);
      const b = await service.joinRoom({ code, playerName: '도전자1' }, B, T0); // 같은 소켓 → 토큰 확보
      await service.markDisconnected(code, B.socketId, T0 + 1_000);
      expect(mock.readMatch(matchId)?.slots[1].disconnectedAt).toBe(T0 + 1_000);
      // 경기 중에는 방 유예(10초)로 자리를 빼지 않는다
      expect(mock.readRoom(code)?.players).toHaveLength(3);

      const back = await service.joinRoom({ code, playerName: '도전자1', playerToken: b.playerToken }, who(7), T0 + 1_000 + DISCONNECT_GRACE_MS + 1);
      expect(back.playerId).toBe('p2');
      expect(back.rejoin?.match).toMatchObject({ matchId, engineVersion: ENGINE_VERSION, actions: [], turn: { seq: 0 } });
      expect(mock.readMatch(matchId)?.slots[1].disconnectedAt).toBeNull();

      await service.markDisconnected(code, C.socketId, T0 + 2_000);
      await matches.processDue(matchId, T0 + 2_000 + MATCH_DISCONNECT_GRACE_MS);
      // 끊김 resign이 먼저, 그 뒤 지난 턴 마감 skip(같은 깨우기에서 연달아)
      expect(resolved()[0]).toMatchObject({ seq: 0, action: { kind: 'resign', slot: 2 }, cause: 'disconnect' });
      expect(resolved().slice(1).every((r) => r.cause === 'timeout')).toBe(true);
    });

    it('끊김 기록 뒤 그 사이 재연결했으면 기록을 지운다(살아 있는 사람을 resign하지 않게)', async () => {
      const { code, matchId } = await started();
      const realSet = matches.setDisconnected.bind(matches);
      jest.spyOn(matches, 'setDisconnected').mockImplementationOnce(async (...args) => {
        await realSet(...args);
        mock.patchRoom(code, (room) => {
          const p = room.players[1];
          p.connected = true;
          p.socketId = 'sock-new';
        });
      });
      await service.markDisconnected(code, B.socketId, T0);
      expect(mock.readMatch(matchId)?.slots[1].disconnectedAt).toBeNull();
    });

    it('채팅은 경기 중에도 전원 허용(D-004)', async () => {
      const { code } = await started();
      await expect(service.prepareChat(code, B.socketId, '좋은 한 발', T0)).resolves.toMatchObject({ playerId: 'p2', text: '좋은 한 발' });
    });

    it('강퇴는 경기 중 MATCH_ALREADY_STARTED · resync는 진행 중·직전 경기 스냅샷', async () => {
      const { code, matchId } = await started();
      await expectCode(service.kickPlayer(code, A.socketId, 'p2', T0), 'MATCH_ALREADY_STARTED');
      await expect(service.resync(code, A.socketId, { matchId }, T0)).resolves.toMatchObject({ matchId, turn: { seq: 0 } });
      await service.leaveRoom(code, B.socketId, T0);
      await expect(service.resync(code, A.socketId, { matchId }, T0)).resolves.toMatchObject({ matchId, turn: null });
      await expectCode(service.resync(code, A.socketId, { matchId: 'BBBBBBBBBBBBBBBB' }, T0), 'MATCH_NOT_FOUND');
    });

    it('rematch: 방장만, RESULT → WAITING, 전원 ready=false · 경기 중이면 MATCH_ALREADY_STARTED · WAITING이면 MATCH_NOT_FOUND', async () => {
      const { code } = await started([B, C]);
      await expectCode(service.rematch(code, A.socketId, T0), 'MATCH_ALREADY_STARTED');
      await service.leaveRoom(code, C.socketId, T0);
      await service.leaveRoom(code, B.socketId, T0);
      // 혼자 남아 경기 끝 → RESULT
      expect(mock.readRoom(code)?.status).toBe('RESULT');
      const again = await service.rematch(code, A.socketId, T0);
      expect(again.room).toMatchObject({ status: 'WAITING' });
      expect(mock.readRoom(code)?.match).toBeNull();
      await expectCode(service.rematch(code, A.socketId, T0), 'MATCH_NOT_FOUND');
    });

    it('경기는 끝났는데 방이 PLAYING으로 남았으면(반영 실패) rematch 앞에서 RESULT로 고친다', async () => {
      const { code, matchId } = await started();
      jest.spyOn(service, 'finishMatch').mockResolvedValueOnce(undefined); // 종료 반영 1번 실패
      await matches.resign(matchId, 'p2', 'leave', T0);
      expect(mock.readRoom(code)?.status).toBe('PLAYING');
      jest.restoreAllMocks();
      await expect(service.rematch(code, A.socketId, T0)).resolves.toMatchObject({ room: { status: 'WAITING' } });
    });
  });

  describe('리뷰 1차 — 경기 기록과 방이 어긋나는 경우의 회수', () => {
    const started = async (others: SocketIdentity[] = [B]) => {
      const code = await readyRoom({}, others);
      const { starting } = await service.startMatch(code, A.socketId, T0);
      return { code, matchId: starting.matchId, first: starting.turn.slot };
    };
    const resolved = () => broadcasts.filter((b) => b.event === 'turnResolved').map((b) => b.payload as TurnResolvedPayload);

    it('R1-1: 재연결의 끊김 해제가 실패해 기록이 남아도, 그 자리의 resync가 지워 30초 뒤 resign되지 않는다', async () => {
      const { code, matchId } = await started([B, C]);
      const b = await service.joinRoom({ code, playerName: '도전자1' }, B, T0);
      await service.markDisconnected(code, B.socketId, T0);
      const realSet = matches.setDisconnected.bind(matches);
      // 재연결 복원(recoverMatch)의 해제만 실패
      jest.spyOn(matches, 'setDisconnected').mockRejectedValueOnce(new Error('redis down')).mockImplementation(realSet);
      const back = await service.joinRoom({ code, playerName: '도전자1', playerToken: b.playerToken }, who(7), T0 + 1_000);
      expect(back.rejoin).toBeUndefined();
      expect(mock.readMatch(matchId)?.slots[1].disconnectedAt).toBe(T0);

      await service.resync(code, who(7).socketId, { matchId }, T0 + 2_000);
      expect(mock.readMatch(matchId)?.slots[1].disconnectedAt).toBeNull();
      await matches.processDue(matchId, T0 + MATCH_DISCONNECT_GRACE_MS + 1);
      expect(resolved().some((r) => r.cause === 'disconnect')).toBe(false);
    });

    it('R1-1: turnSubmit도 남은 끊김 기록을 지운다', async () => {
      const { code, matchId, first } = await started([B, C]);
      const owner = [A, B, C][first];
      await matches.setDisconnected(matchId, `p${first + 1}`, T0, T0); // 남은 기록(해제 실패 흉내)
      await service.turnSubmit(code, owner.socketId, { matchId, seq: 0, move: 0, angle: 45, power: 0, weaponId: 0 }, T0 + MATCH_START_DELAY_MS);
      expect(mock.readMatch(matchId)?.slots[first].disconnectedAt).toBeNull();
    });

    it('R1-2: 복원 중 경기가 끝나면 rejoin ack의 room은 RESULT(옛 PLAYING이 아니다)', async () => {
      const { code, matchId } = await started(); // A·B 2인
      const b = await service.joinRoom({ code, playerName: '도전자1' }, B, T0);
      await service.markDisconnected(code, A.socketId, T0); // A는 끊긴 채 유예를 넘긴다
      await service.markDisconnected(code, B.socketId, T0 + 1);
      const back = await service.joinRoom({ code, playerName: '도전자1', playerToken: b.playerToken }, who(7), T0 + MATCH_DISCONNECT_GRACE_MS);
      expect(resolved()).toEqual([expect.objectContaining({ action: { kind: 'resign', slot: 0 }, cause: 'disconnect', next: null })]);
      expect(back.rejoin?.match).toMatchObject({ matchId, turn: null });
      expect(back.room.status).toBe('RESULT');
    });

    it('R1-3: 경기 키가 사라지면(TTL·축출) rematch 앞 보정이 방을 RESULT로 옮겨 재대결할 수 있다', async () => {
      const { code, matchId } = await started();
      mock.hashes.delete(matchKey(matchId));
      await expect(service.rematch(code, A.socketId, T0)).resolves.toMatchObject({ room: { status: 'WAITING' } });
      expect(changes).toContainEqual({ code, status: 'RESULT' });
    });

    it('R1-4: 이탈 resign과 대비책이 둘 다 실패해도 정리 경로가 방에 없는 생존자를 resign(leave)한다', async () => {
      const { code, matchId } = await started(); // A·B 2인
      jest.spyOn(matches, 'resign').mockRejectedValueOnce(new Error('redis down'));
      jest.spyOn(matches, 'setDisconnected').mockRejectedValueOnce(new Error('redis down'));
      await service.leaveRoom(code, B.socketId, T0);
      expect(mock.readRoom(code)?.players.map((p) => p.playerId)).toEqual(['p1']);
      expect(mock.readMatch(matchId)?.state.tanks[1]?.alive).toBe(true);
      jest.restoreAllMocks();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.sweepExpired(code, T0 + 1_000);
      expect(resolved()).toEqual([expect.objectContaining({ action: { kind: 'resign', slot: 1 }, cause: 'leave', next: null })]);
      expect(mock.readRoom(code)?.status).toBe('RESULT');
      // 다시 불러도 한 번만(이미 탈락·경기 끝)
      await service.sweepExpired(code, T0 + 2_000);
      expect(resolved()).toHaveLength(1);
    });

    it(`R1-5: turnSubmit 빈도 제한 — 방·플레이어당 ${FORTRESS_RATE_LIMITS.turnSubmit.limit}번/${FORTRESS_RATE_LIMITS.turnSubmit.windowSec}초, 넘으면 RATE_LIMITED`, async () => {
      const { code, matchId } = await started();
      const late = { matchId, seq: 99, move: 0, angle: 45, power: 0, weaponId: 0 };
      for (let i = 0; i < FORTRESS_RATE_LIMITS.turnSubmit.limit; i++) {
        expect(await codeOf(service.turnSubmit(code, A.socketId, late, T0))).toBe('TURN_MISMATCH');
      }
      await expectCode(service.turnSubmit(code, A.socketId, late, T0), 'RATE_LIMITED');
      // 다른 플레이어는 따로 센다
      expect(await codeOf(service.turnSubmit(code, B.socketId, late, T0))).toBe('TURN_MISMATCH');
    });
  });

  describe('F7 탱크 스킨 — 서버가 계정 장착을 넣는다(클라이언트 값 없음)', () => {
    const DESERT = { id: 'desert', level: 3 };
    const NEON = { id: 'neon', level: 2 };
    const skinOf = (room: { players: { playerId: string; extra: { skin: unknown } }[] }, playerId: string) =>
      room.players.find((p) => p.playerId === playerId)?.extra.skin;

    it('생성·새 자리: 로그인은 게이트웨이가 읽은 장착, 게스트는 신원에 스킨이 있어도 default, 조회 실패(스킨 없음)는 default', async () => {
      const { room } = await service.createRoom({ name: '방', mode: 'ffa', mapId: 'hills', maxPlayers: 4, playerName: '방장' }, { ...A, skin: DESERT }, T0);
      expect(skinOf(room, 'p1')).toEqual(DESERT);
      const guest = await join(room.code, { ...B, skin: NEON }, '손님');
      expect(skinOf(guest.room, 'p2')).toEqual({ id: 'default', level: 1 });
      const failed = await join(room.code, who(3, 77), '조회실패');
      expect(skinOf(failed.room, 'p3')).toEqual({ id: 'default', level: 1 });
    });

    it('대기 중 같은 계정 재입장(다른 탭·같은 소켓)은 새 장착으로 바뀌고, 조회 실패면 이전 값 유지', async () => {
      const { room } = await service.createRoom({ name: '방', mode: 'ffa', mapId: 'hills', maxPlayers: 4, playerName: '방장' }, { ...A, skin: DESERT }, T0);
      const otherTab = await join(room.code, { ...who(9, 42), skin: NEON }, '방장');
      expect(skinOf(otherTab.room, 'p1')).toEqual(NEON);
      const failed = await join(room.code, who(9, 42), '방장');
      expect(skinOf(failed.room, 'p1')).toEqual(NEON);
    });

    it('토큰 재연결이 다른 계정이면 자리 주인 스킨을 바꾸지 않는다', async () => {
      const { room } = await service.createRoom({ name: '방', mode: 'ffa', mapId: 'hills', maxPlayers: 4, playerName: '방장' }, { ...A, skin: DESERT }, T0);
      const first = await join(room.code, { ...who(2, 50), skin: DESERT }, '둘');
      const again = await join(room.code, { ...who(3, 51), skin: NEON }, '셋', { playerToken: first.playerToken });
      expect(skinOf(again.room, first.playerId)).toEqual(DESERT);
    });

    it('경기 시작 때 경기 기록 slots·matchStarting.slots에 고정 · 경기 중 재연결은 스킨을 바꾸지 않는다', async () => {
      const { room } = await service.createRoom({ name: '방', mode: 'ffa', mapId: 'hills', maxPlayers: 4, playerName: '방장' }, { ...A, skin: DESERT }, T0);
      await join(room.code, B, '손님');
      await service.setReady(room.code, B.socketId, true, T0);
      const { starting } = await service.startMatch(room.code, A.socketId, T0);
      expect(starting.slots.map((s) => s.skin)).toEqual([DESERT, { id: 'default', level: 1 }]);
      expect(mock.readMatch(starting.matchId)?.slots.map((s) => s.skin)).toEqual([DESERT, { id: 'default', level: 1 }]);

      await service.markDisconnected(room.code, A.socketId, T0 + 1_000);
      const back = await join(room.code, { ...who(9, 42), skin: NEON }, '방장', {}, T0 + 2_000);
      expect(back.room.status).toBe('PLAYING');
      expect(skinOf(back.room, 'p1')).toEqual(DESERT);
    });

    it('경기 중 방을 나가 roomState에서 빠진 참가자도 resync 스냅샷 slots에 시작 때 스킨이 남는다', async () => {
      const { room } = await service.createRoom({ name: '방', mode: 'ffa', mapId: 'hills', maxPlayers: 4, playerName: '방장' }, A, T0);
      await join(room.code, { ...who(2, 50), skin: NEON }, '나갈사람');
      await join(room.code, C, '남는사람');
      await service.setReady(room.code, who(2, 50).socketId, true, T0);
      await service.setReady(room.code, C.socketId, true, T0);
      const { starting } = await service.startMatch(room.code, A.socketId, T0);

      const left = await service.leaveRoom(room.code, who(2, 50).socketId, T0 + 1_000);
      expect(left.room?.status).toBe('PLAYING');
      expect(left.room?.players.map((p) => p.playerId)).not.toContain('p2');
      const snap = await service.resync(room.code, C.socketId, { matchId: starting.matchId }, T0 + 1_000);
      expect(snap.slots.find((s) => s.playerId === 'p2')?.skin).toEqual(NEON);
    });

    it('F7 전에 저장된 방(skin 필드 없음)은 default로 내보낸다', async () => {
      const { room } = await create();
      const stored = mock.readRoom(room.code)!;
      delete stored.players[0].skin;
      expect(service.toRoomState(stored).players[0].extra.skin).toEqual({ id: 'default', level: 1 });
    });
  });

  it('Redis가 준비되지 않았으면 SERVICE_UNAVAILABLE', async () => {
    mock.state.status = 'connecting';
    await expectCode(create(), 'SERVICE_UNAVAILABLE');
  });
});

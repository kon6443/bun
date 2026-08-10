import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { getToken } from '@willsoto/nestjs-prometheus';
import { TeamGateway } from './team.gateway';
import { TeamService } from './team.service';
import { OnlineUserService } from './online-user.service';
import { TeamSocketEvents } from './team.events';
import { AuthenticatedSocket, WsJwtGuard } from '../../common/guards/ws-jwt-auth.guard';
import { createUser, createTeamMemberView } from '../../entities/__spec__/entity.factory';
import { Server } from 'socket.io';

const TEAM_ID = 7;
const USER_ID = 42;
const SOCKET_ID = 'socket-abc';
const ROOM = `team-${TEAM_ID}`;

/**
 * WebSocket 진입점. **HTTP와 완전히 별도 구현**이라 한쪽만 고치는 실수가 실제로 가능하다
 * (Phase A에서 JwtAuthGuard/WsJwtGuard가 둘로 나뉘어 있던 것과 같은 구조).
 *
 * 여기서 고정하는 것은 3가지다:
 *  1. **팀 격리** — room 참가 전에 멤버십을 검증하는가
 *  2. **채팅 권한의 출처** — 클라이언트가 보낸 teamId가 아니라 **서버가 캐싱한 teamId**를 쓰는가
 *  3. **중복 알림 방지** — 다중 탭·leave/disconnect 경합에서 입퇴장 알림이 두 번 나가지 않는가
 *
 * Socket.IO는 `client.to(room)`(본인 제외)와 `server.to(room)`(본인 포함)의 의미가 다르다.
 * 어느 쪽을 썼는지가 곧 계약이므로 두 emit 경로를 분리해 캡처한다.
 */
describe('TeamGateway', () => {
  let gateway: TeamGateway;
  let teamService: { verifyTeamMemberAccess: jest.Mock };
  let onlineUserService: {
    addUserToOnline: jest.Mock;
    removeSocket: jest.Mock;
    getUserOnlineInfo: jest.Mock;
    getOnlineUsersForTeam: jest.Mock;
    getOnlineUsersCount: jest.Mock;
    isSocketRegistered: jest.Mock;
    trackActiveTeam: jest.Mock;
  };
  let metrics: { inc: jest.Mock; dec: jest.Mock; startTimer: jest.Mock };
  let endTimer: jest.Mock;

  /** client.to(room).emit — 본인 제외 브로드캐스트 */
  let clientRoomEmit: jest.Mock;
  /** server.to(room).emit — 본인 포함 브로드캐스트 */
  let serverRoomEmit: jest.Mock;

  const createClient = (
    overrides: Partial<{ id: string; userId: number | null; teamId?: number }> = {},
  ) => {
    const { id = SOCKET_ID, userId = USER_ID, teamId } = overrides;
    return {
      id,
      data: {
        user: userId === null ? undefined : createUser({ userId, userName: '홍길동' }),
        teamId,
      },
      join: jest.fn(),
      leave: jest.fn(),
      emit: jest.fn(),
      to: jest.fn(() => ({ emit: clientRoomEmit })),
    } as unknown as AuthenticatedSocket & {
      join: jest.Mock;
      leave: jest.Mock;
      emit: jest.Mock;
      to: jest.Mock;
    };
  };

  beforeEach(async () => {
    teamService = { verifyTeamMemberAccess: jest.fn().mockResolvedValue(createTeamMemberView()) };
    onlineUserService = {
      addUserToOnline: jest.fn().mockResolvedValue({ wasAlreadyOnline: false }),
      removeSocket: jest.fn().mockResolvedValue(null),
      getUserOnlineInfo: jest.fn().mockResolvedValue(null),
      getOnlineUsersForTeam: jest.fn().mockResolvedValue([]),
      getOnlineUsersCount: jest.fn().mockResolvedValue(0),
      isSocketRegistered: jest.fn().mockResolvedValue(false),
      trackActiveTeam: jest.fn(),
    };
    endTimer = jest.fn();
    metrics = { inc: jest.fn(), dec: jest.fn(), startTimer: jest.fn(() => endTimer) };
    clientRoomEmit = jest.fn();
    serverRoomEmit = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamGateway,
        { provide: TeamService, useValue: teamService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: OnlineUserService, useValue: onlineUserService },
        { provide: getToken('ws_connections_active'), useValue: metrics },
        { provide: getToken('ws_events_total'), useValue: metrics },
        { provide: getToken('ws_event_duration_seconds'), useValue: metrics },
      ],
    })
      // 핸들러를 직접 호출하므로 가드는 실행되지 않지만, @UseGuards가 붙어 있어
      // Nest가 WsJwtGuard의 의존성(User Repository 등)까지 해석하려 한다.
      // 가드 자체는 ws-jwt-auth.guard.spec.ts에서 11케이스로 검증했다.
      .overrideGuard(WsJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    gateway = module.get(TeamGateway);
    gateway.server = {
      to: jest.fn(() => ({ emit: serverRoomEmit })),
      in: jest.fn(() => ({ fetchSockets: jest.fn().mockResolvedValue([]) })),
    } as unknown as Server;

    // 핸들러마다 log/debug/warn을 남기므로 테스트 출력이 묻힌다 (restoreMocks가 자동 복원)
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('handleJoinTeam — 팀 격리', () => {
    it('팀 멤버가 아니면 FORBIDDEN으로 차단하고 room에 넣지 않아야 함', async () => {
      teamService.verifyTeamMemberAccess.mockRejectedValue(new Error('not a member'));
      const client = createClient();

      await expect(gateway.handleJoinTeam(client, { teamId: TEAM_ID })).rejects.toThrow(
        WsException,
      );
      // room에 들어가면 이후 모든 팀 이벤트를 수신하게 된다 — 여기서 막는 것이 유일한 방어선
      expect(client.join).not.toHaveBeenCalled();
      expect(onlineUserService.addUserToOnline).not.toHaveBeenCalled();
    });

    it('차단 시 FORBIDDEN 코드를 담아야 함', async () => {
      teamService.verifyTeamMemberAccess.mockRejectedValue(new Error('not a member'));
      const client = createClient();

      await expect(gateway.handleJoinTeam(client, { teamId: TEAM_ID })).rejects.toMatchObject({
        error: { code: 'FORBIDDEN' },
      });
    });

    it('멤버십은 요청한 teamId와 소켓의 userId로 검증해야 함', async () => {
      const client = createClient();

      await gateway.handleJoinTeam(client, { teamId: TEAM_ID });

      expect(teamService.verifyTeamMemberAccess).toHaveBeenCalledWith(TEAM_ID, USER_ID);
    });

    it('멤버면 team-{teamId} room에 참가시켜야 함', async () => {
      const client = createClient();

      await expect(gateway.handleJoinTeam(client, { teamId: TEAM_ID })).resolves.toEqual({
        teamId: TEAM_ID,
        room: ROOM,
      });
      expect(client.join).toHaveBeenCalledWith(ROOM);
    });

    it('teamId를 소켓에 캐싱해야 함 (이후 채팅 권한의 근거)', async () => {
      const client = createClient();

      await gateway.handleJoinTeam(client, { teamId: TEAM_ID });

      expect(client.data.teamId).toBe(TEAM_ID);
    });

    it('인증 정보가 없으면 멤버십 검증 없이 참가한다 (현재 계약 — WsJwtGuard가 앞단에서 막는다)', async () => {
      const client = createClient({ userId: null });

      await gateway.handleJoinTeam(client, { teamId: TEAM_ID });

      // 이 경로는 가드가 없을 때만 도달 가능하다. 가드를 떼거나 우회하면 팀 격리가 사라진다는 뜻이므로
      // 동작을 명시적으로 고정해 둔다 — 정책을 바꾸면 이 테스트가 먼저 깨진다
      expect(teamService.verifyTeamMemberAccess).not.toHaveBeenCalled();
      expect(client.join).toHaveBeenCalledWith(ROOM);
      expect(onlineUserService.addUserToOnline).not.toHaveBeenCalled();
    });
  });

  describe('handleJoinTeam — 온라인 상태와 입장 알림', () => {
    beforeEach(() => {
      onlineUserService.getUserOnlineInfo.mockResolvedValue({
        userId: USER_ID,
        userName: '홍길동',
        connectionCount: 1,
      });
      onlineUserService.getOnlineUsersForTeam.mockResolvedValue([
        { userId: USER_ID, userName: '홍길동', connectionCount: 1 },
      ]);
    });

    it('첫 접속이면 본인을 제외한 팀원에게 입장을 알려야 함', async () => {
      onlineUserService.addUserToOnline.mockResolvedValue({ wasAlreadyOnline: false });
      const client = createClient();

      await gateway.handleJoinTeam(client, { teamId: TEAM_ID });

      // server.to가 아니라 client.to — 본인에게 자기 입장 알림이 가면 안 된다
      expect(client.to).toHaveBeenCalledWith(ROOM);
      expect(clientRoomEmit).toHaveBeenCalledWith(TeamSocketEvents.USER_JOINED, {
        teamId: TEAM_ID,
        userId: USER_ID,
        userName: '홍길동',
        connectionCount: 1,
        totalOnlineCount: 1,
      });
    });

    it('이미 온라인이면 입장 알림을 보내지 않아야 함 (다중 탭 중복 방지)', async () => {
      onlineUserService.addUserToOnline.mockResolvedValue({ wasAlreadyOnline: true });
      const client = createClient();

      await gateway.handleJoinTeam(client, { teamId: TEAM_ID });

      expect(clientRoomEmit).not.toHaveBeenCalledWith(
        TeamSocketEvents.USER_JOINED,
        expect.anything(),
      );
    });

    it.each([
      ['첫 접속', false],
      ['이미 온라인', true],
    ])('%s이어도 본인에게는 항상 온라인 목록을 보내야 함', async (_desc, wasAlreadyOnline) => {
      onlineUserService.addUserToOnline.mockResolvedValue({ wasAlreadyOnline });
      const client = createClient();

      await gateway.handleJoinTeam(client, { teamId: TEAM_ID });

      // 새 탭도 현재 접속자를 그려야 하므로 목록은 조건 없이 전송된다
      expect(client.emit).toHaveBeenCalledWith(TeamSocketEvents.ONLINE_USERS, {
        teamId: TEAM_ID,
        users: [{ userId: USER_ID, userName: '홍길동', connectionCount: 1 }],
        totalCount: 1,
      });
    });

    it('온라인 정보 조회에 실패하면 아무 알림도 보내지 않아야 함', async () => {
      onlineUserService.getUserOnlineInfo.mockResolvedValue(null);
      const client = createClient();

      await expect(gateway.handleJoinTeam(client, { teamId: TEAM_ID })).resolves.toEqual({
        teamId: TEAM_ID,
        room: ROOM,
      });
      expect(client.emit).not.toHaveBeenCalled();
      expect(clientRoomEmit).not.toHaveBeenCalled();
    });

    it('이름이 없는 사용자는 기본 표시명으로 등록해야 함', async () => {
      const client = createClient();
      client.data.user = createUser({ userId: USER_ID, userName: null });

      await gateway.handleJoinTeam(client, { teamId: TEAM_ID });

      expect(onlineUserService.addUserToOnline).toHaveBeenCalledWith(
        TEAM_ID,
        USER_ID,
        `사용자${USER_ID}`,
        SOCKET_ID,
      );
    });

    it('팀별 온라인 게이지 갱신 대상에 등록해야 함', async () => {
      const client = createClient();

      await gateway.handleJoinTeam(client, { teamId: TEAM_ID });

      expect(onlineUserService.trackActiveTeam).toHaveBeenCalledWith(TEAM_ID);
    });
  });

  describe('handleLeaveTeam', () => {
    it('이미 disconnect로 정리된 소켓이면 다시 제거하지 않아야 함', async () => {
      onlineUserService.isSocketRegistered.mockResolvedValue(false);
      const client = createClient({ teamId: TEAM_ID });

      await gateway.handleLeaveTeam(client, { teamId: TEAM_ID });

      // 중복 호출하면 퇴장 알림이 두 번 나간다
      expect(onlineUserService.removeSocket).not.toHaveBeenCalled();
      expect(serverRoomEmit).not.toHaveBeenCalled();
    });

    it('마지막 연결이 끊기면 팀 전체에 퇴장을 알려야 함', async () => {
      onlineUserService.isSocketRegistered.mockResolvedValue(true);
      onlineUserService.removeSocket.mockResolvedValue({
        teamId: TEAM_ID,
        userId: USER_ID,
        userName: '홍길동',
        isFullyOffline: true,
      });
      onlineUserService.getUserOnlineInfo.mockResolvedValue(null);
      onlineUserService.getOnlineUsersForTeam.mockResolvedValue([]);
      const client = createClient({ teamId: TEAM_ID });

      await gateway.handleLeaveTeam(client, { teamId: TEAM_ID });

      expect(gateway.server.to).toHaveBeenCalledWith(ROOM);
      expect(serverRoomEmit).toHaveBeenCalledWith(TeamSocketEvents.USER_LEFT, {
        teamId: TEAM_ID,
        userId: USER_ID,
        userName: '홍길동',
        connectionCount: 0,
        totalOnlineCount: 0,
      });
    });

    it('다른 탭이 남아 있으면 퇴장을 알리지 않아야 함', async () => {
      onlineUserService.isSocketRegistered.mockResolvedValue(true);
      onlineUserService.removeSocket.mockResolvedValue({
        teamId: TEAM_ID,
        userId: USER_ID,
        userName: '홍길동',
        isFullyOffline: false,
      });
      const client = createClient({ teamId: TEAM_ID });

      await gateway.handleLeaveTeam(client, { teamId: TEAM_ID });

      expect(serverRoomEmit).not.toHaveBeenCalled();
    });

    it('제거 직후 재접속했으면 퇴장을 알리지 않아야 함 (경합 방어)', async () => {
      onlineUserService.isSocketRegistered.mockResolvedValue(true);
      onlineUserService.removeSocket.mockResolvedValue({
        teamId: TEAM_ID,
        userId: USER_ID,
        userName: '홍길동',
        isFullyOffline: true,
      });
      // removeSocket과 브로드캐스트 사이에 다른 소켓이 붙은 상황
      onlineUserService.getUserOnlineInfo.mockResolvedValue({
        userId: USER_ID,
        userName: '홍길동',
        connectionCount: 1,
      });
      const client = createClient({ teamId: TEAM_ID });

      await gateway.handleLeaveTeam(client, { teamId: TEAM_ID });

      expect(serverRoomEmit).not.toHaveBeenCalled();
    });

    it('room에서 나가고 결과를 반환해야 함', async () => {
      const client = createClient({ teamId: TEAM_ID });

      await expect(gateway.handleLeaveTeam(client, { teamId: TEAM_ID })).resolves.toEqual({
        teamId: TEAM_ID,
        room: ROOM,
      });
      expect(client.leave).toHaveBeenCalledWith(ROOM);
    });

    it('나간 팀의 teamId 캐시를 지워야 함 (퇴장 후 채팅 차단)', async () => {
      const client = createClient({ teamId: TEAM_ID });

      await gateway.handleLeaveTeam(client, { teamId: TEAM_ID });

      expect(client.data.teamId).toBeUndefined();
    });

    it('다른 팀에서 나가는 경우 현재 팀 캐시는 유지해야 함', async () => {
      const client = createClient({ teamId: TEAM_ID });

      await gateway.handleLeaveTeam(client, { teamId: 999 });

      // 지워버리면 참가 중인 팀의 채팅이 CHAT_NOT_JOINED로 끊긴다
      expect(client.data.teamId).toBe(TEAM_ID);
    });
  });

  describe('handleChatMessage', () => {
    const dto = { message: '안녕하세요', clientMsgId: 'msg-1' };

    it.each([
      ['팀에 참가하지 않은 소켓', { teamId: undefined, userId: USER_ID }],
      ['인증 정보가 없는 소켓', { teamId: TEAM_ID, userId: null }],
    ])('%s은 CHAT_NOT_JOINED로 거부해야 함', async (_desc, opts) => {
      const client = createClient(opts as { teamId?: number; userId: number | null });

      await expect(gateway.handleChatMessage(client, dto)).rejects.toMatchObject({
        error: { code: 'CHAT_NOT_JOINED' },
      });
      expect(serverRoomEmit).not.toHaveBeenCalled();
    });

    it('캐싱된 teamId의 room으로만 브로드캐스트해야 함', async () => {
      const client = createClient({ teamId: TEAM_ID });

      await gateway.handleChatMessage(client, dto);

      // DTO에 teamId가 없는 것이 설계다 — 클라이언트가 room을 지정할 수 없어야 한다
      expect(gateway.server.to).toHaveBeenCalledWith(ROOM);
    });

    it('본인을 포함해 브로드캐스트하고 서버 시각을 찍어야 함', async () => {
      const client = createClient({ teamId: TEAM_ID });
      const before = Date.now();

      await gateway.handleChatMessage(client, dto);

      const [event, payload] = serverRoomEmit.mock.calls[0] as [
        string,
        { messageId: string; timestamp: string; userName: string; message: string; userId: number },
      ];
      expect(event).toBe(TeamSocketEvents.CHAT_RECEIVED);
      expect(payload).toMatchObject({
        messageId: 'msg-1',
        teamId: TEAM_ID,
        userId: USER_ID,
        userName: '홍길동',
        message: '안녕하세요',
      });
      // 클라이언트 시계를 믿지 않는다 — 실행 시간 오차를 감안해 ±5초 이내인지 확인
      expect(Math.abs(new Date(payload.timestamp).getTime() - before)).toBeLessThan(5_000);
    });

    it('이름이 없는 사용자는 기본 표시명으로 보내야 함', async () => {
      const client = createClient({ teamId: TEAM_ID });
      client.data.user = createUser({ userId: USER_ID, userName: null });

      await gateway.handleChatMessage(client, dto);

      const [, payload] = serverRoomEmit.mock.calls[0] as [string, { userName: string }];
      expect(payload.userName).toBe(`사용자${USER_ID}`);
    });
  });

  describe('연결 라이프사이클', () => {
    it('연결되면 활성 커넥션 수를 늘려야 함', () => {
      gateway.handleConnection(createClient());

      expect(metrics.inc).toHaveBeenCalled();
    });

    it('연결이 끊기면 활성 커넥션 수를 줄이고 온라인에서 제거해야 함', async () => {
      await gateway.handleDisconnect(createClient());

      expect(metrics.dec).toHaveBeenCalled();
      expect(onlineUserService.removeSocket).toHaveBeenCalledWith(SOCKET_ID);
    });

    it('등록되지 않은 소켓이면 퇴장 알림을 보내지 않아야 함', async () => {
      onlineUserService.removeSocket.mockResolvedValue(null);

      await gateway.handleDisconnect(createClient());

      expect(serverRoomEmit).not.toHaveBeenCalled();
    });

    it('마지막 연결이었으면 퇴장을 알려야 함', async () => {
      onlineUserService.removeSocket.mockResolvedValue({
        teamId: TEAM_ID,
        userId: USER_ID,
        userName: '홍길동',
        isFullyOffline: true,
      });
      onlineUserService.getUserOnlineInfo.mockResolvedValue(null);
      onlineUserService.getOnlineUsersForTeam.mockResolvedValue([]);

      await gateway.handleDisconnect(createClient());

      expect(serverRoomEmit).toHaveBeenCalledWith(
        TeamSocketEvents.USER_LEFT,
        expect.objectContaining({ teamId: TEAM_ID, userId: USER_ID }),
      );
    });

    it('다른 탭이 남아 있으면 퇴장을 알리지 않아야 함', async () => {
      onlineUserService.removeSocket.mockResolvedValue({
        teamId: TEAM_ID,
        userId: USER_ID,
        userName: '홍길동',
        isFullyOffline: false,
      });

      await gateway.handleDisconnect(createClient());

      expect(serverRoomEmit).not.toHaveBeenCalled();
    });
  });

  describe('서버 → 클라이언트 브로드캐스트', () => {
    /**
     * 이벤트명은 프론트의 리스너 등록명과 문자열로 맞물려 있다.
     * 오타가 나면 예외 없이 "알림이 안 오는" 침묵 실패가 되므로 전수 고정한다.
     */
    it.each([
      ['emitTaskCreated', TeamSocketEvents.TASK_CREATED],
      ['emitTaskUpdated', TeamSocketEvents.TASK_UPDATED],
      ['emitTaskStatusChanged', TeamSocketEvents.TASK_STATUS_CHANGED],
      ['emitTaskActiveStatusChanged', TeamSocketEvents.TASK_ACTIVE_STATUS_CHANGED],
      ['emitTaskDeleted', TeamSocketEvents.TASK_DELETED],
      ['emitCommentCreated', TeamSocketEvents.COMMENT_CREATED],
      ['emitCommentUpdated', TeamSocketEvents.COMMENT_UPDATED],
      ['emitCommentDeleted', TeamSocketEvents.COMMENT_DELETED],
      ['emitMemberRoleChanged', TeamSocketEvents.MEMBER_ROLE_CHANGED],
      ['emitMemberStatusChanged', TeamSocketEvents.MEMBER_STATUS_CHANGED],
    ])('%s는 팀 room에 %s 이벤트를 보내야 함', (method, event) => {
      const payload = { taskId: 1, teamId: TEAM_ID, userId: USER_ID, commentId: 1 };

      (gateway as unknown as Record<string, (t: number, p: unknown) => void>)[method](
        TEAM_ID,
        payload,
      );

      expect(gateway.server.to).toHaveBeenCalledWith(ROOM);
      expect(serverRoomEmit).toHaveBeenCalledWith(event, payload);
    });
  });

  describe('조회 위임', () => {
    it('room의 접속 소켓 수를 세어야 함', async () => {
      const fetchSockets = jest.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      gateway.server.in = jest.fn(() => ({ fetchSockets })) as unknown as Server['in'];

      await expect(gateway.getConnectedClientsCount(TEAM_ID)).resolves.toBe(2);
      expect(gateway.server.in).toHaveBeenCalledWith(ROOM);
    });

    it('온라인 유저 수는 OnlineUserService에 위임해야 함', async () => {
      onlineUserService.getOnlineUsersCount.mockResolvedValue(5);

      await expect(gateway.getOnlineUsersCount(TEAM_ID)).resolves.toBe(5);
      expect(onlineUserService.getOnlineUsersCount).toHaveBeenCalledWith(TEAM_ID);
    });
  });

  describe('메트릭', () => {
    it.each([
      ['handleJoinTeam', () => gateway.handleJoinTeam(createClient(), { teamId: TEAM_ID })],
      ['handleLeaveTeam', () => gateway.handleLeaveTeam(createClient({ teamId: TEAM_ID }), { teamId: TEAM_ID })],
      [
        'handleChatMessage',
        () =>
          gateway.handleChatMessage(createClient({ teamId: TEAM_ID }), {
            message: 'hi',
            clientMsgId: 'm1',
          }),
      ],
    ])('%s는 이벤트 수와 처리 시간을 기록해야 함', async (_name, run) => {
      await run();

      expect(metrics.inc).toHaveBeenCalled();
      expect(endTimer).toHaveBeenCalled();
    });

    it('핸들러가 실패해도 타이머를 종료해야 함 (finally)', async () => {
      teamService.verifyTeamMemberAccess.mockRejectedValue(new Error('not a member'));

      await expect(
        gateway.handleJoinTeam(createClient(), { teamId: TEAM_ID }),
      ).rejects.toThrow(WsException);

      // 종료하지 않으면 히스토그램에 미완료 관측이 쌓여 지표가 왜곡된다
      expect(endTimer).toHaveBeenCalled();
    });
  });
});

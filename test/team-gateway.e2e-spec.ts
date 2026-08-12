import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { getToken } from '@willsoto/nestjs-prometheus';
import { sign } from 'jsonwebtoken';
import { Socket } from 'socket.io-client';
import { TeamGateway } from '../src/modules/team/team.gateway';
import { TeamService } from '../src/modules/team/team.service';
import { OnlineUserService } from '../src/modules/team/online-user.service';
import { TeamSocketEvents } from '../src/modules/team/team.events';
import { User } from '../src/entities/User';
import { createUser, createTeamMemberView } from '../src/entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import {
  createWsApp,
  WsE2eApp,
  waitFor,
  expectNoEvent,
  emitWithAck,
} from './helpers/ws-e2e-app';

const JWT_SECRET = 'e2e-ws-secret';
const TEAM_ID = 7;
const OTHER_TEAM_ID = 99;
const USER_A = createUser({ userId: 42, userName: '유저A' });
const USER_B = createUser({ userId: 43, userName: '유저B' });

const tokenFor = (user: User) =>
  sign({ sub: user.userId, loginType: 'KAKAO' }, JWT_SECRET, { expiresIn: '1h' });

/**
 * 실제 소켓으로 붙어 `/teams` 게이트웨이를 검증한다.
 *
 * 단위 테스트(46케이스)는 핸들러를 직접 호출하므로 **"어느 emit 메서드를 불렀나"** 까지만 안다.
 * 여기서만 확인되는 것이 둘 있다:
 *
 *  1. **인증이 실제 소켓 위에서 동작하는가** — `WsJwtGuard`가 핸드셰이크의 `auth.token`을
 *     읽어 검증하고, 실패 시 `WsExceptionFilter`가 표준 포맷으로 `error`를 보내는 전 과정.
 *     세션에서 고친 `joinTeam` 인증 차단이 수동 검증 대기로 남아 있던 마지막 항목이다.
 *  2. **room 격리** — 팀 A의 브로드캐스트가 팀 B 소켓에 **도달하지 않는지**.
 *     mock은 `to(room)` 호출만 확인할 뿐 실제 전달 여부를 모르므로 단위 테스트로는
 *     원리적으로 검증할 수 없다.
 */
describe('E2E WS 팀 게이트웨이', () => {
  let ws: WsE2eApp;
  let teamService: { verifyTeamMemberAccess: jest.Mock; getTeamMembersBy: jest.Mock };
  let onlineUserService: Record<string, jest.Mock>;
  let userRepository: MockRepository<User>;

  beforeEach(async () => {
    userRepository = createMockRepository<User>();
    // 가드가 토큰의 sub로 활성 유저를 조회한다
    userRepository.findOne.mockImplementation(async (options) => {
      const where = (options as { where: { userId: number } }).where;
      return [USER_A, USER_B].find((u) => u.userId === where.userId) ?? null;
    });

    teamService = {
      verifyTeamMemberAccess: jest.fn().mockResolvedValue(createTeamMemberView()),
      getTeamMembersBy: jest.fn().mockResolvedValue([createTeamMemberView()]),
    };
    onlineUserService = {
      addUserToOnline: jest.fn().mockResolvedValue({ wasAlreadyOnline: false }),
      removeSocket: jest.fn().mockResolvedValue(null),
      getUserOnlineInfo: jest.fn().mockResolvedValue({
        userId: USER_A.userId,
        userName: '유저A',
        connectionCount: 1,
      }),
      getOnlineUsersForTeam: jest.fn().mockResolvedValue([]),
      getOnlineUsersCount: jest.fn().mockResolvedValue(0),
      isSocketRegistered: jest.fn().mockResolvedValue(false),
      trackActiveTeam: jest.fn(),
    };

    const metric = { inc: jest.fn(), dec: jest.fn(), startTimer: jest.fn(() => jest.fn()) };

    ws = await createWsApp({
      gateways: [TeamGateway],
      providers: [
        { provide: TeamService, useValue: teamService },
        { provide: OnlineUserService, useValue: onlineUserService },
        { provide: getRepositoryToken(User), useValue: userRepository },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((k: string) => (k === 'JWT_SECRET' ? JWT_SECRET : undefined)) },
        },
        { provide: getToken('ws_connections_active'), useValue: metric },
        { provide: getToken('ws_events_total'), useValue: metric },
        { provide: getToken('ws_event_duration_seconds'), useValue: metric },
      ],
    });
  });

  afterEach(async () => {
    await ws.close();
  });

  describe('인증 (WsJwtGuard on socket)', () => {
    it('토큰 없이도 연결은 되지만 joinTeam은 거부돼야 함', async () => {
      const socket = await ws.connect();

      // NestJS의 WS 가드는 연결이 아니라 메시지 핸들러에 걸린다 —
      // 연결 자체는 열리므로 "붙었으니 인증됐다"고 착각하면 안 된다
      expect(socket.connected).toBe(true);

      socket.emit(TeamSocketEvents.JOIN_TEAM, { teamId: TEAM_ID });
      const err = await waitFor<{ code: string }>(socket, TeamSocketEvents.ERROR);

      expect(err.code).toBe('AUTH_UNAUTHORIZED');
      expect(teamService.verifyTeamMemberAccess).not.toHaveBeenCalled();
    });

    it('위조된 토큰이면 거부해야 함', async () => {
      const socket = await ws.connect({ token: 'forged.token.value' });

      socket.emit(TeamSocketEvents.JOIN_TEAM, { teamId: TEAM_ID });
      const err = await waitFor<{ code: string }>(socket, TeamSocketEvents.ERROR);

      expect(err.code).toMatch(/AUTH_/);
    });

    it('에러는 표준 포맷으로 나가야 함 (WsExceptionFilter)', async () => {
      const socket = await ws.connect();

      socket.emit(TeamSocketEvents.JOIN_TEAM, { teamId: TEAM_ID });
      const err = await waitFor<Record<string, unknown>>(socket, TeamSocketEvents.ERROR);

      expect(err).toMatchObject({
        code: expect.any(String),
        message: expect.any(String),
        timestamp: expect.any(String),
      });
    });

    it('유효한 토큰이면 팀에 참가할 수 있어야 함', async () => {
      const socket = await ws.connect({ token: tokenFor(USER_A) });

      const ack = await emitWithAck<{ teamId: number; room: string }>(
        socket,
        TeamSocketEvents.JOIN_TEAM,
        { teamId: TEAM_ID },
      );

      expect(ack).toEqual({ teamId: TEAM_ID, room: `team-${TEAM_ID}` });
      expect(teamService.verifyTeamMemberAccess).toHaveBeenCalledWith(TEAM_ID, USER_A.userId);
    });

    it('팀 멤버가 아니면 FORBIDDEN으로 거부해야 함', async () => {
      teamService.verifyTeamMemberAccess.mockRejectedValue(new Error('not a member'));
      const socket = await ws.connect({ token: tokenFor(USER_A) });

      socket.emit(TeamSocketEvents.JOIN_TEAM, { teamId: TEAM_ID });
      const err = await waitFor<{ code: string }>(socket, TeamSocketEvents.ERROR);

      expect(err.code).toBe('FORBIDDEN');
      expect(onlineUserService.addUserToOnline).not.toHaveBeenCalled();
    });
  });

  describe('채팅 — 참가 여부에 따른 분기', () => {
    it('팀에 참가하지 않고 채팅하면 CHAT_NOT_JOINED여야 함', async () => {
      const socket = await ws.connect({ token: tokenFor(USER_A) });

      socket.emit(TeamSocketEvents.CHAT_MESSAGE, { message: '안녕', clientMsgId: 'm1' });
      const err = await waitFor<{ code: string }>(socket, TeamSocketEvents.ERROR);

      expect(err.code).toBe('CHAT_NOT_JOINED');
    });

    it('참가 후에는 본인에게도 메시지가 도착해야 함', async () => {
      const socket = await ws.connect({ token: tokenFor(USER_A) });
      await emitWithAck(socket, TeamSocketEvents.JOIN_TEAM, { teamId: TEAM_ID });

      const received = waitFor<{ message: string; userId: number }>(
        socket,
        TeamSocketEvents.CHAT_RECEIVED,
      );
      socket.emit(TeamSocketEvents.CHAT_MESSAGE, { message: '안녕', clientMsgId: 'm1' });

      // 채팅만 server.to(본인 포함)를 쓴다 — 자기 말풍선이 자기 화면에 떠야 하기 때문
      await expect(received).resolves.toMatchObject({
        message: '안녕',
        userId: USER_A.userId,
      });
    });
  });

  /**
   * 여기가 단위 테스트로는 원리적으로 못 하는 영역이다.
   * mock은 `server.to(room)`이 호출됐다는 것만 알 뿐, **누구에게 도달했는지**는 모른다.
   */
  describe('room 격리 (실제 전달 검증)', () => {
    const joinBoth = async () => {
      const a = await ws.connect({ token: tokenFor(USER_A) });
      const b = await ws.connect({ token: tokenFor(USER_B) });
      await emitWithAck(a, TeamSocketEvents.JOIN_TEAM, { teamId: TEAM_ID });
      await emitWithAck(b, TeamSocketEvents.JOIN_TEAM, { teamId: OTHER_TEAM_ID });
      return { a, b };
    };

    it('같은 팀 소켓에는 브로드캐스트가 도달해야 함', async () => {
      const socket = await ws.connect({ token: tokenFor(USER_A) });
      await emitWithAck(socket, TeamSocketEvents.JOIN_TEAM, { teamId: TEAM_ID });

      const received = waitFor<{ taskId: number }>(socket, TeamSocketEvents.TASK_CREATED);
      ws.moduleRef.get(TeamGateway).emitTaskCreated(TEAM_ID, { taskId: 1 } as never);

      await expect(received).resolves.toMatchObject({ taskId: 1 });
    });

    it('다른 팀 소켓에는 도달하지 않아야 함', async () => {
      const { b } = await joinBoth();

      ws.moduleRef.get(TeamGateway).emitTaskCreated(TEAM_ID, { taskId: 1 } as never);

      // 도달하면 팀 격리가 무너진 것 — 남의 팀 태스크 제목이 그대로 보인다
      await expectNoEvent(b, TeamSocketEvents.TASK_CREATED);
    });

    it('채팅도 다른 팀에는 새지 않아야 함', async () => {
      const { a, b } = await joinBoth();

      a.emit(TeamSocketEvents.CHAT_MESSAGE, { message: '기밀', clientMsgId: 'm1' });

      await expectNoEvent(b, TeamSocketEvents.CHAT_RECEIVED);
    });
  });

  describe('퇴장', () => {
    it('leaveTeam 후에는 채팅이 다시 차단돼야 함', async () => {
      const socket = await ws.connect({ token: tokenFor(USER_A) });
      await emitWithAck(socket, TeamSocketEvents.JOIN_TEAM, { teamId: TEAM_ID });
      await emitWithAck(socket, TeamSocketEvents.LEAVE_TEAM, { teamId: TEAM_ID });

      socket.emit(TeamSocketEvents.CHAT_MESSAGE, { message: '퇴장 후', clientMsgId: 'm2' });
      const err = await waitFor<{ code: string }>(socket, TeamSocketEvents.ERROR);

      // 캐싱된 teamId를 지우지 않으면 나간 팀의 채팅이 계속 나간다
      expect(err.code).toBe('CHAT_NOT_JOINED');
    });

    it('연결이 끊기면 온라인 목록에서 제거해야 함', async () => {
      const socket = await ws.connect({ token: tokenFor(USER_A) });
      await emitWithAck(socket, TeamSocketEvents.JOIN_TEAM, { teamId: TEAM_ID });

      socket.disconnect();
      await new Promise((r) => setTimeout(r, 300));

      expect(onlineUserService.removeSocket).toHaveBeenCalled();
    });
  });
});

import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { sign } from 'jsonwebtoken';
import { TeamController } from '../src/modules/team/team.controller';
import { TeamService, TeamMemberType } from '../src/modules/team/team.service';
import { TeamGateway } from '../src/modules/team/team.gateway';
import { TelegramService } from '../src/modules/notification/telegram.service';
import { DiscordService } from '../src/modules/notification/discord.service';
import { NOTIFICATION_PORT } from '../src/common/port/notification.port';
import { Team } from '../src/entities/Team';
import { TeamMember } from '../src/entities/TeamMember';
import { TeamTask } from '../src/entities/TeamTask';
import { TaskComment } from '../src/entities/TaskComment';
import { TeamInvitation } from '../src/entities/TeamInvitation';
import { User } from '../src/entities/User';
import { createUser } from '../src/entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

const JWT_SECRET = 'e2e-test-secret';
const TEAM_ID = 7;
const ACTOR = createUser({ userId: 42, userName: '요청자' });

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000);

/**
 * 초대·연동 플로우를 HTTP 경계에서 검증한다. 두 가지가 여기서만 확인된다.
 *
 * **1. `OptionalJwtAuthGuard`의 3분기** — 초대 수락은 비회원도 호출할 수 있는 유일한
 * 팀 API다. 토큰 없음(익명 통과 → 서비스가 401), 유효한 토큰(가입 처리),
 * **잘못된 토큰(익명이 아니라 차단)** 이 각각 다르게 동작해야 한다. 세 번째가 핵심이다 —
 * 잘못된 토큰을 익명으로 취급하면 만료된 세션이 조용히 비회원으로 격하된다.
 *
 * **2. 컨트롤러에만 있는 권한 로직** — `requireManagerAccess`는 서비스가 아니라
 * `TeamController`의 private 메서드다(텔레그램·디스코드 연동 4곳에서 사용).
 * 서비스 단위 테스트로는 절대 덮이지 않는 영역이라 E2E가 유일한 검증 수단이다.
 */
describe('E2E 초대·연동 (권한 경계)', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let teamService: TeamService;
  let telegramService: { generateLinkToken: jest.Mock };
  let userRepository: MockRepository<User>;

  const buildApp = async (authUser?: User) => {
    userRepository = createMockRepository<User>();
    telegramService = { generateLinkToken: jest.fn() };

    e2e = await createE2eApp({
      controllers: [TeamController],
      authUser,
      providers: [
        TeamService,
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } as unknown as DataSource },
        { provide: getRepositoryToken(Team), useValue: createMockRepository<Team>() },
        { provide: getRepositoryToken(TeamMember), useValue: createMockRepository<TeamMember>() },
        { provide: getRepositoryToken(TeamTask), useValue: createMockRepository<TeamTask>() },
        { provide: getRepositoryToken(TaskComment), useValue: createMockRepository<TaskComment>() },
        { provide: getRepositoryToken(TeamInvitation), useValue: createMockRepository<TeamInvitation>() },
        { provide: getRepositoryToken(User), useValue: userRepository },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) =>
              k === 'JWT_SECRET' ? JWT_SECRET : k === 'NEXT_PUBLIC_DOMAIN' ? 'https://app.test' : undefined,
            ),
          },
        },
        { provide: NOTIFICATION_PORT, useValue: { notifyTeam: jest.fn() } },
        { provide: TelegramService, useValue: telegramService },
        { provide: DiscordService, useValue: {} },
        { provide: TeamGateway, useValue: {} },
      ],
    });
    app = e2e.app;
    teamService = e2e.moduleRef.get(TeamService);
  };

  afterEach(async () => {
    await app.close();
  });

  /** 요청자의 팀 내 역할을 고정한다. null이면 멤버가 아님 */
  const mockRole = (role: string | null) =>
    jest.spyOn(teamService, 'getTeamMembersBy').mockResolvedValue(
      role === null
        ? []
        : ([
            {
              teamId: TEAM_ID,
              teamName: '테스트팀',
              teamDescription: null,
              crtdAt: new Date(),
              actStatus: 1,
              leaderId: 1,
              telegramChatId: null,
              discordWebhookUrl: null,
              userId: ACTOR.userId,
              joinedAt: new Date(),
              role,
              userActStatus: 1,
            },
          ] as TeamMemberType[]),
    );

  describe('초대 생성 — 서비스 권한', () => {
    beforeEach(() => buildApp(ACTOR));

    it.each([
      ['MASTER', 'MASTER', 201],
      ['MANAGER', 'MANAGER', 201],
      ['MEMBER', 'MEMBER', 403],
    ])('%s의 초대 생성은 %s → %d', async (_desc, role, expected) => {
      mockRole(role);
      const inviteRepo = e2e.moduleRef.get<MockRepository<TeamInvitation>>(
        getRepositoryToken(TeamInvitation),
      );
      inviteRepo.create.mockImplementation((d) => d as TeamInvitation);
      inviteRepo.save.mockResolvedValue({} as TeamInvitation);

      const res = await request(app.getHttpServer())
        .post(e2e.url(`/teams/${TEAM_ID}/invites`))
        .send({ endAt: hoursFromNow(24).toISOString(), usageMaxCnt: 1 });

      expect(res.status).toBe(expected);
      if (expected === 201) {
        expect(res.body.data).toHaveProperty('inviteLink');
      } else {
        expect(res.body).toMatchObject({ code: 'TEAM_INVITE_FORBIDDEN' });
      }
    });

    it('만료가 7일을 넘으면 거부해야 함', async () => {
      mockRole('MASTER');

      const res = await request(app.getHttpServer())
        .post(e2e.url(`/teams/${TEAM_ID}/invites`))
        .send({ endAt: hoursFromNow(24 * 8).toISOString(), usageMaxCnt: 1 });

      expect(res.status).toBe(400);
    });
  });

  /**
   * 초대 수락은 `OptionalJwtAuthGuard`를 쓴다 — 헬퍼가 override하는 `JwtAuthGuard`와
   * 다른 가드라 **실제 가드가 그대로 동작한다.** 덕분에 인증 3분기를 진짜로 태울 수 있다.
   */
  describe('초대 수락 — OptionalJwtAuthGuard 3분기', () => {
    const TOKEN = 'invite-token';

    beforeEach(() => buildApp(ACTOR));

    it('토큰 없이 수락하면 회원가입이 필요하다고 알려야 함', async () => {
      const res = await request(app.getHttpServer())
        .post(e2e.url('/teams/invites/accept'))
        .send({ token: TOKEN });

      // 가드는 익명으로 통과시키고, 서비스가 "가입이 필요하다"고 판단한다
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'AUTH_UNAUTHORIZED' });
    });

    it('잘못된 토큰은 익명이 아니라 차단해야 함', async () => {
      const res = await request(app.getHttpServer())
        .post(e2e.url('/teams/invites/accept'))
        .set('Authorization', 'Bearer forged.token.value')
        .send({ token: TOKEN });

      // 익명으로 격하시키면 만료된 세션이 조용히 비회원 취급된다
      expect(res.status).toBe(401);
    });

    it('유효한 토큰이면 가입 처리로 넘어가야 함', async () => {
      userRepository.findOne.mockResolvedValue(ACTOR);
      const jwt = sign({ sub: ACTOR.userId, loginType: 'KAKAO' }, JWT_SECRET, { expiresIn: '1h' });
      // 초대 검증은 별도 스펙(team.service.invite.spec)에서 덮으므로 여기선 통과시킨다
      jest.spyOn(teamService, 'acceptTeamInvite').mockResolvedValue({
        teamId: TEAM_ID,
        teamName: '테스트팀',
        message: '팀에 성공적으로 가입했습니다.',
      });

      const res = await request(app.getHttpServer())
        .post(e2e.url('/teams/invites/accept'))
        .set('Authorization', `Bearer ${jwt}`)
        .send({ token: TOKEN });

      expect(res.status).toBe(201);
      expect(teamService.acceptTeamInvite).toHaveBeenCalledWith({
        token: TOKEN,
        userId: ACTOR.userId,
      });
    });

    it('토큰 필드가 비면 검증 단계에서 거부해야 함', async () => {
      const res = await request(app.getHttpServer())
        .post(e2e.url('/teams/invites/accept'))
        .send({ token: '' });

      expect(res.status).toBe(422);
    });
  });

  /**
   * `requireManagerAccess`는 `TeamController`의 private 메서드다.
   * 서비스가 아니라 컨트롤러에 있으므로 **단위 테스트로는 덮이지 않는다** —
   * 이 경로가 뚫리면 일반 멤버가 팀의 알림 채널을 임의로 연동/해제할 수 있다.
   */
  describe('텔레그램 연동 — 컨트롤러 권한 (requireManagerAccess)', () => {
    beforeEach(() => buildApp(ACTOR));

    it.each([
      ['MASTER', 'MASTER', 201],
      ['MANAGER', 'MANAGER', 201],
      ['MEMBER', 'MEMBER', 403],
      ['비멤버', null, 403],
    ])('%s의 연동 요청은 %s → %d', async (_desc, role, expected) => {
      mockRole(role);
      telegramService.generateLinkToken.mockResolvedValue({
        token: 'tok',
        deepLink: 'https://t.me/bot?startgroup=tok',
        endAt: hoursFromNow(24),
      });

      const res = await request(app.getHttpServer())
        .post(e2e.url(`/teams/${TEAM_ID}/telegram/link`))
        .send();

      expect(res.status).toBe(expected);
      if (expected === 403) {
        expect(res.body).toMatchObject({ code: 'TEAM_FORBIDDEN' });
        // 권한이 없으면 토큰을 만들어서도 안 된다
        expect(telegramService.generateLinkToken).not.toHaveBeenCalled();
      } else {
        expect(res.body.data).toHaveProperty('deepLink');
      }
    });
  });
});

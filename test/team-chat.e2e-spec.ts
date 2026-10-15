import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { TeamChatController } from '../src/modules/team/team-chat.controller';
import { TeamController } from '../src/modules/team/team.controller';
import { TeamChatService } from '../src/modules/team/team-chat.service';
import { TeamService } from '../src/modules/team/team.service';
import { TeamGateway } from '../src/modules/team/team.gateway';
import { TelegramService } from '../src/modules/notification/telegram.service';
import { DiscordService } from '../src/modules/notification/discord.service';
import { TeamForbiddenErrorResponseDto } from '../src/modules/team/team-error.dto';
import { TeamChatMessage } from '../src/entities/TeamChatMessage';
import { TeamMember } from '../src/entities/TeamMember';
import { User } from '../src/entities/User';
import { createUser, createTeamMemberView } from '../src/entities/__spec__/entity.factory';
import { createMockRepository } from '../src/common/__spec__/mock-repository';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

const TEAM_ID = 7;
const MEMBER = createUser({ userId: 42, userName: '멤버' });

/**
 * 팀 채팅 REST의 HTTP 경계 (docs/tasks/team-chat-persistence DESIGN §7).
 *
 * 이 프로젝트에서 반복된 결함은 "라우트에 가드·멤버십 검증이 빠져 남의 팀 데이터가 보이는 것"이다
 * (playbook 클러스터 1). 서비스 spec은 메서드를 직접 부르므로 가드·파이프·필터 조합은 여기서만 검증된다.
 *
 * TeamChatService는 진짜를 쓴다 — 멤버십 검증이 서비스 안에 있기 때문이다. DB는 붙이지 않는다.
 */
describe('E2E 팀 채팅 REST', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let teamService: { verifyTeamMemberAccess: jest.Mock; getTeamMembersBy: jest.Mock };
  let chatService: TeamChatService;

  const build = async (authUser?: User) => {
    teamService = {
      verifyTeamMemberAccess: jest.fn().mockResolvedValue(createTeamMemberView({ teamId: TEAM_ID })),
      getTeamMembersBy: jest.fn().mockResolvedValue([createTeamMemberView({ teamId: TEAM_ID })]),
    };

    e2e = await createE2eApp({
      controllers: [TeamChatController, TeamController],
      authUser,
      providers: [
        TeamChatService,
        { provide: TeamService, useValue: teamService },
        { provide: getRepositoryToken(TeamChatMessage), useValue: createMockRepository<TeamChatMessage>() },
        { provide: getRepositoryToken(TeamMember), useValue: createMockRepository<TeamMember>() },
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn(), manager: {} } as unknown as DataSource },
        // TeamController가 DI로 받는 나머지 — 이번 검증 대상이 아니다
        // (초대 수락 라우트의 OptionalJwtAuthGuard가 ConfigService·User Repository를 요구한다)
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: TelegramService, useValue: {} },
        { provide: DiscordService, useValue: {} },
        { provide: TeamGateway, useValue: {} },
      ],
    });
    app = e2e.app;
    chatService = e2e.moduleRef.get(TeamChatService);
  };

  afterEach(async () => {
    await app.close();
  });

  describe('인증 — 가드가 붙어 있는가', () => {
    beforeEach(() => build(undefined));

    it.each([`/teams/${TEAM_ID}/chat/messages`, `/teams/${TEAM_ID}/chat/read-state`])(
      '비로그인으로 %s를 부르면 401이어야 함',
      async (path) => {
        const res = await request(app.getHttpServer()).get(e2e.url(path));

        // 가드가 빠지면 서비스까지 내려가 멤버십 검증만 남는다 — 401이 아니라 다른 코드가 나온다
        expect(res.status).toBe(401);
        expect(teamService.verifyTeamMemberAccess).not.toHaveBeenCalled();
      },
    );
  });

  describe('인가 — 팀 멤버만', () => {
    beforeEach(() => build(MEMBER));

    it.each([`/teams/${TEAM_ID}/chat/messages`, `/teams/${TEAM_ID}/chat/read-state`])(
      '비멤버가 %s를 부르면 403 TEAM_FORBIDDEN이어야 함',
      async (path) => {
        teamService.verifyTeamMemberAccess.mockRejectedValue(
          new TeamForbiddenErrorResponseDto('팀 멤버만 접근할 수 있습니다.'),
        );

        const res = await request(app.getHttpServer()).get(e2e.url(path));

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'TEAM_FORBIDDEN' });
        // 경로의 teamId와 토큰의 사용자로 검증해야 한다 (다른 팀 ID로 우회 불가)
        expect(teamService.verifyTeamMemberAccess).toHaveBeenCalledWith(TEAM_ID, MEMBER.userId);
      },
    );
  });

  describe('이력 조회 입력 검증', () => {
    beforeEach(() => build(MEMBER));

    it('beforeId와 afterId를 함께 주면 400 TEAM_CHAT_BAD_REQUEST여야 함', async () => {
      const res = await request(app.getHttpServer()).get(
        e2e.url(`/teams/${TEAM_ID}/chat/messages?beforeId=100&afterId=90`),
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'TEAM_CHAT_BAD_REQUEST' });
    });

    it.each([['limit=101'], ['limit=0'], ['beforeId=abc'], ['unknown=1']])(
      '%s는 검증 단계에서 422로 거부해야 함',
      async (query) => {
        const res = await request(app.getHttpServer()).get(e2e.url(`/teams/${TEAM_ID}/chat/messages?${query}`));

        expect(res.status).toBe(422);
        expect(teamService.verifyTeamMemberAccess).not.toHaveBeenCalled();
      },
    );
  });

  describe('GET /teams 안읽음 배지', () => {
    beforeEach(() => build(MEMBER));

    it('팀마다 unreadChatCount를 붙여야 함 (안읽음이 없는 팀은 0)', async () => {
      teamService.getTeamMembersBy.mockResolvedValue([
        createTeamMemberView({ teamId: 7 }),
        createTeamMemberView({ teamId: 8 }),
      ]);
      jest.spyOn(chatService, 'getUnreadCounts').mockResolvedValue(new Map([[7, 3]]));

      const res = await request(app.getHttpServer()).get(e2e.url('/teams'));

      expect(res.status).toBe(200);
      expect(res.body.data.map((t: { teamId: number; unreadChatCount: number }) => [t.teamId, t.unreadChatCount])).toEqual([
        [7, 3],
        [8, 0],
      ]);
    });

    it('배지 집계가 실패해도 팀 목록은 내려줘야 함 (배지는 보조 정보)', async () => {
      jest.spyOn(chatService, 'getUnreadCounts').mockRejectedValue(new Error('ORA-03113'));

      const res = await request(app.getHttpServer()).get(e2e.url('/teams'));

      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({ teamId: TEAM_ID, unreadChatCount: 0 });
    });
  });
});

import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { TeamController } from '../src/modules/team/team.controller';
import { TeamService } from '../src/modules/team/team.service';
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
import { createUser, createTaskComment } from '../src/entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

const TEAM_ID = 7;
const TASK_ID = 3;
const COMMENT_ID = 11;
const AUTHOR = createUser({ userId: 42, userName: '작성자' });

/**
 * 2026-08-07~10에 고친 **접근 제어 3건**을 HTTP 경계에서 검증한다.
 *
 * 단위 테스트는 서비스 메서드를 직접 호출해 검증했지만, 실제 사용자는 HTTP로 들어온다.
 * 그 사이에 가드·파이프·컨트롤러·예외 필터가 있고, **그 조합이 실제로 403을 돌려주는지**는
 * 지금까지 "수동 E2E 미검증"으로 남아 있던 항목이다. 인증이 필요해 사람이 직접
 * 확인해야 했던 것을 여기서 자동화한다.
 *
 * DB는 붙이지 않는다(D6 전략 A). `getTeamMembersBy`가 "멤버 없음"을 반환하도록 고정하면
 * 탈퇴자·비멤버 상황이 그대로 재현된다 — 실제 서비스 로직은 전부 실행된다.
 */
describe('E2E 접근 제어 (팀 멤버십)', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let taskCommentRepository: MockRepository<TaskComment>;
  let teamService: TeamService;

  beforeEach(async () => {
    taskCommentRepository = createMockRepository<TaskComment>();

    e2e = await createE2eApp({
      controllers: [TeamController],
      authUser: AUTHOR,
      providers: [
        // 서비스는 진짜를 쓴다 — 검증하려는 것이 서비스의 접근 제어 로직이기 때문이다.
        // Repository만 끊어 DB 없이 돌린다.
        TeamService,
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } as unknown as DataSource },
        { provide: getRepositoryToken(Team), useValue: createMockRepository<Team>() },
        { provide: getRepositoryToken(TeamMember), useValue: createMockRepository<TeamMember>() },
        { provide: getRepositoryToken(TeamTask), useValue: createMockRepository<TeamTask>() },
        { provide: getRepositoryToken(TaskComment), useValue: taskCommentRepository },
        { provide: getRepositoryToken(TeamInvitation), useValue: createMockRepository<TeamInvitation>() },
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: NOTIFICATION_PORT, useValue: { notifyTeam: jest.fn() } },
        // 컨트롤러가 DI로 받는 나머지 — 이번 검증 대상이 아니라 동작만 막아둔다
        { provide: TelegramService, useValue: {} },
        { provide: DiscordService, useValue: {} },
        { provide: TeamGateway, useValue: { emitTaskCreated: jest.fn(), emitCommentUpdated: jest.fn(), emitCommentDeleted: jest.fn() } },
      ],
    });
    app = e2e.app;
    teamService = e2e.moduleRef.get(TeamService);
  });

  afterEach(async () => {
    await app.close();
  });

  /** 팀 멤버 조회 결과를 고정한다. 빈 배열 = 비멤버이거나 탈퇴한 상태 */
  const mockMembership = (isMember: boolean) =>
    jest
      .spyOn(teamService, 'getTeamMembersBy')
      .mockResolvedValue(
        isMember
          ? [
              {
                teamId: TEAM_ID,
                teamName: '테스트팀',
                teamDescription: null,
                crtdAt: new Date(),
                actStatus: 1,
                leaderId: 1,
                telegramChatId: null,
                discordWebhookUrl: null,
                userId: AUTHOR.userId,
                joinedAt: new Date(),
                role: 'MEMBER',
                userActStatus: 1,
              },
            ]
          : [],
      );

  describe('태스크 생성 (2026-08-10 수정)', () => {
    it('비멤버가 남의 팀에 태스크를 만들면 403이어야 함', async () => {
      mockMembership(false);

      const res = await request(app.getHttpServer())
        .post(e2e.url(`/teams/${TEAM_ID}/tasks`))
        .send({ taskName: '침입 태스크', taskDescription: '설명' });

      // 수정 전에는 팀 존재만 확인해서 남의 팀에 태스크가 만들어졌다
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TEAM_FORBIDDEN' });
    });

    it('멤버면 생성되어야 함 (차단이 과하지 않은지)', async () => {
      mockMembership(true);
      const taskRepo = e2e.moduleRef.get<MockRepository<TeamTask>>(getRepositoryToken(TeamTask));
      taskRepo.create.mockImplementation((d) => d as TeamTask);
      taskRepo.save.mockResolvedValue({ taskId: TASK_ID, teamId: TEAM_ID } as TeamTask);

      const res = await request(app.getHttpServer())
        .post(e2e.url(`/teams/${TEAM_ID}/tasks`))
        .send({ taskName: '정상 태스크', taskDescription: '설명' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ code: 'SUCCESS' });
    });
  });

  describe('댓글 수정·삭제 (2026-08-07 수정)', () => {
    beforeEach(() => {
      // 본인이 쓴 댓글이 존재하는 상태 — 작성자 검증만 있었다면 통과했을 조건
      taskCommentRepository.findOne.mockResolvedValue(
        createTaskComment({
          commentId: COMMENT_ID,
          teamId: TEAM_ID,
          taskId: TASK_ID,
          userId: AUTHOR.userId,
        }),
      );
    });

    it('탈퇴한 멤버가 자기 댓글을 수정하면 403이어야 함', async () => {
      mockMembership(false);

      const res = await request(app.getHttpServer())
        .patch(e2e.url(`/teams/${TEAM_ID}/tasks/${TASK_ID}/comments/${COMMENT_ID}`))
        .send({ commentContent: '탈퇴 후 수정' });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TEAM_FORBIDDEN' });
      // 멤버 검증이 작성자 검증보다 앞이라 댓글을 조회하지도 않는다
      expect(taskCommentRepository.findOne).not.toHaveBeenCalled();
    });

    it('탈퇴한 멤버가 자기 댓글을 삭제하면 403이어야 함', async () => {
      mockMembership(false);

      const res = await request(app.getHttpServer())
        .delete(e2e.url(`/teams/${TEAM_ID}/tasks/${TASK_ID}/comments/${COMMENT_ID}`))
        .send();

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TEAM_FORBIDDEN' });
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it('멤버면 수정되어야 함 (차단이 과하지 않은지)', async () => {
      mockMembership(true);
      jest.spyOn(teamService, 'getTeamTasksBy').mockResolvedValue([
        {
          teamName: '테스트팀',
          teamDescription: null,
          leaderId: 1,
          telegramChatId: null,
          discordWebhookUrl: null,
          taskId: TASK_ID,
          teamId: TEAM_ID,
          taskName: '태스크',
          taskDescription: null,
          taskStatus: 1,
          actStatus: 1,
          startAt: null,
          endAt: null,
          completedAt: null,
          crtdAt: new Date(),
          crtdBy: 1,
          userName: '작성자',
        },
      ]);
      taskCommentRepository.save.mockImplementation((c) => Promise.resolve(c as TaskComment));

      const res = await request(app.getHttpServer())
        .patch(e2e.url(`/teams/${TEAM_ID}/tasks/${TASK_ID}/comments/${COMMENT_ID}`))
        .send({ commentContent: '정상 수정' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ code: 'SUCCESS' });
    });
  });

  describe('전역 파이프라인', () => {
    it('필수 필드가 없으면 VALIDATION_ERROR(422)여야 함', async () => {
      mockMembership(true);

      const res = await request(app.getHttpServer())
        .post(e2e.url(`/teams/${TEAM_ID}/tasks`))
        .send({ taskDescription: '이름 없음' });

      // ValidationPipe가 파이프라인에 실제로 들어가 있다는 증거.
      // 400이 아니라 422인 것이 이 프로젝트의 계약이다 — 프론트도 VALIDATION_ERROR로 매핑한다
      // (next-bun/src/types/api.ts:28,60)
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('허용되지 않은 필드를 보내면 거부해야 함 (forbidNonWhitelisted)', async () => {
      mockMembership(true);

      const res = await request(app.getHttpServer())
        .post(e2e.url(`/teams/${TEAM_ID}/tasks`))
        .send({ taskName: '태스크', taskDescription: '설명', taskStatus: 3, evilField: 'x' });

      // whitelist만 켜져 있으면 조용히 무시된다 — forbidNonWhitelisted가 살아 있어야 거부된다
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });
});

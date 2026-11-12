import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { TeamController } from '../src/modules/team/team.controller';
import { TeamService } from '../src/modules/team/team.service';
import { TeamGateway } from '../src/modules/team/team.gateway';
import { TeamChatService } from '../src/modules/team/team-chat.service';
import { TeamDisplayNameService } from '../src/modules/team/team-display-name.service';
import { createMockTeamDisplayNameService } from '../src/modules/team/__spec__/team-display-name.mock';
import { TelegramService } from '../src/modules/notification/telegram.service';
import { DiscordService } from '../src/modules/notification/discord.service';
import { NOTIFICATION_PORT } from '../src/common/port/notification.port';
import { Team } from '../src/entities/Team';
import { TeamMember } from '../src/entities/TeamMember';
import { TeamTask } from '../src/entities/TeamTask';
import { TaskComment } from '../src/entities/TaskComment';
import { TeamInvitation } from '../src/entities/TeamInvitation';
import { User } from '../src/entities/User';
import {  createUser,  createTaskComment,  createTeamTag,  createTeamTask,  createTeamTaskTag,} from '../src/entities/__spec__/entity.factory';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
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
  let teamMemberRepository: MockRepository<TeamMember>;
  let teamService: TeamService;

  /** 태스크 태그 연결(task-tags.ts)이 트랜잭션 안팎에서 쓰는 EntityManager */
  let manager: Record<'find' | 'count' | 'save' | 'delete' | 'insert' | 'createQueryBuilder', jest.Mock>;
  let dataSource: { transaction: jest.Mock; manager: typeof manager };
  let gateway: Record<
    | 'emitTaskCreated'
    | 'emitTaskUpdated'
    | 'emitCommentCreated'
    | 'emitCommentUpdated'
    | 'emitCommentDeleted'
    | 'notifyMemberNicknameChanged',
    jest.Mock
  >;

  beforeEach(async () => {
    taskCommentRepository = createMockRepository<TaskComment>();
    teamMemberRepository = createMockRepository<TeamMember>();
    manager = {
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn(),
      save: jest.fn((entity: TeamTask) => Promise.resolve(createTeamTask({ ...entity, taskId: TASK_ID, teamId: TEAM_ID }))),
      delete: jest.fn(),
      insert: jest.fn(),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder({ getMany: [] })),
    };
    dataSource = { transaction: jest.fn((run: (m: typeof manager) => unknown) => run(manager)), manager };
    gateway = {
      emitTaskCreated: jest.fn(),
      emitTaskUpdated: jest.fn(),
      emitCommentUpdated: jest.fn(),
      emitCommentDeleted: jest.fn(),
      emitCommentCreated: jest.fn(),
      notifyMemberNicknameChanged: jest.fn().mockResolvedValue(undefined),
    };

    e2e = await createE2eApp({
      controllers: [TeamController],
      authUser: AUTHOR,
      providers: [
        // 서비스는 진짜를 쓴다 — 검증하려는 것이 서비스의 접근 제어 로직이기 때문이다.
        // Repository만 끊어 DB 없이 돌린다.
        TeamService,
        { provide: getDataSourceToken(), useValue: dataSource as unknown as DataSource },
        { provide: getRepositoryToken(Team), useValue: createMockRepository<Team>() },
        { provide: getRepositoryToken(TeamMember), useValue: teamMemberRepository },
        { provide: getRepositoryToken(TeamTask), useValue: createMockRepository<TeamTask>() },
        { provide: getRepositoryToken(TaskComment), useValue: taskCommentRepository },
        { provide: getRepositoryToken(TeamInvitation), useValue: createMockRepository<TeamInvitation>() },
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() }, // 가드(OptionalJwtAuthGuard)용
        { provide: TeamDisplayNameService, useValue: createMockTeamDisplayNameService({ [AUTHOR.userId]: '작성자' }) },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: NOTIFICATION_PORT, useValue: { notifyTeam: jest.fn() } },
        // 컨트롤러가 DI로 받는 나머지 — 이번 검증 대상이 아니라 동작만 막아둔다
        { provide: TelegramService, useValue: {} },
        { provide: TeamChatService, useValue: {} },
        { provide: DiscordService, useValue: {} },
        { provide: TeamGateway, useValue: gateway },
      ],
    });
    app = e2e.app;
    teamService = e2e.moduleRef.get(TeamService);
  });

  afterEach(async () => {
    await app.close();
  });

  /** 팀 멤버 조회 결과를 고정한다. 빈 배열 = 비멤버이거나 탈퇴한 상태 */
  const mockMembership = (isMember: boolean, role: string = 'MEMBER') =>
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
                role,
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

  // 팀 단위 닉네임 — 본인만·활성 멤버만, 입력은 trim 후 1~20자 (docs/tasks/team-nickname D-002·D-004)
  describe('팀 닉네임 변경', () => {
    const nicknameUrl = () => e2e.url(`/teams/${TEAM_ID}/users/me/nickname`);

    it('비멤버가 설정하면 403 TEAM_FORBIDDEN이고 저장·알림이 없어야 함', async () => {
      mockMembership(false);

      const res = await request(app.getHttpServer()).put(nicknameUrl()).send({ teamNickname: '침입자' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TEAM_FORBIDDEN');
      expect(teamMemberRepository.update).not.toHaveBeenCalled();
      expect(gateway.notifyMemberNicknameChanged).not.toHaveBeenCalled();
    });

    it('멤버면 앞뒤 공백을 지워 본인 행에 저장하고 팀에 알려야 함', async () => {
      mockMembership(true);
      const displayNames = e2e.moduleRef.get(TeamDisplayNameService) as unknown as { getDisplayName: jest.Mock };
      displayNames.getDisplayName.mockResolvedValue('기획 길동');

      const res = await request(app.getHttpServer()).put(nicknameUrl()).send({ teamNickname: '  기획 길동  ' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        code: 'SUCCESS',
        data: { teamId: TEAM_ID, userId: AUTHOR.userId, teamNickname: '기획 길동', userName: '기획 길동' },
        message: '',
      });
      expect(teamMemberRepository.update).toHaveBeenCalledWith(
        { teamId: TEAM_ID, userId: AUTHOR.userId },
        { teamNickname: '기획 길동' },
      );
      expect(gateway.notifyMemberNicknameChanged).toHaveBeenCalledWith(TEAM_ID, res.body.data);
    });

    it.each([
      ['빈 문자열', ''],
      ['공백만', '   '],
      ['21자', '가'.repeat(21)],
      // 20자지만 UTF-8 120바이트 — 컬럼 VARCHAR2(100 BYTE)를 넘어 ORA-12899(500)가 나던 값
      ['20자지만 100바이트 초과(❤️×20)', '❤️'.repeat(20)],
    ])('%s이면 422 VALIDATION_ERROR이고 저장하지 않아야 함', async (_desc, teamNickname) => {
      mockMembership(true);

      const res = await request(app.getHttpServer()).put(nicknameUrl()).send({ teamNickname });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(teamMemberRepository.update).not.toHaveBeenCalled();
    });

    it('남의 userId를 실어 보내도 받지 않아야 함 (본인만, forbidNonWhitelisted)', async () => {
      mockMembership(true);

      const res = await request(app.getHttpServer()).put(nicknameUrl()).send({ teamNickname: '대리', userId: 1 });

      expect(res.status).toBe(422);
      expect(teamMemberRepository.update).not.toHaveBeenCalled();
    });

    it('20자는 허용해야 함 (경계)', async () => {
      mockMembership(true);

      const res = await request(app.getHttpServer()).put(nicknameUrl()).send({ teamNickname: '가'.repeat(20) });

      expect(res.status).toBe(200);
    });

    it('댓글 생성 뒤 팀 표시 이름 조회가 실패해도 201이고 계정 닉네임으로 알려야 함', async () => {
      jest.spyOn(teamService, 'createTaskComment').mockResolvedValue(
        createTaskComment({ commentId: COMMENT_ID, taskId: TASK_ID, teamId: TEAM_ID, userId: AUTHOR.userId }),
      );
      const displayNames = e2e.moduleRef.get(TeamDisplayNameService) as unknown as { getDisplayName: jest.Mock };
      displayNames.getDisplayName.mockRejectedValue(new Error('ORA-03113'));

      const res = await request(app.getHttpServer())
        .post(e2e.url(`/teams/${TEAM_ID}/tasks/${TASK_ID}/comments`))
        .send({ commentContent: '댓글' });

      expect(res.status).toBe(201);
      expect(gateway.emitCommentCreated).toHaveBeenCalledWith(
        TEAM_ID,
        expect.objectContaining({ commentId: COMMENT_ID, userId: AUTHOR.userId, userName: '작성자' }),
      );
    });

    it('소켓 알림이 실패해도 저장은 성공으로 응답해야 함', async () => {
      mockMembership(true);
      gateway.notifyMemberNicknameChanged.mockRejectedValue(new Error('redis down'));

      const res = await request(app.getHttpServer()).put(nicknameUrl()).send({ teamNickname: '팀닉' });

      expect(res.status).toBe(200);
      expect(teamMemberRepository.update).toHaveBeenCalled();
    });
  });

  describe('알림 연동 상태 조회 — 역할별 축소 (2026-10-15)', () => {
    const WEBHOOK = 'https://discord.test/api/webhooks/1/secret';
    const TOKEN = 'pending-link-token';

    /** 컨트롤러에 주입된 알림 서비스 mock에 연동 상태를 심는다 */
    const mockLinkStatus = () => {
      const telegram = e2e.moduleRef.get(TelegramService) as unknown as { getLinkStatus: jest.Mock };
      const discord = e2e.moduleRef.get(DiscordService) as unknown as { getLinkStatus: jest.Mock };
      telegram.getLinkStatus = jest.fn().mockResolvedValue({
        isLinked: false,
        chatId: null,
        pendingLink: { token: TOKEN, deepLink: `https://t.me/bot?startgroup=${TOKEN}`, endAt: new Date() },
      });
      discord.getLinkStatus = jest.fn().mockResolvedValue({ isLinked: true, webhookUrl: WEBHOOK });
    };

    it('MEMBER에게는 텔레그램 연동 토큰 없이 연동 여부만 줘야 함', async () => {
      mockMembership(true, 'MEMBER');
      mockLinkStatus();

      const res = await request(app.getHttpServer()).get(e2e.url(`/teams/${TEAM_ID}/telegram/status`));

      // 토큰을 받으면 일반 멤버가 자기 그룹을 팀에 연결해 알림을 가로챌 수 있다
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ isLinked: false });
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    });

    it('MEMBER에게는 디스코드 웹훅 URL 없이 연동 여부만 줘야 함', async () => {
      mockMembership(true, 'MEMBER');
      mockLinkStatus();

      const res = await request(app.getHttpServer()).get(e2e.url(`/teams/${TEAM_ID}/discord/status`));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ isLinked: true });
      expect(JSON.stringify(res.body)).not.toContain(WEBHOOK);
    });

    it.each(['MASTER', 'MANAGER'])('%s에게는 지금처럼 전체 연동 정보를 줘야 함', async (role) => {
      mockMembership(true, role);
      mockLinkStatus();

      const telegramRes = await request(app.getHttpServer()).get(e2e.url(`/teams/${TEAM_ID}/telegram/status`));
      const discordRes = await request(app.getHttpServer()).get(e2e.url(`/teams/${TEAM_ID}/discord/status`));

      expect(telegramRes.status).toBe(200);
      expect(telegramRes.body.data.pendingLink.token).toBe(TOKEN);
      expect(discordRes.status).toBe(200);
      expect(discordRes.body.data.webhookUrl).toBe(WEBHOOK);
    });

    it('비멤버는 지금처럼 403이어야 함', async () => {
      mockMembership(false);
      mockLinkStatus();

      const res = await request(app.getHttpServer()).get(e2e.url(`/teams/${TEAM_ID}/telegram/status`));

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TEAM_FORBIDDEN' });
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

    it.each([
      ['태스크당 한도(10개) 초과', Array.from({ length: 11 }, (_, i) => i + 1)],
      ['중복 ID', [1, 1]],
      ['정수가 아닌 ID', ['a']],
    ])('tagIds가 잘못되면(%s) 서비스에 닿기 전에 VALIDATION_ERROR(422)여야 함', async (_case, tagIds) => {
      mockMembership(true);

      const res = await request(app.getHttpServer())
        .post(e2e.url(`/teams/${TEAM_ID}/tasks`))
        .send({ taskName: '태스크', taskDescription: '설명', tagIds });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('태스크 태그 — HTTP 경로 (docs/tasks/team-task-tags)', () => {
    /** findTagsByTaskIds가 읽는 연결 행 */
    const linkRow = (tagId: number, tagName: string) =>
      createTeamTaskTag({ taskId: TASK_ID, tagId, tag: createTeamTag({ tagId, tagName, tagColor: '#38BDF8' }) });
    const expectedTag = (tagId: number, tagName: string) => ({ tagId, tagName, tagColor: '#38BDF8' });

    it('POST tagIds 성공 시 응답 data.tags와 taskCreated 페이로드에 태그가 실려야 함', async () => {
      mockMembership(true);
      const taskRepo = e2e.moduleRef.get<MockRepository<TeamTask>>(getRepositoryToken(TeamTask));
      taskRepo.create.mockImplementation((d) => d as TeamTask);
      manager.count.mockResolvedValue(1);
      manager.find.mockResolvedValue([linkRow(5, '긴급')]);

      const res = await request(app.getHttpServer())
        .post(e2e.url(`/teams/${TEAM_ID}/tasks`))
        .send({ taskName: '태그 태스크', taskDescription: '설명', tagIds: [5] });

      expect(res.status).toBe(201);
      expect(res.body.data.tags).toEqual([expectedTag(5, '긴급')]);
      expect(gateway.emitTaskCreated).toHaveBeenCalledWith(
        TEAM_ID,
        expect.objectContaining({ taskId: TASK_ID, tags: [expectedTag(5, '긴급')] }),
      );
    });

    it('PATCH tagIds 성공 시 응답 data.tags와 taskUpdated 페이로드에 현재 태그 전체가 실려야 함', async () => {
      mockMembership(true);
      const taskRepo = e2e.moduleRef.get<MockRepository<TeamTask>>(getRepositoryToken(TeamTask));
      taskRepo.findOne.mockResolvedValue(createTeamTask({ taskId: TASK_ID, teamId: TEAM_ID }));
      manager.count.mockResolvedValue(2);
      manager.find
        .mockResolvedValueOnce([]) // 교체 전
        .mockResolvedValue([linkRow(5, '긴급'), linkRow(6, '디자인')]); // 교체 후

      const res = await request(app.getHttpServer())
        .patch(e2e.url(`/teams/${TEAM_ID}/tasks/${TASK_ID}`))
        .send({ tagIds: [5, 6] });

      const tags = [expectedTag(5, '긴급'), expectedTag(6, '디자인')];
      expect(res.status).toBe(200);
      expect(res.body.data.tags).toEqual(tags);
      expect(gateway.emitTaskUpdated).toHaveBeenCalledWith(TEAM_ID, expect.objectContaining({ taskId: TASK_ID, tags }));
    });

    it.each([
      ['태스크당 한도(10개) 초과', Array.from({ length: 11 }, (_, i) => i + 1)],
      ['중복 ID', [1, 1]],
    ])('PATCH tagIds가 잘못되면(%s) 서비스에 닿기 전에 VALIDATION_ERROR(422)여야 함', async (_case, tagIds) => {
      mockMembership(true);

      const res = await request(app.getHttpServer())
        .patch(e2e.url(`/teams/${TEAM_ID}/tasks/${TASK_ID}`))
        .send({ tagIds });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(manager.delete).not.toHaveBeenCalled();
    });
  });
});

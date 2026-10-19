import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TeamTagController } from '../src/modules/team/team-tag.controller';
import { TeamTagService } from '../src/modules/team/team-tag.service';
import { TeamService } from '../src/modules/team/team.service';
import { TeamGateway } from '../src/modules/team/team.gateway';
import { TeamTag } from '../src/entities/TeamTag';
import { TeamTaskTag } from '../src/entities/TeamTaskTag';
import { TeamForbiddenErrorResponseDto } from '../src/modules/team/team-error.dto';
import { createTeamMemberView, createTeamTag, createUser } from '../src/entities/__spec__/entity.factory';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

const TEAM_ID = 7;
const MEMBER = createUser({ userId: 42 });

/**
 * 팀 태그 REST를 HTTP 경계에서 검증한다 (docs/tasks/team-task-tags DESIGN.md §2).
 *
 * 실제 TeamTagService를 태우고 Repository만 mock한다 — 라우팅(`tags/order` vs `tags/:tagId`),
 * 전역 ValidationPipe(trim·대문자 정규화·형식), 도메인 에러 → `{ code }` 변환, 소켓 발행 인자를 본다.
 */
describe('E2E 팀 태그', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let teamTagRepository: MockRepository<TeamTag>;
  let teamTaskTagRepository: MockRepository<TeamTaskTag>;
  let teamService: { verifyTeamMemberAccess: jest.Mock };
  let teamGateway: Record<'emitTagCreated' | 'emitTagUpdated' | 'emitTagDeleted' | 'emitTagsReordered', jest.Mock>;
  /** 재정렬 트랜잭션 — 팀 태그 행을 잠그고 읽는 QueryBuilder(getMany)와 update */
  let manager: { createQueryBuilder: jest.Mock; update: jest.Mock };

  beforeEach(async () => {
    teamTagRepository = createMockRepository<TeamTag>();
    teamTaskTagRepository = createMockRepository<TeamTaskTag>();
    teamService = { verifyTeamMemberAccess: jest.fn().mockResolvedValue(createTeamMemberView({ teamId: TEAM_ID })) };
    teamGateway = {
      emitTagCreated: jest.fn(),
      emitTagUpdated: jest.fn(),
      emitTagDeleted: jest.fn(),
      emitTagsReordered: jest.fn(),
    };
    manager = { createQueryBuilder: jest.fn(), update: jest.fn() };

    e2e = await createE2eApp({
      controllers: [TeamTagController],
      authUser: MEMBER,
      providers: [
        TeamTagService,
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: jest.fn((run: (m: typeof manager) => unknown) => run(manager)),
          } as unknown as DataSource,
        },
        { provide: getRepositoryToken(TeamTag), useValue: teamTagRepository },
        { provide: getRepositoryToken(TeamTaskTag), useValue: teamTaskTagRepository },
        { provide: TeamService, useValue: teamService },
        { provide: TeamGateway, useValue: teamGateway },
      ],
    });
    app = e2e.app;

    teamTagRepository.create.mockImplementation((data) => data as TeamTag);
    teamTagRepository.save.mockImplementation((entity) =>
      Promise.resolve(createTeamTag({ ...(entity as Partial<TeamTag>), tagId: 10 })),
    );
    teamTagRepository.createQueryBuilder.mockReturnValue(
      createMockQueryBuilder({ getCount: 0, getRawOne: { maxSortOrder: 2 } }) as never,
    );
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /teams/:teamId/tags', () => {
    it('이름은 trim, 색은 대문자로 정규화해 201로 만들고 팀 room에 알려야 함', async () => {
      teamTagRepository.count.mockResolvedValue(0);

      const res = await request(app.getHttpServer())
        .post(e2e.url(`/teams/${TEAM_ID}/tags`))
        .send({ tagName: '  긴급  ', tagColor: '#f87171' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        code: 'SUCCESS',
        data: { tagId: 10, tagName: '긴급', tagColor: '#F87171', sortOrder: 3, taskCount: 0 },
      });
      expect(teamGateway.emitTagCreated).toHaveBeenCalledWith(TEAM_ID, {
        teamId: TEAM_ID,
        tagId: 10,
        tagName: '긴급',
        tagColor: '#F87171',
        sortOrder: 3,
        createdBy: MEMBER.userId,
      });
    });

    it.each([
      ['공백만 있는 이름', { tagName: '   ', tagColor: '#F87171' }],
      ['21자 이름', { tagName: '가'.repeat(21), tagColor: '#F87171' }],
      ['#RRGGBB가 아닌 색', { tagName: '긴급', tagColor: 'red' }],
      ['투명도 포함 색', { tagName: '긴급', tagColor: '#F87171FF' }],
    ])('%s이면 VALIDATION_ERROR(422)이고 저장하지 않아야 함', async (_case, body) => {
      const res = await request(app.getHttpServer()).post(e2e.url(`/teams/${TEAM_ID}/tags`)).send(body);

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(teamTagRepository.save).not.toHaveBeenCalled();
    });

    it('비멤버면 403이고 알리지 않아야 함', async () => {
      teamService.verifyTeamMemberAccess.mockRejectedValue(new TeamForbiddenErrorResponseDto('팀 멤버만 접근할 수 있습니다.'));

      const res = await request(app.getHttpServer())
        .post(e2e.url(`/teams/${TEAM_ID}/tags`))
        .send({ tagName: '긴급', tagColor: '#F87171' });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TEAM_FORBIDDEN' });
      expect(teamGateway.emitTagCreated).not.toHaveBeenCalled();
    });
  });

  describe('PUT /teams/:teamId/tags/order', () => {
    it('order 경로가 :tagId로 해석되지 않고 재정렬돼야 함', async () => {
      manager.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getMany: [createTeamTag({ tagId: 1, sortOrder: 1 }), createTeamTag({ tagId: 2, sortOrder: 2 })] }));
      teamTagRepository.find.mockResolvedValue([createTeamTag({ tagId: 2, sortOrder: 1 }), createTeamTag({ tagId: 1, sortOrder: 2 })]);
      teamTaskTagRepository.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getRawMany: [] }) as never);

      const res = await request(app.getHttpServer())
        .put(e2e.url(`/teams/${TEAM_ID}/tags/order`))
        .send({ tagIds: [2, 1] });

      expect(res.status).toBe(200);
      expect(res.body.data.map((tag: { tagId: number }) => tag.tagId)).toEqual([2, 1]);
      expect(teamGateway.emitTagsReordered).toHaveBeenCalledWith(TEAM_ID, {
        teamId: TEAM_ID,
        tagIds: [2, 1],
        updatedBy: MEMBER.userId,
      });
    });

    it('그사이 태그가 바뀌었으면 TEAM_TAG_ORDER_CONFLICT(409)이고 알리지 않아야 함', async () => {
      manager.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getMany: [createTeamTag({ tagId: 1 }), createTeamTag({ tagId: 2 }), createTeamTag({ tagId: 3 })] }));

      const res = await request(app.getHttpServer())
        .put(e2e.url(`/teams/${TEAM_ID}/tags/order`))
        .send({ tagIds: [2, 1] });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'TEAM_TAG_ORDER_CONFLICT' });
      expect(teamGateway.emitTagsReordered).not.toHaveBeenCalled();
    });
  });

  describe('PATCH·DELETE /teams/:teamId/tags/:tagId', () => {
    it('다른 팀의 태그를 수정하면 TEAM_TAG_NOT_FOUND(404)', async () => {
      teamTagRepository.findOne.mockResolvedValue(createTeamTag({ tagId: 5, teamId: 99 }));

      const res = await request(app.getHttpServer())
        .patch(e2e.url(`/teams/${TEAM_ID}/tags/5`))
        .send({ tagColor: '#34D399' });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'TEAM_TAG_NOT_FOUND' });
      expect(teamGateway.emitTagUpdated).not.toHaveBeenCalled();
    });

    it('삭제하면 200 + data null이고 팀 room에 tagId를 알려야 함', async () => {
      teamTagRepository.findOne.mockResolvedValue(createTeamTag({ tagId: 5, teamId: TEAM_ID }));

      const res = await request(app.getHttpServer()).delete(e2e.url(`/teams/${TEAM_ID}/tags/5`));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ code: 'SUCCESS', data: null });
      expect(teamTagRepository.delete).toHaveBeenCalledWith({ tagId: 5, teamId: TEAM_ID });
      expect(teamGateway.emitTagDeleted).toHaveBeenCalledWith(TEAM_ID, {
        teamId: TEAM_ID,
        tagId: 5,
        deletedBy: MEMBER.userId,
      });
    });
  });
});

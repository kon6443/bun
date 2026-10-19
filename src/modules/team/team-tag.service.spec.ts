import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { TeamTagService } from './team-tag.service';
import { TeamService } from './team.service';
import { TeamTag } from '../../entities/TeamTag';
import { TeamTaskTag } from '../../entities/TeamTaskTag';
import { createTeamMemberView, createTeamTag } from '../../entities/__spec__/entity.factory';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { TeamForbiddenErrorResponseDto } from './team-error.dto';
import { TEAM_TAG_MAX_PER_TEAM } from '../../common/constants/app.constants';

/**
 * TeamTagService — 팀 태그 CRUD·재정렬 (docs/tasks/team-task-tags D-003·D-004·D-014·D-017).
 *
 * 핵심:
 *  1. 팀 격리 — 모든 경로가 멤버 검증을 먼저 하고, 다른 팀 태그는 "없음"과 같은 404로 숨긴다.
 *  2. 이름 중복 — 앱 선검사(409) + 동시 요청을 막는 DB 유니크 위반도 같은 409로 변환.
 *  3. 재정렬 — 요청 집합이 현재 팀 태그와 다르면 409, 바뀐 태그만 갱신.
 */
describe('TeamTagService', () => {
  let service: TeamTagService;
  let teamTagRepository: MockRepository<TeamTag>;
  let teamTaskTagRepository: MockRepository<TeamTaskTag>;
  let teamService: { verifyTeamMemberAccess: jest.Mock };
  let manager: { createQueryBuilder: jest.Mock; update: jest.Mock };

  /** Oracle ORA-00001 (유니크 위반) */
  const uniqueViolation = () =>
    new QueryFailedError('INSERT', [], Object.assign(new Error('ORA-00001'), { errorNum: 1 }));

  /** 이름 중복 검사(getCount)·최댓값(getRawOne) QueryBuilder */
  const mockTagQueries = ({ duplicateCount = 0, maxSortOrder = null as number | null } = {}) => {
    const qb = createMockQueryBuilder({ getCount: duplicateCount, getRawOne: { maxSortOrder } });
    teamTagRepository.createQueryBuilder.mockReturnValue(qb as never);
    return qb;
  };

  /** 사용 수 집계 QueryBuilder (getRawMany) */
  const mockTaskCounts = (rows: Array<{ tagId: number; taskCount: number }> = []) => {
    const qb = createMockQueryBuilder({ getRawMany: rows });
    teamTaskTagRepository.createQueryBuilder.mockReturnValue(qb as never);
    return qb;
  };

  beforeEach(async () => {
    teamTagRepository = createMockRepository<TeamTag>();
    teamTaskTagRepository = createMockRepository<TeamTaskTag>();
    teamService = { verifyTeamMemberAccess: jest.fn().mockResolvedValue(createTeamMemberView()) };
    manager = { createQueryBuilder: jest.fn(), update: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
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
      ],
    }).compile();

    service = module.get(TeamTagService);
    teamTagRepository.create.mockImplementation((data) => data as TeamTag);
    teamTagRepository.save.mockImplementation((entity) =>
      Promise.resolve(createTeamTag({ ...(entity as Partial<TeamTag>), tagId: (entity as TeamTag).tagId ?? 10 })),
    );
  });

  describe('권한 — 모든 경로가 멤버 검증을 먼저 한다', () => {
    it.each([
      ['getTags', () => service.getTags(1, 1)],
      ['createTag', () => service.createTag({ teamId: 1, userId: 1, dto: { tagName: '긴급', tagColor: '#F87171' } })],
      ['updateTag', () => service.updateTag({ teamId: 1, tagId: 1, userId: 1, dto: { tagName: '변경' } })],
      ['deleteTag', () => service.deleteTag({ teamId: 1, tagId: 1, userId: 1 })],
      ['reorderTags', () => service.reorderTags({ teamId: 1, userId: 1, tagIds: [] })],
    ])('%s: 팀 멤버가 아니면 TEAM_FORBIDDEN(403)이고 태그를 건드리지 않아야 함', async (_name, run) => {
      teamService.verifyTeamMemberAccess.mockRejectedValue(new TeamForbiddenErrorResponseDto());

      const error = await run().catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'TEAM_FORBIDDEN', status: 403 });
      expect(teamTagRepository.findOne).not.toHaveBeenCalled();
      expect(teamTagRepository.save).not.toHaveBeenCalled();
      expect(teamTagRepository.delete).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  describe('getTags', () => {
    it('정렬 순서로 조회하고 사용 수를 붙여야 함 (연결 없는 태그는 0)', async () => {
      teamTagRepository.find.mockResolvedValue([createTeamTag({ tagId: 2, sortOrder: 1 }), createTeamTag({ tagId: 1, sortOrder: 2 })]);
      mockTaskCounts([{ tagId: 1, taskCount: 3 }]);

      const tags = await service.getTags(7, 1);

      expect(teamTagRepository.find).toHaveBeenCalledWith({ where: { teamId: 7 }, order: { sortOrder: 'ASC', tagId: 'ASC' } });
      expect(tags.map(({ tagId, taskCount }) => ({ tagId, taskCount }))).toEqual([
        { tagId: 2, taskCount: 0 },
        { tagId: 1, taskCount: 3 },
      ]);
    });

    it('태그가 없으면 사용 수를 조회하지 않아야 함', async () => {
      teamTagRepository.find.mockResolvedValue([]);

      await expect(service.getTags(7, 1)).resolves.toEqual([]);
      expect(teamTaskTagRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('createTag', () => {
    const create = (tagName = '긴급') =>
      service.createTag({ teamId: 7, userId: 3, dto: { tagName, tagColor: '#F87171' } });

    it('팀 최댓값 + 1 순서로 맨 뒤에 추가해야 함', async () => {
      teamTagRepository.count.mockResolvedValue(2);
      mockTagQueries({ maxSortOrder: 5 });

      const tag = await create();

      expect(teamTagRepository.create).toHaveBeenCalledWith({
        teamId: 7,
        tagName: '긴급',
        tagColor: '#F87171',
        sortOrder: 6,
        crtdBy: 3,
        mdfdAt: null,
      });
      expect(tag).toMatchObject({ tagName: '긴급', sortOrder: 6, taskCount: 0 });
    });

    it('첫 태그는 순서 1이어야 함', async () => {
      teamTagRepository.count.mockResolvedValue(0);
      mockTagQueries({ maxSortOrder: null });

      await expect(create()).resolves.toMatchObject({ sortOrder: 1 });
    });

    it(`팀 태그가 ${TEAM_TAG_MAX_PER_TEAM}개면 TEAM_TAG_LIMIT_EXCEEDED(400)로 거부해야 함`, async () => {
      teamTagRepository.count.mockResolvedValue(TEAM_TAG_MAX_PER_TEAM);

      const error = await create().catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'TEAM_TAG_LIMIT_EXCEEDED', status: 400 });
      expect(teamTagRepository.save).not.toHaveBeenCalled();
    });

    it('같은 팀에 대소문자 무시 같은 이름이 있으면 TEAM_TAG_DUPLICATE(409)', async () => {
      teamTagRepository.count.mockResolvedValue(1);
      const qb = mockTagQueries({ duplicateCount: 1 });

      const error = await create('BUG').catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'TEAM_TAG_DUPLICATE', status: 409 });
      expect(qb.andWhere).toHaveBeenCalledWith('UPPER(tag.tagName) = UPPER(:tagName)', { tagName: 'BUG' });
      expect(teamTagRepository.save).not.toHaveBeenCalled();
    });

    it('선검사를 통과한 동시 요청이 DB 유니크에 걸려도 같은 409로 변환해야 함', async () => {
      teamTagRepository.count.mockResolvedValue(1);
      mockTagQueries();
      teamTagRepository.save.mockRejectedValue(uniqueViolation());

      const error = await create().catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'TEAM_TAG_DUPLICATE', status: 409 });
    });
  });

  describe('updateTag', () => {
    const update = (dto: { tagName?: string; tagColor?: string }, { teamId = 7, tagId = 1 } = {}) =>
      service.updateTag({ teamId, tagId, userId: 3, dto });

    it('다른 팀의 태그면 TEAM_TAG_NOT_FOUND(404) — 존재를 드러내지 않는다', async () => {
      teamTagRepository.findOne.mockResolvedValue(createTeamTag({ teamId: 99 }));

      const error = await update({ tagName: '변경' }).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'TEAM_TAG_NOT_FOUND', status: 404 });
      expect(teamTagRepository.save).not.toHaveBeenCalled();
    });

    it('없는 태그면 TEAM_TAG_NOT_FOUND(404)', async () => {
      teamTagRepository.findOne.mockResolvedValue(null);

      await expect(update({ tagName: '변경' })).rejects.toMatchObject({ code: 'TEAM_TAG_NOT_FOUND', status: 404 });
    });

    it('이름 중복 검사는 자기 자신을 제외해야 함 (대소문자만 바꾸는 수정 허용)', async () => {
      teamTagRepository.findOne.mockResolvedValue(createTeamTag({ teamId: 7, tagId: 1, tagName: 'bug' }));
      const qb = mockTagQueries({ duplicateCount: 0 });
      teamTaskTagRepository.count.mockResolvedValue(4);

      const tag = await update({ tagName: 'Bug' });

      expect(qb.andWhere).toHaveBeenCalledWith('tag.tagId <> :excludeTagId', { excludeTagId: 1 });
      expect(tag).toMatchObject({ tagName: 'Bug', taskCount: 4 });
      expect((teamTagRepository.save.mock.calls[0][0] as TeamTag).mdfdAt).toBeInstanceOf(Date);
    });

    it('다른 태그와 이름이 겹치면 TEAM_TAG_DUPLICATE(409)', async () => {
      teamTagRepository.findOne.mockResolvedValue(createTeamTag({ teamId: 7, tagName: '원본' }));
      mockTagQueries({ duplicateCount: 1 });

      await expect(update({ tagName: '긴급' })).rejects.toMatchObject({ code: 'TEAM_TAG_DUPLICATE', status: 409 });
      expect(teamTagRepository.save).not.toHaveBeenCalled();
    });

    it('색만 바꾸면 이름 중복 검사를 하지 않아야 함', async () => {
      teamTagRepository.findOne.mockResolvedValue(createTeamTag({ teamId: 7 }));
      teamTaskTagRepository.count.mockResolvedValue(0);

      const tag = await update({ tagColor: '#34D399' });

      expect(teamTagRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(tag.tagColor).toBe('#34D399');
    });

    it('바뀐 것이 없으면 저장하지 않아야 함', async () => {
      teamTagRepository.findOne.mockResolvedValue(createTeamTag({ teamId: 7, tagName: '긴급', tagColor: '#F87171' }));
      teamTaskTagRepository.count.mockResolvedValue(0);

      await update({ tagName: '긴급', tagColor: '#F87171' });

      expect(teamTagRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('deleteTag', () => {
    it('이 팀의 태그만 하드 삭제해야 함 (연결은 FK CASCADE)', async () => {
      teamTagRepository.findOne.mockResolvedValue(createTeamTag({ teamId: 7, tagId: 4 }));

      await service.deleteTag({ teamId: 7, tagId: 4, userId: 3 });

      expect(teamTagRepository.delete).toHaveBeenCalledWith({ tagId: 4, teamId: 7 });
    });

    it('다른 팀의 태그면 404이고 삭제하지 않아야 함', async () => {
      teamTagRepository.findOne.mockResolvedValue(createTeamTag({ teamId: 99, tagId: 4 }));

      const error = await service.deleteTag({ teamId: 7, tagId: 4, userId: 3 }).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'TEAM_TAG_NOT_FOUND', status: 404 });
      expect(teamTagRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('reorderTags', () => {
    const current = () => [
      createTeamTag({ tagId: 1, sortOrder: 1 }),
      createTeamTag({ tagId: 2, sortOrder: 2 }),
      createTeamTag({ tagId: 3, sortOrder: 3 }),
    ];

    /** 트랜잭션 안에서 팀 태그 행을 잠그고 읽는 QueryBuilder (SELECT … FOR UPDATE) */
    let lockQb: ReturnType<typeof createMockQueryBuilder>;
    const mockLockedTags = (tags: TeamTag[]) => {
      const qb = createMockQueryBuilder({ getMany: tags });
      manager.createQueryBuilder.mockReturnValue(qb);
      return qb;
    };

    beforeEach(() => {
      teamTagRepository.find.mockResolvedValue([]);
    });

    it('기준선은 팀 태그 행을 잠그고 읽어야 함 (동시 재정렬 혼합 방지, row-limit 없는 FOR UPDATE)', async () => {
      lockQb = mockLockedTags(current());

      await service.reorderTags({ teamId: 7, userId: 3, tagIds: [2, 1, 3] });

      expect(manager.createQueryBuilder).toHaveBeenCalledWith(TeamTag, 'tag');
      expect(lockQb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(lockQb.where).toHaveBeenCalledWith('tag.teamId = :teamId', { teamId: 7 });
      // take/limit이 붙으면 Oracle이 FOR UPDATE를 거부한다(ORA-02014)
      expect(lockQb.take).not.toHaveBeenCalled();
      expect(lockQb.limit).not.toHaveBeenCalled();
      expect(lockQb.getMany.mock.invocationCallOrder[0]).toBeLessThan(manager.update.mock.invocationCallOrder[0]);
    });

    it.each([
      ['빠진 태그', [1, 2]],
      ['다른 팀·삭제된 태그', [1, 2, 9]],
      ['추가된 태그를 모름', [3, 1]],
    ])('요청이 현재 팀 태그 집합과 다르면(%s) TEAM_TAG_ORDER_CONFLICT(409)', async (_case, tagIds) => {
      lockQb = mockLockedTags(current());

      const error = await service.reorderTags({ teamId: 7, userId: 3, tagIds }).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'TEAM_TAG_ORDER_CONFLICT', status: 409 });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('순서가 바뀐 태그만 1부터 다시 매겨야 함', async () => {
      lockQb = mockLockedTags(current());

      await service.reorderTags({ teamId: 7, userId: 3, tagIds: [3, 2, 1] });

      // 2는 제자리(2번째)라 갱신하지 않는다
      expect(manager.update.mock.calls.map(([, where, values]) => ({ where, sortOrder: (values as TeamTag).sortOrder }))).toEqual([
        { where: { tagId: 3, teamId: 7 }, sortOrder: 1 },
        { where: { tagId: 1, teamId: 7 }, sortOrder: 3 },
      ]);
    });
  });
});

import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { TeamTag } from '../../entities/TeamTag';
import { TeamTaskTag } from '../../entities/TeamTaskTag';
import { TEAM_TAG_MAX_PER_TEAM } from '../../common/constants/app.constants';
import { TeamService } from './team.service';
import { CreateTeamTagDto, UpdateTeamTagDto } from './team-tag.dto';
import {
  TeamTagDuplicateErrorResponseDto,
  TeamTagLimitExceededErrorResponseDto,
  TeamTagNotFoundErrorResponseDto,
  TeamTagOrderConflictErrorResponseDto,
} from './team-error.dto';
import { isUniqueConstraintError } from './chat-read-cursor';

/** 팀 태그 응답 형태 (TeamTagDto) */
export type TeamTagView = {
  tagId: number;
  tagName: string;
  tagColor: string;
  sortOrder: number;
  taskCount: number;
};

/**
 * 팀 태그 관리 — 생성·수정·삭제·재정렬·목록 (docs/tasks/team-task-tags D-003~D-007·D-014·D-017)
 *
 * 권한: 팀의 활성 멤버 누구나 (D-001). 역할 검사는 없다.
 * 태스크에 태그를 붙이는 일은 TeamService(태스크 생성·수정)가 `task-tags.ts`로 한다.
 */
@Injectable()
export class TeamTagService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(TeamTag)
    private readonly teamTagRepository: Repository<TeamTag>,
    @InjectRepository(TeamTaskTag)
    private readonly teamTaskTagRepository: Repository<TeamTaskTag>,
    private readonly teamService: TeamService,
  ) {}

  /** 팀 태그 목록 (sortOrder, tagId 오름차순 + 사용 수) */
  async getTags(teamId: number, userId: number): Promise<TeamTagView[]> {
    await this.teamService.verifyTeamMemberAccess(teamId, userId);
    return this.findTeamTags(teamId);
  }

  async createTag({
    teamId,
    userId,
    dto,
  }: {
    teamId: number;
    userId: number;
    dto: CreateTeamTagDto;
  }): Promise<TeamTagView> {
    await this.teamService.verifyTeamMemberAccess(teamId, userId);

    // 동시 생성 경쟁으로 1~2개 넘칠 수 있으나 남용 방지용 상한이라 락 없이 수용한다 (D-014)
    const tagCount = await this.teamTagRepository.count({ where: { teamId } });
    if (tagCount >= TEAM_TAG_MAX_PER_TEAM) {
      throw new TeamTagLimitExceededErrorResponseDto();
    }

    await this.assertTagNameAvailable(teamId, dto.tagName);

    const tag = this.teamTagRepository.create({
      teamId,
      tagName: dto.tagName,
      tagColor: dto.tagColor,
      sortOrder: (await this.findMaxSortOrder(teamId)) + 1,
      crtdBy: userId,
      mdfdAt: null,
    });
    const saved = await this.saveTag(tag);

    return toTeamTagView(saved, 0);
  }

  async updateTag({
    teamId,
    tagId,
    userId,
    dto,
  }: {
    teamId: number;
    tagId: number;
    userId: number;
    dto: UpdateTeamTagDto;
  }): Promise<TeamTagView> {
    await this.teamService.verifyTeamMemberAccess(teamId, userId);
    const tag = await this.findTeamTagOrThrow(teamId, tagId);

    let changed = false;
    if (dto.tagName != null && dto.tagName !== tag.tagName) {
      // 자기 자신은 제외 — "bug" → "Bug"처럼 대소문자만 바꾸는 수정은 허용
      await this.assertTagNameAvailable(teamId, dto.tagName, tagId);
      tag.tagName = dto.tagName;
      changed = true;
    }
    if (dto.tagColor != null && dto.tagColor !== tag.tagColor) {
      tag.tagColor = dto.tagColor;
      changed = true;
    }

    const result = changed ? await this.saveTag(Object.assign(tag, { mdfdAt: new Date() })) : tag;
    const taskCount = await this.teamTaskTagRepository.count({ where: { tagId } });
    return toTeamTagView(result, taskCount);
  }

  /** 하드 삭제 — 붙어 있던 태스크 연결은 FK CASCADE로 함께 사라진다 (D-004) */
  async deleteTag({ teamId, tagId, userId }: { teamId: number; tagId: number; userId: number }): Promise<void> {
    await this.teamService.verifyTeamMemberAccess(teamId, userId);
    await this.findTeamTagOrThrow(teamId, tagId);
    await this.teamTagRepository.delete({ tagId, teamId });
  }

  /**
   * 팀 전체 태그 순서를 tagIds 순서로 바꾼다 (D-017).
   *
   * tagIds가 현재 팀 태그 집합과 정확히 같아야 한다 — 그사이 누가 추가·삭제했으면 409로 거부해
   * "내가 보던 목록 기준"의 순서만 반영한다. 순서가 실제로 바뀐 태그만 갱신한다.
   */
  async reorderTags({
    teamId,
    userId,
    tagIds,
  }: {
    teamId: number;
    userId: number;
    tagIds: number[];
  }): Promise<TeamTagView[]> {
    await this.teamService.verifyTeamMemberAccess(teamId, userId);

    await this.dataSource.transaction(async (manager: EntityManager) => {
      // 팀 태그 행을 잠그고 읽는다 — 잠금 없이 읽으면 동시 재정렬 2건이 같은 기준선으로 "바뀐 행만" UPDATE해
      // 두 의도가 섞인 순서(+sortOrder 중복)가 남는다. 잠근 뒤 읽으면 앞 요청이 커밋한 결과가 기준선이 된다.
      // findOne/take를 쓰지 않는다 — Oracle은 row-limit 절과 FOR UPDATE를 함께 쓸 수 없다(ORA-02014)
      const currentTags = await manager
        .createQueryBuilder(TeamTag, 'tag')
        .setLock('pessimistic_write')
        .where('tag.teamId = :teamId', { teamId })
        .getMany();
      const currentIds = new Set(currentTags.map((tag) => tag.tagId));
      const sameSet = currentIds.size === tagIds.length && tagIds.every((id) => currentIds.has(id));
      if (!sameSet) {
        throw new TeamTagOrderConflictErrorResponseDto();
      }

      const sortOrderById = new Map(currentTags.map((tag) => [tag.tagId, tag.sortOrder]));
      const now = new Date();
      for (const [index, tagId] of tagIds.entries()) {
        const sortOrder = index + 1;
        if (sortOrderById.get(tagId) === sortOrder) continue;
        await manager.update(TeamTag, { tagId, teamId }, { sortOrder, mdfdAt: now });
      }
    });

    return this.findTeamTags(teamId);
  }

  // ===== 내부 헬퍼 =====

  private async findTeamTags(teamId: number): Promise<TeamTagView[]> {
    const tags = await this.teamTagRepository.find({
      where: { teamId },
      order: { sortOrder: 'ASC', tagId: 'ASC' },
    });
    if (tags.length === 0) return [];

    // 태그 수는 팀당 최대 100개라 IN 목록 상한(1000)에 걸리지 않는다
    const counts = await this.teamTaskTagRepository
      .createQueryBuilder('taskTag')
      .select('taskTag.tagId', 'tagId')
      .addSelect('COUNT(*)', 'taskCount')
      .where({ tagId: In(tags.map((tag) => tag.tagId)) })
      .groupBy('taskTag.tagId')
      .getRawMany<{ tagId: number | string; taskCount: number | string }>();
    const countByTagId = new Map(counts.map((row) => [Number(row.tagId), Number(row.taskCount)]));

    return tags.map((tag) => toTeamTagView(tag, countByTagId.get(tag.tagId) ?? 0));
  }

  /** 없는 태그와 다른 팀 태그를 구분하지 않는다 — 다른 팀 태그의 존재를 드러내지 않는다 */
  private async findTeamTagOrThrow(teamId: number, tagId: number): Promise<TeamTag> {
    const tag = await this.teamTagRepository.findOne({ where: { tagId } });
    if (!tag || tag.teamId !== teamId) {
      throw new TeamTagNotFoundErrorResponseDto();
    }
    return tag;
  }

  /** 같은 팀에 대소문자 무시 같은 이름이 있으면 409 — DB 유니크 인덱스(UPPER)와 같은 기준 */
  private async assertTagNameAvailable(teamId: number, tagName: string, excludeTagId?: number): Promise<void> {
    const qb = this.teamTagRepository
      .createQueryBuilder('tag')
      .where('tag.teamId = :teamId', { teamId })
      .andWhere('UPPER(tag.tagName) = UPPER(:tagName)', { tagName });
    if (excludeTagId !== undefined) {
      qb.andWhere('tag.tagId <> :excludeTagId', { excludeTagId });
    }

    if ((await qb.getCount()) > 0) {
      throw new TeamTagDuplicateErrorResponseDto();
    }
  }

  private async findMaxSortOrder(teamId: number): Promise<number> {
    const row = await this.teamTagRepository
      .createQueryBuilder('tag')
      .select('MAX(tag.sortOrder)', 'maxSortOrder')
      .where('tag.teamId = :teamId', { teamId })
      .getRawOne<{ maxSortOrder: number | string | null }>();
    return Number(row?.maxSortOrder ?? 0);
  }

  /** 앱 선검사를 통과한 동시 요청은 DB 유니크 인덱스(UK_TEAM_TAGS_TEAM_NAME)가 막는다 → 같은 409로 변환 */
  private async saveTag(tag: TeamTag): Promise<TeamTag> {
    try {
      return await this.teamTagRepository.save(tag);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new TeamTagDuplicateErrorResponseDto();
      }
      throw error;
    }
  }
}

export function toTeamTagView(tag: TeamTag, taskCount: number): TeamTagView {
  return {
    tagId: tag.tagId,
    tagName: tag.tagName,
    tagColor: tag.tagColor,
    sortOrder: tag.sortOrder,
    taskCount,
  };
}

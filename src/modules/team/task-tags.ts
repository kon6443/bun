import { EntityManager, In, QueryFailedError } from 'typeorm';
import { TeamTag } from '../../entities/TeamTag';
import { TeamTaskTag } from '../../entities/TeamTaskTag';
import { TeamTaskBadRequestErrorResponseDto } from './team-error.dto';

/**
 * 태스크↔태그 연결 조작 — DI 없는 함수로 둔다 (docs/tasks/team-task-tags D-005).
 *
 * TeamService(태스크 생성·수정·조회)가 같은 트랜잭션 manager로 호출한다.
 * 태그 CRUD는 TeamTagService가 TeamService에 의존하므로, 반대 방향 의존을 서비스로 만들면 순환이 생긴다
 * (chat-read-cursor.ts와 같은 이유).
 */

/** 태스크에 붙은 태그 — 응답 `tags` 항목 */
export type TaskTagView = {
  tagId: number;
  tagName: string;
  tagColor: string;
};

/** Oracle IN 목록 상한(ORA-01795: 최대 1000개) */
const ORACLE_IN_LIST_MAX = 1000;

/**
 * 태스크별 태그 목록을 한 번에 조회한다 (팀 태그 정렬 순서).
 *
 * 태스크 목록 쿼리에 조인하면 행이 태그 수만큼 불어나므로 연결만 따로 읽어 붙인다 — 태스크 수와 무관하게
 * 1000개 단위로 쿼리 1회씩(N+1 아님). 태그가 없는 태스크는 Map에 키가 없다 → 호출 측이 `?? []`.
 */
export async function findTagsByTaskIds(
  manager: EntityManager,
  taskIds: number[],
): Promise<Map<number, TaskTagView[]>> {
  const tagsByTaskId = new Map<number, TaskTagView[]>();
  const uniqueTaskIds = [...new Set(taskIds)];

  for (let i = 0; i < uniqueTaskIds.length; i += ORACLE_IN_LIST_MAX) {
    const chunk = uniqueTaskIds.slice(i, i + ORACLE_IN_LIST_MAX);
    const links = await manager.find(TeamTaskTag, {
      where: { taskId: In(chunk) },
      relations: { tag: true },
      order: { tag: { sortOrder: 'ASC', tagId: 'ASC' } },
    });

    for (const { taskId, tag } of links) {
      const tags = tagsByTaskId.get(taskId) ?? [];
      tags.push({ tagId: tag.tagId, tagName: tag.tagName, tagColor: tag.tagColor });
      tagsByTaskId.set(taskId, tags);
    }
  }

  return tagsByTaskId;
}

/**
 * tagIds가 모두 이 팀의 태그인지 확인한다. 없는 태그·다른 팀 태그가 하나라도 있으면 400.
 *
 * 연결 테이블에는 팀 일치 제약이 없다(D-018) — 이 검증이 다른 팀 태그가 붙는 것을 막는 유일한 방어선이다.
 */
export async function assertTeamTagIds(
  manager: EntityManager,
  teamId: number,
  tagIds: number[],
): Promise<void> {
  if (tagIds.length === 0) return;

  const count = await manager.count(TeamTag, { where: { teamId, tagId: In(tagIds) } });
  if (count !== new Set(tagIds).size) {
    throw new TeamTaskBadRequestErrorResponseDto('태그가 해당 팀에 속하지 않거나 존재하지 않습니다.');
  }
}

/**
 * 태스크의 태그를 tagIds로 **전체 교체**한다 (`[]`이면 모두 제거). 트랜잭션 manager로 호출한다.
 */
export async function replaceTaskTags(
  manager: EntityManager,
  taskId: number,
  tagIds: number[],
): Promise<void> {
  await manager.delete(TeamTaskTag, { taskId });

  // 다건 INSERT는 Oracle에서 `SELECT … FROM DUAL UNION ALL` 형태가 되어 DEFAULT 컬럼(CRTD_AT) 처리가 불안정하다 —
  // 태스크당 최대 10개라 단건으로 넣는다
  for (const tagId of tagIds) {
    try {
      await manager.insert(TeamTaskTag, { taskId, tagId });
    } catch (error) {
      // assertTeamTagIds 직후 다른 요청이 태그를 삭제·커밋하면 FK 위반이 난다 — 500 대신 같은 400으로 안내한다
      if (isForeignKeyViolation(error)) {
        throw new TeamTaskBadRequestErrorResponseDto('태그가 삭제되었습니다. 태그 목록을 새로고침한 뒤 다시 시도해 주세요.');
      }
      throw error;
    }
  }
}

/** ORA-02291: 부모 키 없음(참조 무결성 위반) */
function isForeignKeyViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as { errorNum?: number } | undefined;
  return driverError?.errorNum === 2291;
}

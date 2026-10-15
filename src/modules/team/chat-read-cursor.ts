import { EntityManager, LessThan, QueryFailedError } from 'typeorm';
import { TeamChatMessage } from '../../entities/TeamChatMessage';
import { TeamChatReadCursor } from '../../entities/TeamChatReadCursor';

/**
 * 읽음 커서 조작 — DI 없는 함수로 둔다.
 *
 * TeamService(초대 수락 트랜잭션)와 TeamChatService(전송·읽음) 양쪽이 같은 트랜잭션 manager로 호출한다.
 * 서비스로 만들면 TeamChatService → TeamService → TeamChatService 순환 의존이 생긴다.
 */

/** Oracle 유니크 제약 위반(ORA-00001) 여부 */
export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as { errorNum?: number } | undefined;
  return driverError?.errorNum === 1;
}

/**
 * 커서를 messageId로 전진시킨다. **절대 뒤로 가지 않는다** — 현재 값보다 클 때만 갱신.
 *
 * 순서가 뒤바뀐 요청(탭 2개, 지연 도착)이 와도 조건부 UPDATE가 작은 값을 무시하므로
 * 별도 락 없이 안전하다. 행이 없으면 INSERT하고, 동시 INSERT 경합(ORA-00001)이면 UPDATE를 한 번 더 시도한다.
 * Oracle은 문장 단위 롤백이라 유니크 위반 후에도 트랜잭션을 계속 쓸 수 있다.
 *
 * @returns 실제로 전진했으면 true (브로드캐스트 여부 판단용)
 */
export async function advanceReadCursor(
  manager: EntityManager,
  teamId: number,
  userId: number,
  messageId: number,
): Promise<boolean> {
  if (messageId <= 0) return false;

  const tryUpdate = async (): Promise<boolean> => {
    const result = await manager.update(
      TeamChatReadCursor,
      { teamId, userId, lastReadMessageId: LessThan(messageId) },
      { lastReadMessageId: messageId, updatedAt: new Date() },
    );
    return (result.affected ?? 0) > 0;
  };

  if (await tryUpdate()) return true;

  // 0행 갱신 = "이미 같거나 더 앞" 또는 "행 없음" — 후자만 INSERT
  if (await manager.existsBy(TeamChatReadCursor, { teamId, userId })) return false;

  try {
    await manager.insert(TeamChatReadCursor, {
      teamId,
      userId,
      lastReadMessageId: messageId,
      updatedAt: new Date(),
    });
    return true;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // 같은 순간 다른 요청이 먼저 행을 만들었다 — 그 값보다 크면 전진
    return tryUpdate();
  }
}

/** 팀의 최신 메시지 ID (메시지가 없으면 0) */
export async function findLatestMessageId(manager: EntityManager, teamId: number): Promise<number> {
  const raw = await manager
    .createQueryBuilder(TeamChatMessage, 'm')
    .select('MAX(m.messageId)', 'maxId')
    .where('m.teamId = :teamId', { teamId })
    .getRawOne<{ maxId: number | null }>();
  return Number(raw?.maxId ?? 0);
}

/**
 * 가입·재가입 시 커서를 팀의 최신 메시지로 맞춘다 (D-004).
 *
 * 이전 대화는 볼 수 있지만 안읽음으로 세지 않는다. 이걸 빼면 가입 즉시 과거 메시지 전체가
 * 안읽음 배지로 뜨고, 기존 메시지의 "안 읽은 인원"이 1씩 늘어난다.
 */
export async function initReadCursorAtLatest(
  manager: EntityManager,
  teamId: number,
  userId: number,
): Promise<void> {
  const latestId = await findLatestMessageId(manager, teamId);
  await advanceReadCursor(manager, teamId, userId, latestId);
}

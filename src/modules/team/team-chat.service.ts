import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Redis } from 'ioredis';
import { TeamChatMessage } from '../../entities/TeamChatMessage';
import { TeamChatReadCursor } from '../../entities/TeamChatReadCursor';
import { TeamMember } from '../../entities/TeamMember';
import { ActStatus } from '../../common/enums/task-status.enum';
import { getDisplayName } from '../../common/utils/user.utils';
import {
  CHAT_HISTORY_DEFAULT_LIMIT,
  CHAT_RATE_LIMITS,
  ChatRateLimitAction,
} from '../../common/constants/chat.constants';
import { TeamService } from './team.service';
import { TeamChatBadRequestErrorResponseDto } from './team-error.dto';
import { ChatReceivedPayload } from './team.events';
import { ChatMessagesDto, ChatReadStateDto, GetChatMessagesQueryDto } from './team-chat.dto';
import { advanceReadCursor, findLatestMessageId, isUniqueConstraintError } from './chat-read-cursor';

/**
 * 팀 채팅 — 저장·이력·읽음 커서·안읽음 수 (docs/tasks/team-chat-persistence)
 *
 * 원본은 Oracle이다. 메시지는 전송 즉시 DB에 COMMIT한 뒤 방에 뿌린다(D-020 — Redis 버퍼 없음).
 * Redis는 레이트 리밋 카운터에만 쓴다:
 * - chat:rl:{send|read}:{userId} → INCR 카운터 (TTL = 윈도 초, 첫 INCR 때만 설정, 모든 팀 합산)
 */
@Injectable()
export class TeamChatService {
  private readonly logger = new Logger(TeamChatService.name);
  private redis?: Redis;

  constructor(
    @InjectRepository(TeamChatMessage)
    private readonly messageRepository: Repository<TeamChatMessage>,
    @InjectRepository(TeamMember)
    private readonly teamMemberRepository: Repository<TeamMember>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly teamService: TeamService,
  ) {}

  /**
   * main.ts에서 RedisIoAdapter 초기화 후 호출 (OnlineUserService와 같은 방식)
   */
  setRedisClient(client: Redis): void {
    this.redis = client;
  }

  /**
   * 고정 윈도 레이트 리밋. 한도 안이면 true.
   *
   * Redis가 없거나 오류면 **통과**시킨다(D-007) — 보조 방어선 때문에 채팅 전체를 막지 않는다.
   */
  async consumeRateLimit(action: ChatRateLimitAction, teamId: number, userId: number): Promise<boolean> {
    // 어댑터 클라이언트는 maxRetriesPerRequest: null(redis-adapter 필수)이라 끊긴 동안 명령이 무한 대기한다.
    // ready가 아니면 묻지 않고 통과시켜 채팅 전송이 Redis 장애에 묶이지 않게 한다.
    if (this.redis?.status !== 'ready') return true;

    const { limit, windowSec } = CHAT_RATE_LIMITS[action];
    // 사용자 단위로 센다 — 팀 단위면 여러 팀 방을 돌며 한도를 N배로 쓸 수 있다. teamId는 로그 맥락용
    const key = `chat:rl:${action}:${userId}`;
    try {
      // MULTI로 묶어 INCR과 TTL 설정 사이에 키가 TTL 없이 남는 일을 막는다. NX: 윈도 시작 때만 TTL 설정
      const results = await this.redis.multi().incr(key).expire(key, windowSec, 'NX').exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      return count <= limit;
    } catch (error) {
      this.logger.warn(
        `채팅 레이트 리밋 확인 실패 — 제한 없이 통과: action=${action}, teamId=${teamId}, userId=${userId}`,
        error instanceof Error ? error.stack : undefined,
      );
      return true;
    }
  }

  /**
   * 메시지 저장. 보낸 사람의 커서도 같은 트랜잭션에서 이 메시지로 올린다(보낸 사람 = 읽음).
   *
   * 같은 clientMsgId로 다시 보내면(재전송) 새로 저장하지 않고 기존 메시지를 돌려준다 — 유니크 제약 기반 멱등.
   * @throws TeamForbiddenErrorResponseDto 활성 멤버가 아니면 (추방 후 살아 있는 소켓 차단, D-006)
   */
  async sendMessage({
    teamId,
    userId,
    content,
    clientMsgId,
  }: {
    teamId: number;
    userId: number;
    content: string;
    clientMsgId: string;
  }): Promise<TeamChatMessage> {
    await this.teamService.verifyTeamMemberAccess(teamId, userId);

    return this.dataSource.transaction(async (manager) => {
      let saved: TeamChatMessage;
      try {
        saved = await manager.save(
          TeamChatMessage,
          manager.create(TeamChatMessage, {
            teamId,
            userId,
            content,
            clientMsgId,
            status: ActStatus.ACTIVE,
            // DB 기본값에 맡기지 않는다 — 브로드캐스트 timestamp와 저장값을 같게 하고 RETURNING 의존을 없앤다
            crtdAt: new Date(),
          }),
        );
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        // 재전송 — 이미 저장된 메시지를 그대로 돌려준다. 커서는 첫 저장 때 이미 올라갔다
        return manager.findOneByOrFail(TeamChatMessage, { teamId, userId, clientMsgId });
      }

      await advanceReadCursor(manager, teamId, userId, saved.messageId);
      return saved;
    });
  }

  /**
   * 이력 조회 (keyset). beforeId·afterId는 미포함이고, 결과는 항상 오래된 것부터 정렬한다.
   * 둘 다 없으면 최신 limit개.
   */
  async getMessages(teamId: number, userId: number, query: GetChatMessagesQueryDto): Promise<ChatMessagesDto> {
    const { beforeId, afterId } = query;
    if (beforeId && afterId) {
      throw new TeamChatBadRequestErrorResponseDto('beforeId와 afterId는 함께 쓸 수 없습니다.');
    }

    await this.teamService.verifyTeamMemberAccess(teamId, userId);

    const limit = query.limit ?? CHAT_HISTORY_DEFAULT_LIMIT;
    const ascending = !!afterId;

    const qb = this.messageRepository
      .createQueryBuilder('m')
      .innerJoin('m.user', 'u')
      .select(['m.messageId', 'm.teamId', 'm.userId', 'm.content', 'm.clientMsgId', 'm.crtdAt', 'u.userId', 'u.userName'])
      .where('m.teamId = :teamId', { teamId })
      .andWhere('m.status = :active', { active: ActStatus.ACTIVE });

    if (afterId) qb.andWhere('m.messageId > :afterId', { afterId });
    if (beforeId) qb.andWhere('m.messageId < :beforeId', { beforeId });

    // limit + 1개를 읽어 한 개가 더 있으면 hasMore. ManyToOne 조인이라 행이 늘지 않아 limit을 그대로 쓴다
    const rows = await qb
      .orderBy('m.messageId', ascending ? 'ASC' : 'DESC')
      .limit(limit + 1)
      .getMany();

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    if (!ascending) page.reverse();

    return {
      messages: page.map((m) => toChatMessageView(m, m.user?.userName)),
      hasMore,
    };
  }

  /**
   * 읽음 상태 — 활성 멤버(본인 포함)별 커서, 내 안읽음 수, 팀 최신 메시지 ID
   */
  async getReadState(teamId: number, userId: number): Promise<ChatReadStateDto> {
    await this.teamService.verifyTeamMemberAccess(teamId, userId);

    const rows = await this.teamMemberRepository
      .createQueryBuilder('ut')
      .innerJoin('ut.user', 'u')
      .leftJoin(TeamChatReadCursor, 'c', 'c.teamId = ut.teamId AND c.userId = ut.userId')
      .select('ut.userId', 'userId')
      .addSelect('u.userName', 'userName')
      .addSelect('c.lastReadMessageId', 'lastReadMessageId')
      .where('ut.teamId = :teamId', { teamId })
      .andWhere('ut.actStatus = :active', { active: ActStatus.ACTIVE })
      .orderBy('ut.userId', 'ASC')
      .getRawMany<{ userId: number; userName: string | null; lastReadMessageId: number | null }>();

    // Oracle 결과는 Number()로 고정한다 — 계약상 JSON number (D-016)
    const members = rows.map((r) => ({
      userId: Number(r.userId),
      userName: getDisplayName(r.userName, Number(r.userId)),
      lastReadMessageId: Number(r.lastReadMessageId ?? 0),
    }));

    const myLastReadMessageId = members.find((m) => m.userId === userId)?.lastReadMessageId ?? 0;
    const [latestMessageId, unreadCounts] = await Promise.all([
      findLatestMessageId(this.dataSource.manager, teamId),
      this.getUnreadCounts(userId, [teamId]),
    ]);

    return {
      latestMessageId,
      myLastReadMessageId,
      myUnreadCount: unreadCounts.get(teamId) ?? 0,
      members,
    };
  }

  /**
   * 팀별 내 안읽음 수 — 내 커서 이후, 남이 보낸 활성 메시지 수. 안읽음이 없는 팀은 Map에 없다.
   *
   * (TEAM_ID, MESSAGE_ID) 인덱스 범위 스캔이라 팀 수만큼 짧은 구간만 읽는다.
   */
  async getUnreadCounts(userId: number, teamIds: number[]): Promise<Map<number, number>> {
    if (!teamIds.length) return new Map();

    const rows = await this.messageRepository
      .createQueryBuilder('m')
      .leftJoin(TeamChatReadCursor, 'c', 'c.teamId = m.teamId AND c.userId = :userId', { userId })
      .select('m.teamId', 'teamId')
      .addSelect('COUNT(*)', 'unreadCount')
      .where('m.teamId IN (:...teamIds)', { teamIds })
      .andWhere('m.messageId > COALESCE(c.lastReadMessageId, 0)')
      .andWhere('m.userId != :userId', { userId })
      .andWhere('m.status = :active', { active: ActStatus.ACTIVE })
      .groupBy('m.teamId')
      .getRawMany<{ teamId: number; unreadCount: number }>();

    return new Map(rows.map((r) => [Number(r.teamId), Number(r.unreadCount)]));
  }

  /**
   * 읽음 위치 갱신. 커서가 실제로 전진했으면 true(→ 브로드캐스트).
   *
   * 이 팀의 메시지가 아닌 ID는 반영하지 않는다 — 임의의 큰 값을 보내 앞으로 올 메시지까지
   * 읽음 처리해 버리는 것을 막는다.
   * @throws TeamForbiddenErrorResponseDto 활성 멤버가 아니면
   */
  async markRead(teamId: number, userId: number, lastReadMessageId: number): Promise<boolean> {
    await this.teamService.verifyTeamMemberAccess(teamId, userId);

    const exists = await this.messageRepository.existsBy({ teamId, messageId: lastReadMessageId });
    if (!exists) {
      this.logger.warn(`읽음 갱신 무시: 팀에 없는 메시지 teamId=${teamId}, userId=${userId}, messageId=${lastReadMessageId}`);
      return false;
    }

    return advanceReadCursor(this.dataSource.manager, teamId, userId, lastReadMessageId);
  }

  /** 멤버의 현재 커서 (행이 없으면 0) */
  async getReadCursor(teamId: number, userId: number): Promise<number> {
    const cursor = await this.dataSource.manager.findOneBy(TeamChatReadCursor, { teamId, userId });
    return Number(cursor?.lastReadMessageId ?? 0);
  }
}

/** 저장된 메시지 → 소켓·REST 공통 표현 */
export function toChatMessageView(message: TeamChatMessage, userName: string | null | undefined): ChatReceivedPayload {
  return {
    messageId: Number(message.messageId),
    clientMsgId: message.clientMsgId,
    teamId: Number(message.teamId),
    userId: Number(message.userId),
    userName: getDisplayName(userName, Number(message.userId)),
    message: message.content,
    timestamp: new Date(message.crtdAt).toISOString(),
  };
}

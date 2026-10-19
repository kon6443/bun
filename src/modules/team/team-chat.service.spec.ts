import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { Redis } from 'ioredis';
import { TeamChatService } from './team-chat.service';
import { TeamService } from './team.service';
import { TeamChatMessage } from '../../entities/TeamChatMessage';
import { TeamMember } from '../../entities/TeamMember';
import { ActStatus } from '../../common/enums/task-status.enum';
import { CHAT_RATE_LIMITS } from '../../common/constants/chat.constants';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { createTeamChatMessage, createTeamMemberView, createUser, FIXED_DATE } from '../../entities/__spec__/entity.factory';
import { TeamForbiddenErrorResponseDto } from './team-error.dto';
import { advanceReadCursor, findLatestMessageId } from './chat-read-cursor';

// 커서 SQL은 chat-read-cursor.spec.ts가 검증한다. 유니크 위반 판정은 실제 구현을 쓴다
jest.mock('./chat-read-cursor', () => ({
  ...jest.requireActual('./chat-read-cursor'),
  advanceReadCursor: jest.fn(),
  findLatestMessageId: jest.fn(),
}));
const advanceReadCursorMock = advanceReadCursor as jest.MockedFunction<typeof advanceReadCursor>;
const findLatestMessageIdMock = findLatestMessageId as jest.MockedFunction<typeof findLatestMessageId>;

const TEAM_ID = 7;
const USER_ID = 42;

/**
 * 채팅 원본은 Oracle이다(D-020). 여기서 고정하는 것:
 *  1. 저장 전에 멤버십을 다시 본다 — 추방된 소켓의 메시지가 영구히 남지 않게 (D-006)
 *  2. 같은 clientMsgId 재전송은 새로 저장하지 않는다 (멱등)
 *  3. 이력은 keyset, 응답은 항상 오래된 것부터 (D-016)
 *  4. 레이트 리밋은 Redis 장애 때 통과시킨다 (D-007 fail-open)
 */
describe('TeamChatService', () => {
  let service: TeamChatService;
  let messageRepository: MockRepository<TeamChatMessage> & { existsBy: jest.Mock };
  let teamMemberRepository: MockRepository<TeamMember>;
  let teamService: { verifyTeamMemberAccess: jest.Mock };
  let manager: { save: jest.Mock; create: jest.Mock; findOneByOrFail: jest.Mock; findOneBy: jest.Mock };

  beforeEach(async () => {
    advanceReadCursorMock.mockReset().mockResolvedValue(true);
    findLatestMessageIdMock.mockReset().mockResolvedValue(0);

    messageRepository = Object.assign(createMockRepository<TeamChatMessage>(), { existsBy: jest.fn() });
    teamMemberRepository = createMockRepository<TeamMember>();
    teamService = { verifyTeamMemberAccess: jest.fn().mockResolvedValue(createTeamMemberView()) };
    manager = {
      save: jest.fn((_entity, data) => Promise.resolve({ ...data, messageId: 101 })),
      create: jest.fn((_entity, data) => data),
      findOneByOrFail: jest.fn(),
      findOneBy: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamChatService,
        { provide: getRepositoryToken(TeamChatMessage), useValue: messageRepository },
        { provide: getRepositoryToken(TeamMember), useValue: teamMemberRepository },
        {
          provide: getDataSourceToken(),
          // 실제 트랜잭션 대신 콜백을 즉시 실행 — 저장과 커서 갱신이 같은 manager로 묶이는지 본다
          useValue: {
            transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) => cb(manager as unknown as EntityManager)),
            manager,
          } as unknown as DataSource,
        },
        { provide: TeamService, useValue: teamService },
      ],
    }).compile();

    service = module.get(TeamChatService);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('consumeRateLimit', () => {
    let exec: jest.Mock;
    let multi: { incr: jest.Mock; expire: jest.Mock; exec: jest.Mock };

    const useRedis = (status: string) => {
      exec = jest.fn();
      multi = { incr: jest.fn(() => multi), expire: jest.fn(() => multi), exec };
      service.setRedisClient({ status, multi: () => multi } as unknown as Redis);
    };

    it('Redis 클라이언트가 없으면 통과시켜야 함', async () => {
      await expect(service.consumeRateLimit('send', TEAM_ID, USER_ID)).resolves.toBe(true);
    });

    it('Redis가 ready가 아니면 명령을 보내지 않고 통과시켜야 함 (끊긴 동안 명령이 무한 대기하므로)', async () => {
      useRedis('reconnecting');

      await expect(service.consumeRateLimit('send', TEAM_ID, USER_ID)).resolves.toBe(true);
      expect(exec).not.toHaveBeenCalled();
    });

    it('유저·동작별 키에 INCR하고 윈도 시작 때만 TTL을 걸어야 함 (팀과 무관하게 합산)', async () => {
      useRedis('ready');
      exec.mockResolvedValue([[null, 1], [null, 1]]);

      await service.consumeRateLimit('send', TEAM_ID, USER_ID);

      expect(multi.incr).toHaveBeenCalledWith(`chat:rl:send:${USER_ID}`);
      expect(multi.expire).toHaveBeenCalledWith(`chat:rl:send:${USER_ID}`, CHAT_RATE_LIMITS.send.windowSec, 'NX');
    });

    it.each([
      [CHAT_RATE_LIMITS.send.limit, true],
      [CHAT_RATE_LIMITS.send.limit + 1, false],
    ])('윈도 안의 %d번째 요청은 %s여야 함', async (count, allowed) => {
      useRedis('ready');
      exec.mockResolvedValue([[null, count], [null, 0]]);

      await expect(service.consumeRateLimit('send', TEAM_ID, USER_ID)).resolves.toBe(allowed);
    });

    it('Redis 오류면 통과시켜야 함 (보조 방어선이 채팅 전체를 막으면 안 된다)', async () => {
      useRedis('ready');
      exec.mockRejectedValue(new Error('ECONNRESET'));

      await expect(service.consumeRateLimit('send', TEAM_ID, USER_ID)).resolves.toBe(true);
    });
  });

  describe('sendMessage', () => {
    const send = () =>
      service.sendMessage({ teamId: TEAM_ID, userId: USER_ID, content: '안녕하세요', clientMsgId: 'msg-1' });

    it('활성 멤버가 아니면 저장하지 않아야 함', async () => {
      teamService.verifyTeamMemberAccess.mockRejectedValue(new TeamForbiddenErrorResponseDto());

      await expect(send()).rejects.toMatchObject({ code: 'TEAM_FORBIDDEN', status: 403 });
      expect(teamService.verifyTeamMemberAccess).toHaveBeenCalledWith(TEAM_ID, USER_ID);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('메시지를 활성 상태로 저장하고 보낸 사람 커서를 같은 트랜잭션에서 올려야 함', async () => {
      const saved = await send();

      expect(manager.save).toHaveBeenCalledWith(
        TeamChatMessage,
        expect.objectContaining({
          teamId: TEAM_ID,
          userId: USER_ID,
          content: '안녕하세요',
          clientMsgId: 'msg-1',
          status: ActStatus.ACTIVE,
          crtdAt: expect.any(Date),
        }),
      );
      // 보낸 사람은 자기 메시지까지 읽은 것이다 — 빠지면 내 메시지의 숫자에 내가 들어간다
      expect(advanceReadCursorMock).toHaveBeenCalledWith(manager, TEAM_ID, USER_ID, 101);
      expect(saved.messageId).toBe(101);
    });

    it('같은 clientMsgId 재전송이면 기존 메시지를 돌려주고 커서를 다시 건드리지 않아야 함', async () => {
      const existing = createTeamChatMessage({ messageId: 99, clientMsgId: 'msg-1' });
      manager.save.mockRejectedValue(
        new QueryFailedError('INSERT', [], Object.assign(new Error('ORA-00001'), { errorNum: 1 })),
      );
      manager.findOneByOrFail.mockResolvedValue(existing);

      await expect(send()).resolves.toBe(existing);
      expect(manager.findOneByOrFail).toHaveBeenCalledWith(TeamChatMessage, {
        teamId: TEAM_ID,
        userId: USER_ID,
        clientMsgId: 'msg-1',
      });
      expect(advanceReadCursorMock).not.toHaveBeenCalled();
    });

    it('유니크 위반이 아닌 저장 오류는 그대로 던져야 함', async () => {
      manager.save.mockRejectedValue(new Error('ORA-03113'));

      await expect(send()).rejects.toThrow('ORA-03113');
    });
  });

  describe('getMessages', () => {
    const rows = (ids: number[]) =>
      ids.map((id) =>
        createTeamChatMessage({ messageId: id, teamId: TEAM_ID, user: createUser({ userName: '홍길동' }) }),
      );

    it('beforeId와 afterId를 함께 주면 400으로 거부해야 함', async () => {
      await expect(
        service.getMessages(TEAM_ID, USER_ID, { beforeId: 100, afterId: 90 }),
      ).rejects.toMatchObject({ code: 'TEAM_CHAT_BAD_REQUEST', status: 400 });
      expect(messageRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('팀 멤버가 아니면 조회하지 않아야 함', async () => {
      teamService.verifyTeamMemberAccess.mockRejectedValue(new TeamForbiddenErrorResponseDto());

      await expect(service.getMessages(TEAM_ID, USER_ID, {})).rejects.toMatchObject({ status: 403 });
      expect(messageRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('기본은 최신 limit개를 내림차순으로 읽어 오래된 것부터 돌려줘야 함', async () => {
      const qb = createMockQueryBuilder({ getMany: rows([105, 104, 103]) });
      messageRepository.createQueryBuilder.mockReturnValue(qb as never);

      const result = await service.getMessages(TEAM_ID, USER_ID, { limit: 2 });

      expect(qb.orderBy).toHaveBeenCalledWith('m.messageId', 'DESC');
      // limit + 1개를 읽어 하나 더 있으면 hasMore
      expect(qb.limit).toHaveBeenCalledWith(3);
      expect(result.hasMore).toBe(true);
      expect(result.messages.map((m) => m.messageId)).toEqual([104, 105]);
    });

    it('beforeId는 미포함 조건으로 걸어야 함', async () => {
      const qb = createMockQueryBuilder({ getMany: rows([100]) });
      messageRepository.createQueryBuilder.mockReturnValue(qb as never);

      const result = await service.getMessages(TEAM_ID, USER_ID, { beforeId: 101 });

      expect(qb.andWhere).toHaveBeenCalledWith('m.messageId < :beforeId', { beforeId: 101 });
      expect(result.hasMore).toBe(false);
    });

    it('afterId는 미포함·오름차순으로 읽어 그대로 돌려줘야 함 (재연결 빈 구간 채우기)', async () => {
      const qb = createMockQueryBuilder({ getMany: rows([121, 122]) });
      messageRepository.createQueryBuilder.mockReturnValue(qb as never);

      const result = await service.getMessages(TEAM_ID, USER_ID, { afterId: 120 });

      expect(qb.andWhere).toHaveBeenCalledWith('m.messageId > :afterId', { afterId: 120 });
      expect(qb.orderBy).toHaveBeenCalledWith('m.messageId', 'ASC');
      expect(result.messages.map((m) => m.messageId)).toEqual([121, 122]);
    });

    it('삭제(STATUS=0) 메시지는 조회 조건에서 빼야 함', async () => {
      const qb = createMockQueryBuilder({ getMany: [] });
      messageRepository.createQueryBuilder.mockReturnValue(qb as never);

      await service.getMessages(TEAM_ID, USER_ID, {});

      expect(qb.andWhere).toHaveBeenCalledWith('m.status = :active', { active: ActStatus.ACTIVE });
    });

    it('항목은 소켓 chatReceived와 같은 형태여야 함', async () => {
      messageRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ getMany: rows([101]) }) as never,
      );

      const { messages } = await service.getMessages(TEAM_ID, USER_ID, {});

      expect(messages[0]).toEqual({
        messageId: 101,
        clientMsgId: 'client-msg-1',
        teamId: TEAM_ID,
        userId: 1,
        userName: '홍길동',
        message: '테스트 메시지',
        timestamp: FIXED_DATE.toISOString(),
      });
    });
  });

  describe('getReadState', () => {
    it('활성 멤버별 커서·내 안읽음·최신 ID를 number로 돌려줘야 함', async () => {
      teamMemberRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getRawMany: [
            { userId: '1', userName: '김팀장', lastReadMessageId: '104' },
            { userId: USER_ID, userName: null, lastReadMessageId: null },
          ],
        }) as never,
      );
      messageRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ getRawMany: [{ teamId: TEAM_ID, unreadCount: '3' }] }) as never,
      );
      findLatestMessageIdMock.mockResolvedValue(104);

      await expect(service.getReadState(TEAM_ID, USER_ID)).resolves.toEqual({
        latestMessageId: 104,
        myLastReadMessageId: 0,
        myUnreadCount: 3,
        members: [
          { userId: 1, userName: '김팀장', lastReadMessageId: 104 },
          // 커서 행이 없으면 0, 이름이 없으면 기본 표시명
          { userId: USER_ID, userName: `사용자${USER_ID}`, lastReadMessageId: 0 },
        ],
      });
    });

    it('활성 멤버만 조회해야 함 (비활성 멤버는 안 읽은 인원에서 빠진다)', async () => {
      const qb = createMockQueryBuilder({ getRawMany: [] });
      teamMemberRepository.createQueryBuilder.mockReturnValue(qb as never);
      messageRepository.createQueryBuilder.mockReturnValue(createMockQueryBuilder() as never);

      await service.getReadState(TEAM_ID, USER_ID);

      expect(qb.andWhere).toHaveBeenCalledWith('ut.actStatus = :active', { active: ActStatus.ACTIVE });
    });
  });

  describe('getUnreadCounts', () => {
    it('팀이 없으면 쿼리하지 않아야 함', async () => {
      await expect(service.getUnreadCounts(USER_ID, [])).resolves.toEqual(new Map());
      expect(messageRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('내 커서 이후·남이 보낸 활성 메시지만 팀별로 세야 함', async () => {
      const qb = createMockQueryBuilder({ getRawMany: [{ teamId: '7', unreadCount: '2' }] });
      messageRepository.createQueryBuilder.mockReturnValue(qb as never);

      const counts = await service.getUnreadCounts(USER_ID, [7, 8]);

      expect(qb.andWhere).toHaveBeenCalledWith('m.messageId > COALESCE(c.lastReadMessageId, 0)');
      expect(qb.andWhere).toHaveBeenCalledWith('m.userId != :userId', { userId: USER_ID });
      expect(counts).toEqual(new Map([[7, 2]]));
    });
  });

  describe('markRead', () => {
    it('팀에 없는 메시지 ID면 커서를 올리지 않아야 함 (앞으로 올 메시지까지 읽음 처리 방지)', async () => {
      messageRepository.existsBy.mockResolvedValue(false);

      await expect(service.markRead(TEAM_ID, USER_ID, 999_999)).resolves.toBe(false);
      expect(messageRepository.existsBy).toHaveBeenCalledWith({ teamId: TEAM_ID, messageId: 999_999 });
      expect(advanceReadCursorMock).not.toHaveBeenCalled();
    });

    it('팀 메시지면 커서를 올리고 전진 여부를 돌려줘야 함', async () => {
      messageRepository.existsBy.mockResolvedValue(true);
      advanceReadCursorMock.mockResolvedValue(false);

      await expect(service.markRead(TEAM_ID, USER_ID, 104)).resolves.toBe(false);
      expect(advanceReadCursorMock).toHaveBeenCalledWith(manager, TEAM_ID, USER_ID, 104);
    });

    it('활성 멤버가 아니면 커서를 건드리지 않아야 함', async () => {
      teamService.verifyTeamMemberAccess.mockRejectedValue(new TeamForbiddenErrorResponseDto());

      await expect(service.markRead(TEAM_ID, USER_ID, 104)).rejects.toMatchObject({ status: 403 });
      expect(advanceReadCursorMock).not.toHaveBeenCalled();
    });
  });

  describe('getReadCursor', () => {
    it('행이 없으면 0이어야 함', async () => {
      manager.findOneBy.mockResolvedValue(null);

      await expect(service.getReadCursor(TEAM_ID, USER_ID)).resolves.toBe(0);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';
import { FeedbackService } from './feedback.service';
import { Feedback } from '../../entities/Feedback';
import { createFeedback } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { NOTIFICATION_PORT } from '../../common/port/notification.port';
import {
  FEEDBACK_DAILY_LIMIT,
  FEEDBACK_LIST_DEFAULT_LIMIT,
  FEEDBACK_USER_AGENT_MAX_LENGTH,
} from '../../common/constants/app.constants';
import { FeedbackNotFoundErrorResponseDto, FeedbackRateLimitedErrorResponseDto } from './feedback-error.dto';
import { CreateFeedbackDto } from './feedback.dto';

/**
 * FeedbackService — 사용자 피드백 (docs/tasks/feedback D-005·D-006·D-008).
 *
 * 핵심:
 *  1. 24시간 상한 — 상한에 닿으면 저장도 알림도 하지 않고 429.
 *  2. 본인 격리 — 목록·상세 조회 조건에 항상 userId가 들어가고, 남의 것은 404.
 *  3. 운영자 알림 — 저장된 값으로 피드백 채널에 한 번 알린다.
 */
describe('FeedbackService', () => {
  let service: FeedbackService;
  let feedbackRepository: MockRepository<Feedback>;
  let notificationPort: { notifyTeam: jest.Mock; notifyFeedbackChannel: jest.Mock };

  const DTO: CreateFeedbackDto = { category: 'BUG', title: '저장 안 됨', content: '저장을 눌러도 반영되지 않습니다.' };

  beforeEach(async () => {
    feedbackRepository = createMockRepository<Feedback>();
    notificationPort = { notifyTeam: jest.fn(), notifyFeedbackChannel: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeedbackService,
        { provide: getRepositoryToken(Feedback), useValue: feedbackRepository },
        { provide: NOTIFICATION_PORT, useValue: notificationPort },
      ],
    }).compile();

    service = module.get(FeedbackService);
    feedbackRepository.count.mockResolvedValue(0);
    feedbackRepository.create.mockImplementation((data) => data as Feedback);
    feedbackRepository.save.mockImplementation((entity) =>
      Promise.resolve(createFeedback({ ...(entity as Partial<Feedback>), feedbackId: 21 })),
    );
  });

  describe('createFeedback', () => {
    it('저장한 피드백을 상세 형태로 반환하고 상태는 RECEIVED여야 함', async () => {
      const result = await service.createFeedback({ userId: 7, userName: '홍길동', dto: { ...DTO, pagePath: '/teams/1' } });

      expect(feedbackRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 7, category: 'BUG', title: '저장 안 됨', status: 'RECEIVED', pagePath: '/teams/1' }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          feedbackId: 21,
          status: 'RECEIVED',
          hasReply: false,
          adminReply: null,
          repliedAt: null,
          pagePath: '/teams/1',
        }),
      );
      // 서버 메타(User-Agent)는 응답에 싣지 않는다
      expect(result).not.toHaveProperty('userAgent');
    });

    it('24시간 상한 조회는 작성자 기준·최근 24시간이어야 함', async () => {
      const before = Date.now();
      await service.createFeedback({ userId: 7, userName: null, dto: DTO });

      const [{ where }] = feedbackRepository.count.mock.calls[0] as [{ where: { userId: number; crtdAt: FindOperator<Date> } }];
      expect(where.userId).toBe(7);
      expect(where.crtdAt.type).toBe('moreThan');
      const since = (where.crtdAt.value as Date).getTime();
      expect(before - since).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
      expect(before - since).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
    });

    it(`최근 24시간 ${FEEDBACK_DAILY_LIMIT}건이면 429 FEEDBACK_RATE_LIMITED — 저장·알림 없음`, async () => {
      feedbackRepository.count.mockResolvedValue(FEEDBACK_DAILY_LIMIT);

      const error = await service.createFeedback({ userId: 7, userName: null, dto: DTO }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FeedbackRateLimitedErrorResponseDto);
      expect(error).toMatchObject({ code: 'FEEDBACK_RATE_LIMITED', status: 429 });
      expect(feedbackRepository.save).not.toHaveBeenCalled();
      expect(notificationPort.notifyFeedbackChannel).not.toHaveBeenCalled();
    });

    it(`상한 직전(${FEEDBACK_DAILY_LIMIT - 1}건)이면 저장해야 함`, async () => {
      feedbackRepository.count.mockResolvedValue(FEEDBACK_DAILY_LIMIT - 1);

      await service.createFeedback({ userId: 7, userName: null, dto: DTO });

      expect(feedbackRepository.save).toHaveBeenCalledTimes(1);
    });

    it(`User-Agent는 ${FEEDBACK_USER_AGENT_MAX_LENGTH}자로 잘라 저장하고, 없으면 null이어야 함`, async () => {
      await service.createFeedback({ userId: 7, userName: null, dto: DTO, userAgent: 'a'.repeat(FEEDBACK_USER_AGENT_MAX_LENGTH + 10) });
      await service.createFeedback({ userId: 7, userName: null, dto: DTO });

      const saved = feedbackRepository.create.mock.calls.map(([data]) => (data as Partial<Feedback>).userAgent);
      expect(saved[0]).toHaveLength(FEEDBACK_USER_AGENT_MAX_LENGTH);
      expect(saved[1]).toBeNull();
    });

    it('피드백 채널에 카테고리 표시명·제목·작성자·본문을 한 번 알려야 함', async () => {
      await service.createFeedback({ userId: 7, userName: '홍길동', dto: { ...DTO, pagePath: '/teams/1', buildSha: 'a1b2c3d' } });

      expect(notificationPort.notifyFeedbackChannel).toHaveBeenCalledTimes(1);
      expect(notificationPort.notifyFeedbackChannel).toHaveBeenCalledWith({
        title: '📮 새 피드백 · 버그 리포트',
        subject: '저장 안 됨',
        lines: ['#21 · 홍길동 (userId 7)', '화면: /teams/1', '빌드: a1b2c3d'],
        quote: '저장을 눌러도 반영되지 않습니다.',
      });
      expect(notificationPort.notifyTeam).not.toHaveBeenCalled();
    });

    it('알림의 화면 경로는 100자로 잘라야 함 (디스코드 2000자 한도 — 이스케이프로 최대 2배)', async () => {
      await service.createFeedback({ userId: 7, userName: '홍길동', dto: { ...DTO, pagePath: `/${'_'.repeat(499)}` } });

      const [{ lines }] = notificationPort.notifyFeedbackChannel.mock.calls[0] as [{ lines: string[] }];
      expect(lines[1]).toBe(`화면: /${'_'.repeat(99)}`);
      // 저장은 원본 그대로
      expect(feedbackRepository.create).toHaveBeenCalledWith(expect.objectContaining({ pagePath: `/${'_'.repeat(499)}` }));
    });
  });

  describe('getMyFeedbacks', () => {
    it('본인 것만 최신순으로 limit + 1개 읽고, 본문(CONTENT)은 읽지 않아야 함', async () => {
      feedbackRepository.find.mockResolvedValue([]);

      await service.getMyFeedbacks(7, {});

      const [options] = feedbackRepository.find.mock.calls[0] as [Record<string, unknown>];
      expect(options.where).toEqual({ userId: 7 });
      expect(options.order).toEqual({ feedbackId: 'DESC' });
      expect(options.take).toBe(FEEDBACK_LIST_DEFAULT_LIMIT + 1);
      expect(options.select).not.toHaveProperty('content');
    });

    it('beforeId가 있으면 그보다 작은 ID만 — userId 조건은 유지해야 함', async () => {
      feedbackRepository.find.mockResolvedValue([]);

      await service.getMyFeedbacks(7, { beforeId: 30, limit: 5 });

      const [options] = feedbackRepository.find.mock.calls[0] as [{ where: { userId: number; feedbackId: FindOperator<number> }; take: number }];
      expect(options.where.userId).toBe(7);
      expect(options.where.feedbackId.type).toBe('lessThan');
      expect(options.where.feedbackId.value).toBe(30);
      expect(options.take).toBe(6);
    });

    it('limit보다 하나 더 오면 hasMore=true, 초과분은 잘라야 함', async () => {
      feedbackRepository.find.mockResolvedValue([
        createFeedback({ feedbackId: 3 }),
        createFeedback({ feedbackId: 2, adminReply: '반영했습니다.' }),
        createFeedback({ feedbackId: 1 }),
      ]);

      const result = await service.getMyFeedbacks(7, { limit: 2 });

      expect(result.hasMore).toBe(true);
      expect(result.items.map((item) => item.feedbackId)).toEqual([3, 2]);
      expect(result.items.map((item) => item.hasReply)).toEqual([false, true]);
      expect(result.items[0]).not.toHaveProperty('adminReply');
    });

    it('limit 이하로 오면 hasMore=false', async () => {
      feedbackRepository.find.mockResolvedValue([createFeedback()]);

      const result = await service.getMyFeedbacks(7, { limit: 2 });

      expect(result.hasMore).toBe(false);
      expect(result.items).toHaveLength(1);
    });
  });

  describe('getMyFeedback', () => {
    it('본인 피드백이면 답변까지 상세로 반환해야 함', async () => {
      const repliedAt = new Date('2026-10-22T00:00:00.000Z');
      feedbackRepository.findOne.mockResolvedValue(
        createFeedback({ feedbackId: 5, userId: 7, status: 'DONE', adminReply: '반영했습니다.', repliedAt }),
      );

      const result = await service.getMyFeedback(7, 5);

      expect(feedbackRepository.findOne).toHaveBeenCalledWith({ where: { feedbackId: 5, userId: 7 } });
      expect(result).toEqual(expect.objectContaining({ feedbackId: 5, status: 'DONE', hasReply: true, adminReply: '반영했습니다.', repliedAt }));
    });

    it('없거나 남의 피드백이면 404 FEEDBACK_NOT_FOUND', async () => {
      feedbackRepository.findOne.mockResolvedValue(null);

      const error = await service.getMyFeedback(7, 5).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FeedbackNotFoundErrorResponseDto);
      expect(error).toMatchObject({ code: 'FEEDBACK_NOT_FOUND', status: 404 });
    });
  });
});

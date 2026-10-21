import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FeedbackController } from '../src/modules/feedback/feedback.controller';
import { FeedbackService } from '../src/modules/feedback/feedback.service';
import { Feedback } from '../src/entities/Feedback';
import { User } from '../src/entities/User';
import { NOTIFICATION_PORT } from '../src/common/port/notification.port';
import { FEEDBACK_LIST_MAX_LIMIT, FEEDBACK_TITLE_MAX_LENGTH } from '../src/common/constants/app.constants';
import { createFeedback, createUser } from '../src/entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

const AUTHOR = createUser({ userId: 42, userName: '작성자' });

/**
 * 피드백 REST를 HTTP 경계에서 검증한다 (docs/tasks/feedback DESIGN.md §2).
 *
 * 실제 FeedbackService를 태우고 Repository·알림 Port만 mock한다 — 인증 401, 전역 ValidationPipe(trim·
 * forbidNonWhitelisted), User-Agent 헤더 저장, 라우팅(`me` vs `:feedbackId`), 도메인 에러 → `{ code }` 변환을 본다.
 * 라우트 스로틀은 E2E가 CustomThrottlerGuard를 조립하지 않아 여기서 보지 않는다.
 */
describe('E2E 피드백', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let feedbackRepository: MockRepository<Feedback>;
  let notificationPort: { notifyTeam: jest.Mock; notifyFeedbackChannel: jest.Mock };

  const boot = async (authUser: User | undefined) => {
    e2e = await createE2eApp({
      controllers: [FeedbackController],
      authUser,
      providers: [
        FeedbackService,
        { provide: getRepositoryToken(Feedback), useValue: feedbackRepository },
        { provide: NOTIFICATION_PORT, useValue: notificationPort },
      ],
    });
    app = e2e.app;
  };

  beforeEach(async () => {
    feedbackRepository = createMockRepository<Feedback>();
    notificationPort = { notifyTeam: jest.fn(), notifyFeedbackChannel: jest.fn() };
    feedbackRepository.count.mockResolvedValue(0);
    feedbackRepository.create.mockImplementation((data) => data as Feedback);
    feedbackRepository.save.mockImplementation((entity) =>
      Promise.resolve(createFeedback({ ...(entity as Partial<Feedback>), feedbackId: 9 })),
    );
    await boot(AUTHOR);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /feedbacks', () => {
    const body = { category: 'FEATURE', title: '  마감 알림  ', content: '\n 마감 하루 전 알림이 있으면 좋겠어요 \n' };

    it('제목·내용을 trim해 201로 저장하고, User-Agent는 헤더에서 저장해야 함', async () => {
      const res = await request(app.getHttpServer())
        .post(e2e.url('/feedbacks'))
        .set('User-Agent', 'Mozilla/5.0 (E2E)')
        .send({ ...body, pagePath: '/teams/1', buildSha: 'a1b2c3d' })
        .expect(201);

      expect(feedbackRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 42,
          category: 'FEATURE',
          title: '마감 알림',
          content: '마감 하루 전 알림이 있으면 좋겠어요',
          pagePath: '/teams/1',
          buildSha: 'a1b2c3d',
          userAgent: 'Mozilla/5.0 (E2E)',
        }),
      );
      expect(res.body).toMatchObject({
        code: 'SUCCESS',
        data: { feedbackId: 9, category: 'FEATURE', title: '마감 알림', status: 'RECEIVED', hasReply: false },
      });
      expect(notificationPort.notifyFeedbackChannel).toHaveBeenCalledTimes(1);
    });

    it('비로그인이면 401 — 저장하지 않아야 함', async () => {
      await app.close();
      await boot(undefined);

      await request(app.getHttpServer()).post(e2e.url('/feedbacks')).send(body).expect(401);
      expect(feedbackRepository.save).not.toHaveBeenCalled();
    });

    it.each([
      ['정의 외 필드(userAgent)', { ...body, userAgent: 'spoofed' }],
      ['정의 외 카테고리', { ...body, category: 'PRAISE' }],
      ['공백만 있는 제목', { ...body, title: '   ' }],
      [`${FEEDBACK_TITLE_MAX_LENGTH + 1}자 제목`, { ...body, title: 'a'.repeat(FEEDBACK_TITLE_MAX_LENGTH + 1) }],
      ['내용 누락', { category: 'BUG', title: '제목' }],
      ['100자지만 600바이트인 제목(❤️ — DB VARCHAR2(400 BYTE) 초과)', { ...body, title: '❤️'.repeat(100) }],
      ["'/'로 시작하지 않는 pagePath", { ...body, pagePath: 'https://evil.test' }],
      ['500자지만 2000바이트를 넘는 pagePath(❤️ — DB VARCHAR2(2000 BYTE) 초과)', { ...body, pagePath: `/${'❤️'.repeat(499)}` }],
      ['hex가 아닌 buildSha', { ...body, buildSha: 'not-a-sha' }],
    ])('%s → 422 VALIDATION_ERROR', async (_name, payload) => {
      const res = await request(app.getHttpServer()).post(e2e.url('/feedbacks')).send(payload).expect(422);

      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(feedbackRepository.save).not.toHaveBeenCalled();
    });

    it('24시간 상한이면 429 FEEDBACK_RATE_LIMITED', async () => {
      feedbackRepository.count.mockResolvedValue(20);

      const res = await request(app.getHttpServer()).post(e2e.url('/feedbacks')).send(body).expect(429);

      expect(res.body.code).toBe('FEEDBACK_RATE_LIMITED');
    });
  });

  describe('GET /feedbacks/me', () => {
    it("'me'는 상세 라우트가 아닌 목록으로 가고, { items, hasMore }를 반환해야 함", async () => {
      feedbackRepository.find.mockResolvedValue([createFeedback({ feedbackId: 3, userId: 42 })]);

      const res = await request(app.getHttpServer()).get(e2e.url('/feedbacks/me?beforeId=10&limit=5')).expect(200);

      expect(res.body.data).toMatchObject({ items: [{ feedbackId: 3, hasReply: false }], hasMore: false });
      expect(feedbackRepository.find).toHaveBeenCalledWith(expect.objectContaining({ take: 6 }));
    });

    it(`limit ${FEEDBACK_LIST_MAX_LIMIT + 1}이면 422`, async () => {
      const res = await request(app.getHttpServer())
        .get(e2e.url(`/feedbacks/me?limit=${FEEDBACK_LIST_MAX_LIMIT + 1}`))
        .expect(422);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /feedbacks/:feedbackId', () => {
    it('본인 피드백이 아니면 404 FEEDBACK_NOT_FOUND — 조회 조건에 내 userId가 들어가야 함', async () => {
      feedbackRepository.findOne.mockResolvedValue(null);

      const res = await request(app.getHttpServer()).get(e2e.url('/feedbacks/5')).expect(404);

      expect(res.body.code).toBe('FEEDBACK_NOT_FOUND');
      expect(feedbackRepository.findOne).toHaveBeenCalledWith({ where: { feedbackId: 5, userId: 42 } });
    });

    it('본인 피드백이면 답변을 포함해 200', async () => {
      feedbackRepository.findOne.mockResolvedValue(
        createFeedback({ feedbackId: 5, userId: 42, status: 'DONE', adminReply: '반영했습니다.' }),
      );

      const res = await request(app.getHttpServer()).get(e2e.url('/feedbacks/5')).expect(200);

      expect(res.body.data).toMatchObject({ feedbackId: 5, status: 'DONE', hasReply: true, adminReply: '반영했습니다.' });
    });
  });
});

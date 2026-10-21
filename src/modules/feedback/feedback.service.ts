import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, MoreThan, Repository } from 'typeorm';
import { Feedback, FeedbackCategory } from '../../entities/Feedback';
import { INotificationPort, NOTIFICATION_PORT } from '../../common/port/notification.port';
import {
  FEEDBACK_DAILY_LIMIT,
  FEEDBACK_LIST_DEFAULT_LIMIT,
  FEEDBACK_USER_AGENT_MAX_LENGTH,
} from '../../common/constants/app.constants';
import { CreateFeedbackDto, FeedbackDetailDto, FeedbackListDto, FeedbackListItemDto, GetMyFeedbacksQueryDto } from './feedback.dto';
import { FeedbackNotFoundErrorResponseDto, FeedbackRateLimitedErrorResponseDto } from './feedback-error.dto';

/** 알림에 쓰는 카테고리 표시명 — 프론트 표시명과 같게 둔다 (D-003) */
const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  FEATURE: '기능 추가',
  BUG: '버그 리포트',
  IMPROVEMENT: '개선 요청',
  QUESTION: '문의',
  OTHER: '기타',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 알림 줄에 싣는 화면 경로 최대 길이 — 디스코드 본문 한도(2000자)를 지킨다.
 * 사용자 입력은 Markdown 이스케이프로 최대 2배가 되므로 500자 경로를 그대로 실으면 한도를 넘어 알림이 유실된다
 */
const NOTIFICATION_PAGE_PATH_MAX_LENGTH = 100;

/** 코드포인트 단위 절단 — 이모지·서로게이트 쌍을 반으로 자르지 않는다 */
const truncate = (text: string, max: number): string => Array.from(text).slice(0, max).join('');

/**
 * 사용자 피드백 (docs/tasks/feedback DESIGN.md)
 *
 * 작성자 본인만 조회하고(남의 ID는 404), 작성 후 수정·삭제하지 않는다.
 * 작성되면 운영자 피드백 채널(디스코드·텔레그램)에 알린다 — 상태·답변은 운영자가 SQL로 갱신한다.
 */
@Injectable()
export class FeedbackService {
  constructor(
    @InjectRepository(Feedback)
    private readonly feedbackRepository: Repository<Feedback>,
    @Inject(NOTIFICATION_PORT)
    private readonly notificationPort: INotificationPort,
  ) {}

  /**
   * 피드백 작성 — 사용자당 최근 24시간 상한(D-005)을 넘으면 429.
   * 카운트와 저장 사이의 동시 요청은 라우트 스로틀(초당 1건)이 막는다.
   */
  async createFeedback({
    userId,
    userName,
    dto,
    userAgent,
  }: {
    userId: number;
    userName: string | null;
    dto: CreateFeedbackDto;
    userAgent?: string;
  }): Promise<FeedbackDetailDto> {
    const recentCount = await this.feedbackRepository.count({
      where: { userId, crtdAt: MoreThan(new Date(Date.now() - DAY_MS)) },
    });
    if (recentCount >= FEEDBACK_DAILY_LIMIT) {
      throw new FeedbackRateLimitedErrorResponseDto();
    }

    // STATUS·CRTD_AT은 DB 기본값과 같은 값을 앱이 직접 넣는다 — 저장 후 응답에 기본값을 다시 읽어 오지 않아도 되게
    const saved = await this.feedbackRepository.save(
      this.feedbackRepository.create({
        userId,
        category: dto.category,
        title: dto.title,
        content: dto.content,
        status: 'RECEIVED',
        crtdAt: new Date(),
        pagePath: dto.pagePath ?? null,
        buildSha: dto.buildSha ?? null,
        userAgent: userAgent ? truncate(userAgent, FEEDBACK_USER_AGENT_MAX_LENGTH) : null,
      }),
    );

    this.notificationPort.notifyFeedbackChannel({
      title: `📮 새 피드백 · ${FEEDBACK_CATEGORY_LABELS[saved.category]}`,
      subject: saved.title,
      lines: [
        `#${saved.feedbackId} · ${userName ?? '이름 없음'} (userId ${userId})`,
        ...(saved.pagePath ? [`화면: ${truncate(saved.pagePath, NOTIFICATION_PAGE_PATH_MAX_LENGTH)}`] : []),
        ...(saved.buildSha ? [`빌드: ${saved.buildSha}`] : []),
      ],
      quote: saved.content,
    });

    return this.toDetail(saved);
  }

  /** 내 피드백 목록 (최신순 keyset) — limit + 1개를 읽어 한 개가 더 있으면 hasMore */
  async getMyFeedbacks(userId: number, query: GetMyFeedbacksQueryDto): Promise<FeedbackListDto> {
    const limit = query.limit ?? FEEDBACK_LIST_DEFAULT_LIMIT;
    const rows = await this.feedbackRepository.find({
      // 본문(CONTENT CLOB)은 목록에서 읽지 않는다. ADMIN_REPLY는 hasReply 판정용
      select: { feedbackId: true, category: true, title: true, status: true, adminReply: true, crtdAt: true },
      where: { userId, ...(query.beforeId && { feedbackId: LessThan(query.beforeId) }) },
      order: { feedbackId: 'DESC' },
      take: limit + 1,
    });

    return {
      items: rows.slice(0, limit).map((row) => this.toListItem(row)),
      hasMore: rows.length > limit,
    };
  }

  /** 내 피드백 상세 — 남의 피드백은 존재 여부를 드러내지 않도록 같은 404 (D-006) */
  async getMyFeedback(userId: number, feedbackId: number): Promise<FeedbackDetailDto> {
    const feedback = await this.feedbackRepository.findOne({ where: { feedbackId, userId } });
    if (!feedback) {
      throw new FeedbackNotFoundErrorResponseDto();
    }
    return this.toDetail(feedback);
  }

  private toListItem(feedback: Feedback): FeedbackListItemDto {
    return {
      feedbackId: feedback.feedbackId,
      category: feedback.category,
      title: feedback.title,
      status: feedback.status,
      hasReply: feedback.adminReply !== null && feedback.adminReply !== undefined,
      createdAt: feedback.crtdAt,
    };
  }

  private toDetail(feedback: Feedback): FeedbackDetailDto {
    return {
      ...this.toListItem(feedback),
      content: feedback.content,
      adminReply: feedback.adminReply ?? null,
      repliedAt: feedback.repliedAt ?? null,
      pagePath: feedback.pagePath ?? null,
    };
  }
}

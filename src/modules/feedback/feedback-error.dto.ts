/**
 * 피드백 도메인 에러 (docs/tasks/feedback DESIGN.md §2)
 */
import { defineDomainError } from '../../common/dto/define-domain-error';
import { FEEDBACK_DAILY_LIMIT } from '../../common/constants/app.constants';

/** 피드백을 찾을 수 없음 (404) — 남의 피드백도 존재를 드러내지 않도록 같은 404 (D-006) */
export const FeedbackNotFoundErrorResponseDto = defineDomainError({
  code: 'FEEDBACK_NOT_FOUND',
  status: 404,
  message: '피드백을 찾을 수 없습니다.',
});

/** 사용자당 24시간 작성 상한 초과 (429, D-005) — 라우트 스로틀의 TOO_MANY_REQUESTS와 구분된다 */
export const FeedbackRateLimitedErrorResponseDto = defineDomainError({
  code: 'FEEDBACK_RATE_LIMITED',
  status: 429,
  message: `피드백은 24시간에 ${FEEDBACK_DAILY_LIMIT}건까지 작성할 수 있습니다. 잠시 후 다시 시도해주세요.`,
});

import { Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCommonInternalServerErrorResponse,
  ApiCommonUnauthorizedResponse,
  ApiCommonValidationResponse,
} from '../../common/decorators/api-error-response.decorator';
import { THROTTLE_FEEDBACK_LONG, THROTTLE_FEEDBACK_SHORT } from '../../common/constants/throttle.constants';
import { FEEDBACK_DAILY_LIMIT } from '../../common/constants/app.constants';
import { User } from '../../entities/User';
import { FeedbackService } from './feedback.service';
import { CreateFeedbackDto, FeedbackDetailResponseDto, FeedbackListResponseDto, GetMyFeedbacksQueryDto } from './feedback.dto';
import { FeedbackNotFoundErrorResponseDto, FeedbackRateLimitedErrorResponseDto } from './feedback-error.dto';

/**
 * 사용자 피드백 REST (docs/tasks/feedback DESIGN.md §2)
 *
 * 로그인 유저만 작성·조회하고, 조회는 본인 것만 된다. 수정·삭제 라우트는 없다(D-009).
 */
@ApiTags('feedbacks')
@Controller('feedbacks')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  @Throttle({ short: THROTTLE_FEEDBACK_SHORT, long: THROTTLE_FEEDBACK_LONG }) // 초당 1회, 분당 3회
  @ApiOperation({
    summary: '피드백 작성',
    description: 'User-Agent는 서버가 요청 헤더에서 저장한다. 작성되면 운영자 피드백 채널(디스코드·텔레그램)에 알린다',
  })
  @ApiBody({ type: CreateFeedbackDto })
  @ApiResponse({ status: 201, description: 'SUCCESS', type: FeedbackDetailResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiCommonValidationResponse()
  // 429는 두 코드 — Swagger는 상태코드당 응답 하나만 남기므로(같은 키는 덮어씀) 한 항목에 둘 다 적는다
  @ApiResponse({
    status: 429,
    description: `FEEDBACK_RATE_LIMITED: 24시간 ${FEEDBACK_DAILY_LIMIT}건 초과 · TOO_MANY_REQUESTS: 라우트 스로틀(초당 1회 / 분당 3회) 초과`,
    type: FeedbackRateLimitedErrorResponseDto,
  })
  @ApiCommonInternalServerErrorResponse()
  async createFeedback(
    @CurrentUser() user: User,
    @Body() dto: CreateFeedbackDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    const data = await this.feedbackService.createFeedback({
      userId: user.userId,
      userName: user.userName,
      dto,
      userAgent,
    });
    return { code: 'SUCCESS', data, message: '' };
  }

  // 'me'는 ':feedbackId'(ParseIntPipe)보다 먼저 선언해야 숫자 변환 400에 걸리지 않는다
  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiOperation({ summary: '내 피드백 목록', description: '최신순 keyset 페이지. 다음 페이지는 마지막 feedbackId를 beforeId로 보낸다' })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: FeedbackListResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiCommonValidationResponse()
  @ApiCommonInternalServerErrorResponse()
  async getMyFeedbacks(@CurrentUser() user: User, @Query() query: GetMyFeedbacksQueryDto) {
    const data = await this.feedbackService.getMyFeedbacks(user.userId, query);
    return { code: 'SUCCESS', data, message: '' };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':feedbackId')
  @ApiOperation({ summary: '내 피드백 상세 (운영자 답변 포함)' })
  @ApiParam({ name: 'feedbackId', description: '피드백 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: FeedbackDetailResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 404, description: '피드백이 없거나 내 피드백이 아님', type: FeedbackNotFoundErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async getMyFeedback(@CurrentUser() user: User, @Param('feedbackId', ParseIntPipe) feedbackId: number) {
    const data = await this.feedbackService.getMyFeedback(user.userId, feedbackId);
    return { code: 'SUCCESS', data, message: '' };
  }
}

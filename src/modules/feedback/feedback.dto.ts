/**
 * 피드백 DTO (docs/tasks/feedback DESIGN.md §2)
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';
import { MaxByteLength } from '../../common/decorators/max-byte-length.decorator';
import {
  FEEDBACK_CONTENT_MAX_LENGTH,
  FEEDBACK_LIST_DEFAULT_LIMIT,
  FEEDBACK_LIST_MAX_LIMIT,
  FEEDBACK_PAGE_PATH_MAX_LENGTH,
  FEEDBACK_TITLE_MAX_LENGTH,
} from '../../common/constants/app.constants';
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUSES,
  type FeedbackCategory,
  type FeedbackStatus,
} from '../../entities/Feedback';

// 변환은 검증보다 먼저 돈다 — 공백만 있는 값은 trim 후 IsNotEmpty에 걸린다
const trimString = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** 프론트 빌드 커밋 SHA (짧은·전체 hex) */
const BUILD_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/** DB 컬럼 바이트 크기 — 글자 수 제한과 별도로 바이트 상한을 건다 (migrations/*-CreateFeedbacks.ts, MaxByteLength 주석) */
const TITLE_MAX_BYTES = 400;
const PAGE_PATH_MAX_BYTES = 2000;

// ==================== Request DTOs ====================

export class CreateFeedbackDto {
  @ApiProperty({
    description: '카테고리 — FEATURE 기능 추가 · BUG 버그 리포트 · IMPROVEMENT 개선 요청 · QUESTION 문의 · OTHER 기타',
    enum: FEEDBACK_CATEGORIES,
    example: 'BUG',
  })
  @IsIn(FEEDBACK_CATEGORIES, { message: `category는 ${FEEDBACK_CATEGORIES.join(', ')} 중 하나여야 합니다.` })
  category: FeedbackCategory;

  @ApiProperty({ description: `제목 (앞뒤 공백 제거 후 1~${FEEDBACK_TITLE_MAX_LENGTH}자)`, example: '저장 버튼이 반응하지 않아요' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'title은 비어 있을 수 없습니다.' })
  @MaxLength(FEEDBACK_TITLE_MAX_LENGTH, { message: `title은 ${FEEDBACK_TITLE_MAX_LENGTH}자 이하여야 합니다.` })
  @MaxByteLength(TITLE_MAX_BYTES, { message: '제목이 너무 깁니다. 이모지·특수문자를 줄여주세요.' })
  title: string;

  @ApiProperty({ description: `내용 (앞뒤 공백 제거 후 1~${FEEDBACK_CONTENT_MAX_LENGTH}자, 줄바꿈 보존)`, example: '태스크 수정 화면에서 저장을 눌러도 반영되지 않습니다.' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'content는 비어 있을 수 없습니다.' })
  @MaxLength(FEEDBACK_CONTENT_MAX_LENGTH, { message: `content는 ${FEEDBACK_CONTENT_MAX_LENGTH}자 이하여야 합니다.` })
  content: string;

  @ApiPropertyOptional({ description: `작성 직전 화면 경로 ('/'로 시작, ${FEEDBACK_PAGE_PATH_MAX_LENGTH}자 이하) — 프론트가 자동 첨부`, example: '/teams/1' })
  @IsOptional()
  @IsString()
  @Matches(/^\//, { message: "pagePath는 '/'로 시작해야 합니다." })
  @MaxLength(FEEDBACK_PAGE_PATH_MAX_LENGTH, { message: `pagePath는 ${FEEDBACK_PAGE_PATH_MAX_LENGTH}자 이하여야 합니다.` })
  @MaxByteLength(PAGE_PATH_MAX_BYTES)
  pagePath?: string;

  @ApiPropertyOptional({ description: '프론트 빌드 커밋 SHA (7~40자 hex) — 프론트가 자동 첨부', example: 'a1b2c3d' })
  @IsOptional()
  @IsString()
  @Matches(BUILD_SHA_PATTERN, { message: 'buildSha는 7~40자 16진수여야 합니다.' })
  buildSha?: string;
}

/** 내 목록 조회 — beforeId는 미포함(exclusive), 최신순 */
export class GetMyFeedbacksQueryDto {
  @ApiPropertyOptional({ description: '이 ID보다 이전 피드백 (미포함) — 직전 페이지의 마지막 feedbackId', example: 21 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  beforeId?: number;

  @ApiPropertyOptional({
    description: `페이지 크기 (1~${FEEDBACK_LIST_MAX_LIMIT}, 기본 ${FEEDBACK_LIST_DEFAULT_LIMIT})`,
    example: FEEDBACK_LIST_DEFAULT_LIMIT,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(FEEDBACK_LIST_MAX_LIMIT)
  limit?: number;
}

// ==================== Response DTOs ====================

export class FeedbackListItemDto {
  @ApiProperty({ description: '피드백 ID', example: 21 })
  feedbackId: number;

  @ApiProperty({ description: '카테고리', enum: FEEDBACK_CATEGORIES, example: 'BUG' })
  category: FeedbackCategory;

  @ApiProperty({ description: '제목', example: '저장 버튼이 반응하지 않아요' })
  title: string;

  @ApiProperty({
    description: '처리 상태 — RECEIVED 접수 · IN_PROGRESS 검토 중 · DONE 반영 완료 · REJECTED 반려',
    enum: FEEDBACK_STATUSES,
    example: 'RECEIVED',
  })
  status: FeedbackStatus;

  @ApiProperty({ description: '운영자 답변 유무', example: false })
  hasReply: boolean;

  @ApiProperty({ description: '작성 시각 (ISO, UTC)', example: '2026-10-21T06:00:00.000Z' })
  createdAt: Date;
}

export class FeedbackDetailDto extends FeedbackListItemDto {
  @ApiProperty({ description: '내용 (줄바꿈 보존, 마크다운 아님)', example: '태스크 수정 화면에서 저장을 눌러도 반영되지 않습니다.' })
  content: string;

  @ApiProperty({ description: '운영자 답변 — 없으면 null', type: String, nullable: true, example: null })
  adminReply: string | null;

  @ApiProperty({ description: '운영자 답변 시각 (ISO, UTC) — 없으면 null', type: Date, nullable: true, example: null })
  repliedAt: Date | null;

  @ApiProperty({ description: '작성 직전 화면 경로 — 없으면 null', type: String, nullable: true, example: '/teams/1' })
  pagePath: string | null;
}

export class FeedbackListDto {
  @ApiProperty({ description: '내 피드백 (최신순)', type: [FeedbackListItemDto] })
  items: FeedbackListItemDto[];

  @ApiProperty({ description: '더 이전 피드백이 있는지 — true면 마지막 feedbackId를 beforeId로 다시 요청', example: false })
  hasMore: boolean;
}

export class FeedbackDetailResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: FeedbackDetailDto })
  data: FeedbackDetailDto;
}

export class FeedbackListResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: FeedbackListDto })
  data: FeedbackListDto;
}

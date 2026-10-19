/**
 * 팀 태그 DTO (docs/tasks/team-task-tags DESIGN.md §2)
 *
 * 태스크 응답에 실리는 `TaskTagDto`도 여기 둔다 — team.dto.ts가 import한다.
 */
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';
import { TEAM_TAG_MAX_PER_TEAM, TEAM_TAG_NAME_MAX_LENGTH } from '../../common/constants/app.constants';

/** #RRGGBB (대소문자 무관 — 저장 전 대문자로 정규화) */
const TAG_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

// 변환은 검증보다 먼저 돈다 — 공백만 있는 이름은 trim 후 IsNotEmpty에 걸린다
const trimString = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toUpperString = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toUpperCase() : value);

// ==================== Request DTOs ====================

export class CreateTeamTagDto {
  @ApiProperty({ description: `태그 이름 (앞뒤 공백 제거 후 1~${TEAM_TAG_NAME_MAX_LENGTH}자, 팀 안에서 대소문자 무시 중복 불가)`, example: '긴급' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'tagName은 비어 있을 수 없습니다.' })
  @MaxLength(TEAM_TAG_NAME_MAX_LENGTH, { message: `tagName은 ${TEAM_TAG_NAME_MAX_LENGTH}자 이하여야 합니다.` })
  tagName: string;

  @ApiProperty({ description: '태그 색 (#RRGGBB, 서버가 대문자로 정규화)', example: '#F87171' })
  @Transform(toUpperString)
  @IsString()
  @Matches(TAG_COLOR_PATTERN, { message: 'tagColor는 #RRGGBB 형식이어야 합니다.' })
  tagColor: string;
}

export class UpdateTeamTagDto {
  @ApiProperty({ description: `태그 이름 (앞뒤 공백 제거 후 1~${TEAM_TAG_NAME_MAX_LENGTH}자)`, example: '긴급', required: false })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'tagName은 비어 있을 수 없습니다.' })
  @MaxLength(TEAM_TAG_NAME_MAX_LENGTH, { message: `tagName은 ${TEAM_TAG_NAME_MAX_LENGTH}자 이하여야 합니다.` })
  tagName?: string;

  @ApiProperty({ description: '태그 색 (#RRGGBB, 서버가 대문자로 정규화)', example: '#F87171', required: false })
  @Transform(toUpperString)
  @IsOptional()
  @IsString()
  @Matches(TAG_COLOR_PATTERN, { message: 'tagColor는 #RRGGBB 형식이어야 합니다.' })
  tagColor?: string;
}

export class ReorderTeamTagsDto {
  @ApiProperty({
    description: '팀의 **전체** 태그 ID를 원하는 순서로. 현재 팀 태그 집합과 다르면 409(TEAM_TAG_ORDER_CONFLICT)',
    example: [3, 1, 2],
    type: [Number],
  })
  @IsArray()
  @ArrayMaxSize(TEAM_TAG_MAX_PER_TEAM)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  tagIds: number[];
}

// ==================== Response DTOs ====================

/** 태스크에 붙은 태그 — 태스크 목록·상세·생성·수정 응답의 `tags` 항목 */
export class TaskTagDto {
  @ApiProperty({ description: '태그 ID', example: 1 })
  tagId: number;

  @ApiProperty({ description: '태그 이름', example: '긴급' })
  tagName: string;

  @ApiProperty({ description: '태그 색 (#RRGGBB 대문자)', example: '#F87171' })
  tagColor: string;
}

export class TeamTagDto extends TaskTagDto {
  @ApiProperty({ description: '팀 안 표시 순서 (오름차순, 빈 번호 가능 — 상대 순서만 의미)', example: 1 })
  sortOrder: number;

  @ApiProperty({ description: '이 태그가 붙은 태스크 수 (보관 태스크 포함) — 삭제 확인창용', example: 3 })
  taskCount: number;
}

export class TeamTagResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '태그', type: TeamTagDto })
  data: TeamTagDto;
}

export class TeamTagListResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '팀 태그 목록 (sortOrder, tagId 오름차순)', type: [TeamTagDto] })
  data: TeamTagDto[];
}

export class DeleteTeamTagResponseDto extends ApiSuccessResponseDto {}

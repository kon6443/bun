import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, Length, IsOptional, IsIn, IsInt, Min, Max } from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';
import { SKIN_MAX_LEVEL, SKIN_MIN_LEVEL, TETRIS_SKIN_SLOTS, type TetrisSkinSlot } from './skin-catalog';
import { POINT_HISTORY_DEFAULT_LIMIT, POINT_HISTORY_MAX_LIMIT, POINT_HISTORY_TYPES, type PointHistoryType } from './user-point.service';

// ==================== Request DTOs ====================

export class UpdateUserDto {
  @ApiProperty({
    description: '사용자 닉네임',
    example: '홍길동',
    minLength: 1,
    maxLength: 20,
  })
  @IsString({ message: '닉네임은 문자열이어야 합니다.' })
  @IsNotEmpty({ message: '닉네임은 필수 입력 항목입니다.' })
  @Length(1, 20, { message: '닉네임은 1자 이상 20자 이하여야 합니다.' })
  userName: string;
}

/** 슬롯 일부만 바꾼다 — 보낸 슬롯만 장착. 아이템 id 검사(카탈로그·보유)는 서비스가 한다 (docs/tasks/tetris-skins D-003) */
export class UpdateUserSkinsDto {
  @ApiPropertyOptional({ description: '블록 스킨 id', example: 'gameboy' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  block?: string;

  @ApiPropertyOptional({ description: '이펙트 스킨 id', example: 'neon' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  effect?: string;

  @ApiPropertyOptional({ description: '판 배경 스킨 id', example: 'default' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  board?: string;

  @ApiPropertyOptional({ description: '화면 배경 스킨 id', example: 'high-contrast' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  background?: string;
}

/** 한 단계 강화 — level은 목표 레벨(지금 레벨 + 1). 아이템 검사(카탈로그·보유)·포인트는 서비스가 본다 (docs/tasks/skin-levels D-002) */
export class UpgradeUserSkinDto {
  @ApiProperty({ description: '슬롯', enum: TETRIS_SKIN_SLOTS, example: 'block' })
  @IsIn(TETRIS_SKIN_SLOTS)
  slot: TetrisSkinSlot;

  @ApiProperty({ description: '아이템 id', example: 'chocolate' })
  @IsString()
  @Length(1, 64)
  skinId: string;

  @ApiProperty({ description: `목표 레벨 (${SKIN_MIN_LEVEL + 1}~${SKIN_MAX_LEVEL}) — 이미 그 레벨 이상이면 차감 없이 지금 상태`, example: 2 })
  @IsInt()
  @Min(SKIN_MIN_LEVEL + 1)
  @Max(SKIN_MAX_LEVEL)
  level: number;
}

/** 포인트 내역 조회 — 최신순 keyset (docs/tasks/skin-levels D-005) */
export class GetPointHistoryQueryDto {
  @ApiPropertyOptional({ description: '이 내역 id보다 이전 줄부터(미포함) — 앞 페이지 마지막 항목의 id', example: 61 })
  @IsOptional()
  @IsInt()
  @Min(1)
  beforeId?: number;

  @ApiPropertyOptional({ description: `개수 (기본 ${POINT_HISTORY_DEFAULT_LIMIT}, 최대 ${POINT_HISTORY_MAX_LIMIT})`, example: POINT_HISTORY_DEFAULT_LIMIT })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(POINT_HISTORY_MAX_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ description: '적립(earn)·사용(spend)만 — 생략하면 전체', enum: POINT_HISTORY_TYPES })
  @IsOptional()
  @IsIn(POINT_HISTORY_TYPES)
  type?: PointHistoryType;
}

// ==================== Response DTOs ====================

export class UserProfileDataDto {
  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId: number;

  @ApiProperty({ description: '사용자 닉네임', example: '홍길동' })
  userName: string;

  @ApiProperty({ description: '카카오 이메일', example: 'user@kakao.com', nullable: true })
  kakaoEmail: string | null;

  @ApiProperty({ description: '가입일', example: '2024-01-15T09:30:00.000Z' })
  createdDate: string;
}

export class UserProfileResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: UserProfileDataDto })
  data: UserProfileDataDto;
}

export class UpdateUserDataDto {
  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId: number;

  @ApiProperty({ description: '사용자 닉네임', example: '홍길동' })
  userName: string;
}

export class UpdateUserResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: UpdateUserDataDto })
  data: UpdateUserDataDto;
}

export class TetrisSkinSetDto {
  @ApiProperty({ description: '블록 스킨 id', example: 'default' }) block: string;
  @ApiProperty({ description: '이펙트 스킨 id', example: 'default' }) effect: string;
  @ApiProperty({ description: '판 배경 스킨 id', example: 'default' }) board: string;
  @ApiProperty({ description: '화면 배경 스킨 id', example: 'default' }) background: string;
}

export class SkinCatalogEntryDto {
  @ApiProperty({ description: '아이템 id', example: 'gameboy' }) id: string;
  @ApiProperty({ description: '획득 방식 — default(기본)·free(누구나). 업적·출석은 이후 추가', example: 'free' }) unlock: string;
  @ApiProperty({ description: '이 사용자가 장착할 수 있는지', example: true }) owned: boolean;
  @ApiProperty({ description: '이 사용자의 레벨 (1~5)', example: 1 }) level: number;
  @ApiProperty({ description: '한 단계 올리는 비용(포인트) — 만렙이면 null', example: 100000, nullable: true, type: Number }) nextCost: number | null;
}

export class TetrisSkinLevelsDto {
  @ApiProperty({ example: 1 }) block: number;
  @ApiProperty({ example: 1 }) effect: number;
  @ApiProperty({ example: 1 }) board: number;
  @ApiProperty({ example: 1 }) background: number;
}

/** 포인트 — 원장 합계. 적립 = 로그인 테트리스 기록(1점 = 1P)·보상, 잔액 = 적립 − 소비(0 미만이면 0) (docs/tasks/skin-levels D-004) */
export class UserPointsDto {
  @ApiProperty({ description: '적립 합계', example: 4222137 }) earned: number;
  @ApiProperty({ description: '소비 합계(양수)', example: 100000 }) spent: number;
  @ApiProperty({ description: '쓸 수 있는 포인트', example: 4122137 }) balance: number;
}

export class SkinCatalogDto {
  @ApiProperty({ type: [SkinCatalogEntryDto] }) block: SkinCatalogEntryDto[];
  @ApiProperty({ type: [SkinCatalogEntryDto] }) effect: SkinCatalogEntryDto[];
  @ApiProperty({ type: [SkinCatalogEntryDto] }) board: SkinCatalogEntryDto[];
  @ApiProperty({ type: [SkinCatalogEntryDto] }) background: SkinCatalogEntryDto[];
}

export class UserSkinsDataDto {
  @ApiProperty({ type: TetrisSkinSetDto, description: '슬롯별 장착 아이템 — 장착하지 않은 슬롯은 default' }) equipped: TetrisSkinSetDto;
  @ApiProperty({ type: TetrisSkinLevelsDto, description: '장착한 아이템의 레벨' }) equippedLevels: TetrisSkinLevelsDto;
  @ApiProperty({ type: UserPointsDto }) points: UserPointsDto;
  @ApiProperty({ type: SkinCatalogDto, description: '슬롯별 아이템 목록(서버 카탈로그 순서)과 보유 여부' }) catalog: SkinCatalogDto;
}

export class UserSkinsResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: UserSkinsDataDto })
  data: UserSkinsDataDto;
}

export class PointHistoryItemDto {
  @ApiProperty({ description: '내역 id — 다음 페이지 beforeId', example: 61 }) id: number;
  @ApiProperty({ description: '증감 — 적립·보상 양수, 소비 음수', example: -100000 }) amount: number;
  @ApiProperty({ description: '사유 — TETRIS_SCORE(게임 기록 적립)·SKIN_UPGRADE(스킨 강화). 이후 출석·이벤트 등이 늘 수 있다(모르는 값은 기타로)', example: 'SKIN_UPGRADE' })
  reason: string;
  @ApiProperty({ description: '사유별 대상 — TETRIS_SCORE는 기록 ID(리플레이 링크), SKIN_UPGRADE는 슬롯키:아이템:목표레벨', example: 'TETRIS_BLOCK:chocolate:2' })
  refKey: string;
  @ApiProperty({
    description: '구조화한 대상 — TETRIS_SCORE { scoreId }(리플레이 링크 — 숨김·공개 전이면 리플레이 API가 404), SKIN_UPGRADE { slot, skinId, level }. 그 밖·형식이 다르면 null',
    type: Object,
    nullable: true,
    example: { slot: 'block', skinId: 'chocolate', level: 2 },
  })
  meta: Record<string, unknown> | null;
  @ApiProperty({ description: '사람이 읽는 설명 — 화면 문구는 meta로 만들고 이것은 폴백', example: 'block chocolate Lv2 강화', nullable: true, type: String }) memo: string | null;
  @ApiProperty({ description: '기록 시각 (적립은 그 판 시각)', example: '2026-10-27T01:23:45.000Z' }) createdAt: Date;
}

export class PointHistoryDataDto {
  @ApiProperty({ type: UserPointsDto }) points: UserPointsDto;
  @ApiProperty({ type: [PointHistoryItemDto], description: '최신순' }) items: PointHistoryItemDto[];
  @ApiProperty({ description: '다음 페이지 beforeId — 끝이면 null', example: 35, nullable: true, type: Number }) nextCursor: number | null;
}

export class PointHistoryResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: PointHistoryDataDto })
  data: PointHistoryDataDto;
}

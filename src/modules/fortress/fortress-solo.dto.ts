import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';
import { MAP_IDS, MAX_ACTIONS, MAX_PLAYERS, MIN_PLAYERS, SEED_MAX } from './engine';

/** AI 난이도 — 0 하 · 1 중 · 2 상 (프론트 AI 레벨과 같은 값). 표시 이름에만 쓴다(검증은 행동 목록으로) */
export const SOLO_AI_LEVELS = [0, 1, 2] as const;
export type SoloAiLevel = (typeof SOLO_AI_LEVELS)[number];

export class SoloPlayerConfigDto {
  @ApiProperty({ description: '엔진 slot — 인원이 n이면 0..n−1이 한 번씩(서버가 확인, 아니면 422 CONFIG)', example: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_PLAYERS - 1)
  slot: number;

  @ApiProperty({ description: 'team 모드 0|1, ffa는 엔진이 무시(0)', example: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_PLAYERS - 1)
  team: number;

  @ApiProperty({ description: '탱크 종류 (엔진 TANKS 인덱스 — 범위는 엔진이 판정)', example: 0 })
  @IsInt()
  @Min(0)
  tankId: number;
}

export class SoloMatchConfigDto {
  @ApiProperty({ example: 12345 })
  @IsInt()
  @Min(0)
  @Max(SEED_MAX)
  seed: number;

  @ApiProperty({ enum: MAP_IDS, example: 'hills' })
  @IsIn(MAP_IDS)
  mapId: (typeof MAP_IDS)[number];

  @ApiProperty({ enum: ['ffa', 'team'] })
  @IsIn(['ffa', 'team'])
  mode: 'ffa' | 'team';

  @ApiProperty({ type: [SoloPlayerConfigDto] })
  @IsArray()
  @ArrayMinSize(MIN_PLAYERS)
  @ArrayMaxSize(MAX_PLAYERS)
  @ValidateNested({ each: true })
  @Type(() => SoloPlayerConfigDto)
  players: SoloPlayerConfigDto[];
}

export class SoloSlotDto {
  @ApiProperty({ example: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_PLAYERS - 1)
  slot: number;

  @ApiProperty({ enum: ['human', 'ai'], description: '사람 · AI' })
  @IsIn(['human', 'ai'])
  kind: 'human' | 'ai';

  @ApiPropertyOptional({ enum: SOLO_AI_LEVELS, description: 'AI 난이도 (kind ai만) — 0 하 · 1 중 · 2 상' })
  // @IsOptional은 null도 건너뛰어 null이 통과한다(리뷰 D1) — 키가 있으면(null 포함) 검사한다
  @ValidateIf((o: SoloSlotDto) => o.aiLevel !== undefined)
  @IsIn(SOLO_AI_LEVELS)
  aiLevel?: SoloAiLevel;
}

/**
 * AI전·같은 기기 대전 기록 업로드 (D-027) — 서버가 엔진으로 처음부터 다시 돌려 검증한 뒤 저장한다.
 * 이름·스킨은 받지 않는다(서버가 정한다): 사람 P{n}, AI P{n} (AI 하·중·상), 스킨은 로그인 사용자의 첫 사람 자리만 계정 장착, 나머지 기본
 */
export class UploadSoloMatchDto {
  @ApiProperty({ description: '경기를 돌린 엔진 버전 — 서버 엔진과 다르면 409', example: 2 })
  @IsInt()
  engineVersion: number;

  @ApiProperty({ type: SoloMatchConfigDto })
  @IsObject()
  @ValidateNested()
  @Type(() => SoloMatchConfigDto)
  config: SoloMatchConfigDto;

  @ApiProperty({
    description: `엔진 행동 목록 (최대 ${MAX_ACTIONS}) — {kind:'fire',move,angle,power,weaponId} | {kind:'skip'} | {kind:'resign',slot}. 판정은 엔진`,
    type: 'array',
    items: { type: 'object' },
  })
  @IsArray()
  @ArrayMaxSize(MAX_ACTIONS)
  actions: unknown[];

  @ApiProperty({ description: '마지막 행동 뒤 엔진 stateHash (8자 hex) — 서버 재시뮬레이션 결과와 대조', example: '1a2b3c4d' })
  @IsString()
  @Matches(/^[0-9a-f]{8}$/)
  stateHash: string;

  @ApiProperty({ type: [SoloSlotDto], description: '자리마다 사람·AI (config.players와 같은 slot 집합)' })
  @IsArray()
  @ArrayMinSize(MIN_PLAYERS)
  @ArrayMaxSize(MAX_PLAYERS)
  @ValidateNested({ each: true })
  @Type(() => SoloSlotDto)
  slots: SoloSlotDto[];
}

export class UploadSoloMatchResultDto {
  @ApiProperty({ description: '저장된 경기 ID — 기존 결과·리플레이 링크(/fortress/matches/:matchId)로 공유', example: 'AbCdEfGhIjKlMnOp' })
  @IsString()
  @MaxLength(16)
  matchId: string;
}

export class UploadSoloMatchResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: UploadSoloMatchResultDto })
  data: UploadSoloMatchResultDto;
}

/**
 * 게임 DTO (docs/tasks/games DESIGN.md §3·§4·§7)
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';
import {
  GAME_PLAYER_NAME_MAX_LENGTH,
  GAME_RANKING_DEFAULT_LIMIT,
  GAME_RANKING_MAX_LIMIT,
  GAME_REPLAY_MAX_FRAMES,
  GAME_REPLAY_MAX_INPUT_LENGTH,
} from '../../common/constants/app.constants';

/** 랭킹 기간 (D-004) — 일간·주간은 KST 경계 */
export const RANKING_PERIODS = ['daily', 'weekly', 'all'] as const;
export type RankingPeriod = (typeof RANKING_PERIODS)[number];

// 변환은 검증보다 먼저 돈다 — 앞뒤 공백 제거 + 연속 공백을 1개로
const normalizePlayerName = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

// ==================== Request DTOs ====================

/** 리플레이 본문 (DESIGN §4-1) — 점수는 받지 않는다. 범위·재현 가능 여부는 엔진이 최종 판정 */
export class ReplayDto {
  @ApiProperty({ description: '리플레이를 만든 엔진 버전 (세션과 같아야 함)', example: 1 })
  @IsInt()
  @Min(1)
  engineVersion: number;

  @ApiProperty({ description: 'DAS (프레임)', example: 10 })
  @IsInt()
  das: number;

  @ApiProperty({ description: 'ARR (프레임)', example: 2 })
  @IsInt()
  arr: number;

  @ApiProperty({ description: `게임 오버 프레임 (1~${GAME_REPLAY_MAX_FRAMES}, 60fps)`, example: 7200 })
  @IsInt()
  @Min(1)
  @Max(GAME_REPLAY_MAX_FRAMES)
  frames: number;

  @ApiProperty({
    description: `입력 로그 — [deltaFrame, actionCode, ...] 평탄 정수 배열 (길이 ${GAME_REPLAY_MAX_INPUT_LENGTH} 이하)`,
    example: [30, 2, 12, 3, 5, 8],
    type: [Number],
  })
  @IsArray()
  @ArrayMaxSize(GAME_REPLAY_MAX_INPUT_LENGTH)
  @IsInt({ each: true })
  inputs: number[];
}

export class SubmitGameScoreDto {
  @ApiProperty({ description: '게임 시작 시 발급받은 세션 ID', example: '3f1c2b9e-0a4d-4f7e-9a1b-2c3d4e5f6a7b' })
  @IsUUID('4')
  sessionId: string;

  @ApiProperty({
    description: `랭킹 표시 이름 — 앞뒤 공백 제거·연속 공백 1개로 정리 후 1~${GAME_PLAYER_NAME_MAX_LENGTH}자, 한글·영문·숫자·공백·_·- 만. 위반은 422 GAME_PLAYER_NAME_INVALID, 금칙어는 422 GAME_PLAYER_NAME_FORBIDDEN`,
    example: '테트리스왕',
  })
  // 형식·금칙어는 서비스가 판정한다(이름 전용 에러 코드) — player-name-policy.ts
  @Transform(normalizePlayerName)
  @IsString()
  playerName: string;

  @ApiProperty({ type: ReplayDto })
  // 값이 없으면 ValidateNested가 검증을 건너뛰고, 배열이면 원소 0개로 통과한다 — 세션을 소모하기 전에 막는다
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ReplayDto)
  replay: ReplayDto;
}

export class GetRankingsQueryDto {
  @ApiPropertyOptional({ description: '기간 — daily(KST 오늘)·weekly(KST 이번 주 월요일부터)·all', enum: RANKING_PERIODS, example: 'weekly' })
  @IsOptional()
  @IsIn(RANKING_PERIODS, { message: `period는 ${RANKING_PERIODS.join(', ')} 중 하나여야 합니다.` })
  period?: RankingPeriod;

  @ApiPropertyOptional({ description: `개수 (1~${GAME_RANKING_MAX_LIMIT}, 기본 ${GAME_RANKING_DEFAULT_LIMIT})`, example: GAME_RANKING_DEFAULT_LIMIT })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(GAME_RANKING_MAX_LIMIT)
  limit?: number;
}

// ==================== Response DTOs ====================

export class GameSessionDto {
  @ApiProperty({ description: '세션 ID (점수 제출 시 1회 사용)', example: '3f1c2b9e-0a4d-4f7e-9a1b-2c3d4e5f6a7b' })
  sessionId: string;

  @ApiProperty({ description: '블록 순서 시드 (0 ~ 4294967295)', example: 123456789 })
  seed: number;

  @ApiProperty({ description: '서버가 받는 엔진 버전', example: 1 })
  engineVersion: number;

  @ApiProperty({ description: '세션 만료 시각 (ISO, UTC)', example: '2026-10-21T08:00:00.000Z' })
  expiresAt: Date;
}

export class GameRanksDto {
  @ApiProperty({ example: 3 }) daily: number;
  @ApiProperty({ example: 12 }) weekly: number;
  @ApiProperty({ example: 120 }) all: number;
}

export class GameScoreSubmittedDto {
  @ApiProperty({ description: '기록 ID (리플레이 재생에 사용)', example: 41 })
  scoreId: number;

  @ApiProperty({ description: '서버가 리플레이로 계산한 점수', example: 12340 })
  score: number;

  @ApiProperty({ description: '게임별 상세 값 — TETRIS: lines·level·pieces·tSpins·tetrises·maxCombo·engineVersion·das·arr', type: Object })
  detail: Record<string, unknown>;

  @ApiProperty({ description: '등록 직후 기간별 순위 — 순위 계산만 실패하면 null(등록은 성공)', type: GameRanksDto, nullable: true })
  ranks: GameRanksDto | null;
}

export class RankingItemDto {
  @ApiProperty({ description: '순위 (1부터)', example: 1 }) rank: number;
  @ApiProperty({ description: '기록 ID', example: 41 }) scoreId: number;
  @ApiProperty({ description: '표시 이름', example: '테트리스왕' }) playerName: string;
  @ApiProperty({ description: '점수', example: 12340 }) score: number;
  @ApiProperty({ description: '게임별 상세 값', type: Object }) detail: Record<string, unknown>;
  @ApiProperty({ description: '플레이 시간 (밀리초)', example: 182000 }) durationMs: number;
  @ApiProperty({ description: '등록 시각 (ISO, UTC)', example: '2026-10-21T06:00:00.000Z' }) createdAt: Date;
}

export class RankingListDto {
  @ApiProperty({ type: [RankingItemDto] }) items: RankingItemDto[];
  @ApiProperty({ description: '기간 시작 시각 (ISO, UTC) — all이면 null', type: Date, nullable: true, example: '2026-10-19T15:00:00.000Z' })
  periodStart: Date | null;
}

export class GameReplayDetailDto extends RankingItemDto {
  @ApiProperty({ description: '엔진 버전 — 재생에는 같은 버전 엔진 필요', example: 1 }) engineVersion: number;
  @ApiProperty({ description: '시드', example: 123456789 }) seed: number;
  @ApiProperty({ description: 'DAS (프레임)', example: 10 }) das: number;
  @ApiProperty({ description: 'ARR (프레임)', example: 2 }) arr: number;
  @ApiProperty({ description: '게임 오버 프레임', example: 7200 }) frames: number;
  @ApiProperty({ description: '입력 로그 [deltaFrame, actionCode, ...]', type: [Number] }) inputs: number[];
}

export class GameSessionResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: GameSessionDto }) data: GameSessionDto;
}

export class GameScoreSubmittedResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: GameScoreSubmittedDto }) data: GameScoreSubmittedDto;
}

export class RankingListResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: RankingListDto }) data: RankingListDto;
}

export class GameReplayResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: GameReplayDetailDto }) data: GameReplayDetailDto;
}

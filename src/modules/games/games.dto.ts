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
  Matches,
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

/** 보드 키 형식 — DB CHECK GAME_SCORES_BOARD_CK와 같다 */
const BOARD_KEY_PATTERN = /^[a-z0-9-]{1,40}$/;

// ==================== Request DTOs ====================

/** 세션 발급 — 본문 없이 보내면 게임 기본 보드 (defense DESIGN §B3) */
export class CreateGameSessionDto {
  @ApiPropertyOptional({
    description: '플레이 방식 — DEFENSE: endless(생략 시 기본)·weekly. TETRIS는 보내지 않는다(보내면 422)',
    example: 'endless',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{1,20}$/, { message: 'board는 영문 소문자 1~20자여야 합니다.' })
  board?: string;
}

/** 리플레이 본문 (DESIGN §4-1) — 점수는 받지 않는다. 범위·재현 가능 여부는 엔진이 최종 판정 */
export class ReplayDto {
  @ApiProperty({ description: '리플레이를 만든 엔진 버전 (세션과 같아야 함)', example: 1 })
  @IsInt()
  @Min(1)
  engineVersion: number;

  @ApiPropertyOptional({ description: 'TETRIS 전용 — DAS (프레임). 다른 게임은 보내지 않는다', example: 10 })
  @IsOptional()
  @IsInt()
  das?: number;

  @ApiPropertyOptional({ description: 'TETRIS 전용 — ARR (프레임). 다른 게임은 보내지 않는다', example: 2 })
  @IsOptional()
  @IsInt()
  arr?: number;

  @ApiPropertyOptional({
    description: 'TETRIS 외 게임의 리플레이 설정 (정수 값). 키·범위는 게임 엔진이 판정 — 형식이 맞지 않으면 422 VALIDATION_ERROR',
    type: Object,
    example: {},
  })
  @IsOptional()
  @IsObject()
  params?: Record<string, number>;

  @ApiProperty({
    description: `게임 종료 틱 수 (1~${GAME_REPLAY_MAX_FRAMES}, 게임별 틱레이트 — TETRIS 60fps · DEFENSE 30틱/초). 게임별 상한은 서버가 다시 검사`,
    example: 7200,
  })
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
  @ApiPropertyOptional({
    description:
      '기간 — daily(KST 오늘)·weekly(KST 이번 주 월요일부터)·all. 보드 자체가 1주인 DEFENSE 주간 보드는 무시',
    enum: RANKING_PERIODS,
    example: 'weekly',
  })
  @IsOptional()
  @IsIn(RANKING_PERIODS, { message: `period는 ${RANKING_PERIODS.join(', ')} 중 하나여야 합니다.` })
  period?: RankingPeriod;

  @ApiPropertyOptional({
    description:
      '랭킹 보드 키 — 생략하면 게임 기본 보드(TETRIS default · DEFENSE 현재 무한 시즌). 목록은 GET /games/:gameType/boards',
    example: 'default',
  })
  @IsOptional()
  @IsString()
  @Matches(BOARD_KEY_PATTERN, { message: 'board는 소문자·숫자·하이픈 1~40자여야 합니다.' })
  board?: string;

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

  @ApiProperty({ description: '게임 시드 (0 ~ 4294967295) — 테트리스 블록 순서·디펜스 웨이브 구성. 주간 보드는 전원 같은 값', example: 123456789 })
  seed: number;

  @ApiProperty({ description: '서버가 받는 엔진 버전', example: 1 })
  engineVersion: number;

  @ApiProperty({
    description: '이 판이 등록될 랭킹 보드 (TETRIS default · DEFENSE endless-s{N}·weekly-YYYY-wNN)',
    example: 'default',
  })
  boardKey: string;

  @ApiProperty({ description: '플레이 방식 — TETRIS null, DEFENSE endless·weekly', type: String, nullable: true, example: null })
  mode: string | null;

  @ApiProperty({ description: '세션 만료 시각 (ISO, UTC)', example: '2026-10-21T08:00:00.000Z' })
  expiresAt: Date;
}

/** 기간 필터를 쓰지 않는 보드(DEFENSE 주간)는 세 값 모두 보드 전체 순위로 같다 */
export class GameRanksDto {
  @ApiProperty({
    description: '기간별 순위 — DEFENSE 주간 보드는 daily·weekly·all 모두 보드 전체 순위(같은 값)',
    example: 3,
  })
  daily: number;
  @ApiProperty({ description: 'DEFENSE 주간 보드는 보드 전체 순위(daily와 같은 값)', example: 12 })
  weekly: number;
  @ApiProperty({ description: 'DEFENSE 주간 보드는 보드 전체 순위(daily와 같은 값)', example: 120 })
  all: number;
}

export class GameScoreSubmittedDto {
  @ApiProperty({ description: '기록 ID (리플레이 재생에 사용)', example: 41 })
  scoreId: number;

  @ApiProperty({ description: '서버가 리플레이로 계산한 점수', example: 12340 })
  score: number;

  @ApiProperty({ description: '랭킹에 저장된 이름 — 보낸 이름의 앞뒤 공백 제거·연속 공백 1개로 정리한 값(공유 카드·화면 표시는 이 값을 쓴다)', example: '테트리스왕' })
  playerName: string;

  @ApiProperty({
    description:
      '게임별 상세 값 — TETRIS: lines·level·pieces·tSpins·tetrises·maxCombo·engineVersion·das·arr · DEFENSE: wave·progress·kills·livesLeft·goldEarned·engineVersion',
    type: Object,
  })
  detail: Record<string, unknown>;

  @ApiProperty({ description: '등록 직후 기간별 순위 — 순위 계산만 실패하면 null(등록은 성공)', type: GameRanksDto, nullable: true })
  ranks: GameRanksDto | null;
}

export class RankingItemDto {
  @ApiProperty({ description: '순위 (1부터)', example: 1 }) rank: number;
  @ApiProperty({ description: '기록 ID', example: 41 }) scoreId: number;
  @ApiProperty({ description: '표시 이름', example: '테트리스왕' }) playerName: string;
  @ApiProperty({ description: '랭킹 보드 키', example: 'default' }) boardKey: string;
  @ApiProperty({ description: '점수', example: 12340 }) score: number;
  @ApiProperty({ description: '게임별 상세 값', type: Object }) detail: Record<string, unknown>;
  @ApiProperty({ description: '플레이 시간 (밀리초)', example: 182000 }) durationMs: number;
  @ApiProperty({ description: '등록 시각 (ISO, UTC)', example: '2026-10-21T06:00:00.000Z' }) createdAt: Date;
}

export class RankingListDto {
  @ApiProperty({ description: '조회한 랭킹 보드 키', example: 'default' }) boardKey: string;
  @ApiProperty({ type: [RankingItemDto] }) items: RankingItemDto[];
  @ApiProperty({ description: '기간 시작 시각 (ISO, UTC) — all이면 null', type: Date, nullable: true, example: '2026-10-19T15:00:00.000Z' })
  periodStart: Date | null;
}

export class GameReplayDetailDto extends RankingItemDto {
  @ApiProperty({ description: '엔진 버전 — 재생에는 같은 버전 엔진 필요', example: 1 }) engineVersion: number;
  @ApiProperty({ description: '시드', example: 123456789 }) seed: number;
  @ApiPropertyOptional({ description: 'TETRIS 전용 — DAS (프레임)', example: 10 }) das?: number;
  @ApiPropertyOptional({ description: 'TETRIS 전용 — ARR (프레임)', example: 2 }) arr?: number;
  @ApiProperty({
    description: '게임별 리플레이 설정 — TETRIS { das, arr } · DEFENSE {}',
    type: Object,
    example: { das: 10, arr: 2 },
  })
  params: Record<string, number>;
  @ApiProperty({ description: '게임 종료 틱 수 (게임별 틱레이트)', example: 7200 }) frames: number;
  @ApiProperty({ description: '입력 로그 [deltaFrame, actionCode, ...]', type: [Number] }) inputs: number[];
}

export class GameBoardDto {
  @ApiProperty({ description: '랭킹 보드 키', example: 'default' }) boardKey: string;
  @ApiProperty({ description: '플레이 방식 — TETRIS null, DEFENSE endless·weekly', type: String, nullable: true, example: null }) mode: string | null;
  @ApiProperty({ description: '지금 등록받는 보드인지 (지난 시즌·지난 주는 false)', example: true }) current: boolean;
  @ApiProperty({ description: '보드 시작 시각 (ISO, UTC) — 기간 없는 보드는 null', type: Date, nullable: true, example: null }) startsAt: Date | null;
  @ApiProperty({ description: '보드 종료 시각 (ISO, UTC) — 기간 없는 보드는 null', type: Date, nullable: true, example: null }) endsAt: Date | null;
}

export class GameBoardListDto {
  @ApiProperty({ type: [GameBoardDto] }) items: GameBoardDto[];
}

export class GameBoardListResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: GameBoardListDto }) data: GameBoardListDto;
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

export class GameScoreSummaryResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: RankingItemDto }) data: RankingItemDto;
}

export class GameReplayResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: GameReplayDetailDto }) data: GameReplayDetailDto;
}

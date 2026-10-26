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
  GAME_POPULAR_DEFAULT_LIMIT,
  GAME_RANKING_DEFAULT_LIMIT,
  GAME_RANKING_MAX_LIMIT,
  GAME_REPLAY_MAX_FRAMES,
  GAME_REPLAY_MAX_INPUT_LENGTH,
  GAME_WATCH_REPORT_MAX_MS,
} from '../../common/constants/app.constants';

/** 랭킹 기간 (D-004) — 일간·주간은 KST 경계 */
export const RANKING_PERIODS = ['daily', 'weekly', 'all'] as const;
export type RankingPeriod = (typeof RANKING_PERIODS)[number];

/** 인기 리플레이 정렬 (docs/tasks/replay-views D-005) — 기간 안 조회수 · 시청시간 합 */
export const POPULAR_SORTS = ['views', 'watch'] as const;
export type PopularSort = (typeof POPULAR_SORTS)[number];

// 변환은 검증보다 먼저 돈다 — 앞뒤 공백 제거 + 연속 공백을 1개로
const normalizePlayerName = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

/** 보드 키 형식 — DB CHECK GAME_SCORES_BOARD_CK와 같다 */
const BOARD_KEY_PATTERN = /^[a-z0-9-]{1,40}$/;

// ==================== Request DTOs ====================

/** 세션 발급 — 본문 없이 보내면 게임 기본 보드 (defense DESIGN §B3) */
export class CreateGameSessionDto {
  @ApiPropertyOptional({
    description: '플레이 방식 — DEFENSE: endless(생략 시 기본)·weekly · TETRIS: 생략(기본)·daily(오늘의 테트리스, 전원 같은 seed)',
    example: 'endless',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{1,20}$/, { message: 'board는 영문 소문자 1~20자여야 합니다.' })
  board?: string;

  @ApiPropertyOptional({
    description:
      '도전장 — 이 기록과 같은 seed로 플레이하고 결과는 `challenge-{원본 ID}` 보드에 등록(메인 랭킹 아님). 도전장 기록을 주면 그 원본으로. board와 함께 보내면 422. TETRIS만 (docs/tasks/games-growth D-005)',
    example: 41,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  challengeScoreId?: number;
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

/**
 * 시청시간 보고 — 본문 대신 쿼리로 받는다: 이탈 때 keepalive·sendBeacon으로 보내는 본문 없는 POST는
 * CORS preflight가 없어(단순 요청) 페이지가 닫혀도 나간다 (docs/tasks/replay-views D-004)
 */
export class WatchReportQueryDto {
  @ApiProperty({ description: `지난 보고 뒤 재생이 진행된 벽시계 시간 증분 (밀리초, 1~${GAME_WATCH_REPORT_MAX_MS}) — 배속 미반영`, example: 30000 })
  @IsInt()
  @Min(1)
  @Max(GAME_WATCH_REPORT_MAX_MS)
  ms: number;
}

export class GetPopularReplaysQueryDto {
  @ApiPropertyOptional({ description: '기간 — daily(KST 오늘)·weekly(KST 이번 주 월요일부터, 기본)·all', enum: RANKING_PERIODS, example: 'weekly' })
  @IsOptional()
  @IsIn(RANKING_PERIODS, { message: `period는 ${RANKING_PERIODS.join(', ')} 중 하나여야 합니다.` })
  period?: RankingPeriod;

  @ApiPropertyOptional({ description: '정렬 — views(기간 안 조회수, 기본)·watch(기간 안 시청시간 합)', enum: POPULAR_SORTS, example: 'views' })
  @IsOptional()
  @IsIn(POPULAR_SORTS, { message: `sort는 ${POPULAR_SORTS.join(', ')} 중 하나여야 합니다.` })
  sort?: PopularSort;

  @ApiPropertyOptional({
    description: '랭킹 보드 키 — 생략하면 게임 기본 보드(TETRIS default · DEFENSE 현재 무한 시즌). 진행 중인 DEFENSE 주간 보드는 빈 목록',
    example: 'default',
  })
  @IsOptional()
  @IsString()
  @Matches(BOARD_KEY_PATTERN, { message: 'board는 소문자·숫자·하이픈 1~40자여야 합니다.' })
  board?: string;

  @ApiPropertyOptional({ description: `개수 (1~${GAME_RANKING_MAX_LIMIT}, 기본 ${GAME_POPULAR_DEFAULT_LIMIT})`, example: GAME_POPULAR_DEFAULT_LIMIT })
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
    description: '이 판이 등록될 랭킹 보드 (TETRIS default·daily-YYYY-MM-DD·challenge-{원본 ID} · DEFENSE endless-s{N}·weekly-YYYY-wNN)',
    example: 'default',
  })
  boardKey: string;

  @ApiProperty({ description: '플레이 방식 — TETRIS null(기본)·daily·challenge, DEFENSE endless·weekly', type: String, nullable: true, example: null })
  mode: string | null;

  @ApiProperty({ description: '세션 만료 시각 (ISO, UTC)', example: '2026-10-21T08:00:00.000Z' })
  expiresAt: Date;

  @ApiProperty({
    description: '세션 유효 시간(초) — 발급 시점부터. 기기 시계가 서버와 달라도 남은 시간을 계산할 수 있게 받은 시각 + 이 값으로 쓴다',
    example: 7200,
  })
  ttlSeconds: number;
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

export class TrophiesDto {
  @ApiProperty({ description: '1위 횟수', example: 1 }) gold: number;
  @ApiProperty({ description: '2위 횟수', example: 0 }) silver: number;
  @ApiProperty({ description: '3위 횟수', example: 2 }) bronze: number;
}

export class RankingItemDto {
  @ApiProperty({ description: '순위 (1부터)', example: 1 }) rank: number;
  @ApiProperty({ description: '기록 ID', example: 41 }) scoreId: number;
  @ApiProperty({ description: '표시 이름', example: '테트리스왕' }) playerName: string;
  @ApiProperty({ description: '랭킹 보드 키', example: 'default' }) boardKey: string;
  @ApiProperty({ description: '점수', example: 12340 }) score: number;
  @ApiProperty({ description: '게임별 상세 값', type: Object }) detail: Record<string, unknown>;
  @ApiProperty({ description: '플레이 시간 (밀리초)', example: 182000 }) durationMs: number;
  @ApiProperty({ description: '누적 리플레이 조회수 — 재생 API 응답은 최대 60초 캐시라 조회 기록 응답(POST .../views)의 값이 더 최신', example: 12 })
  viewCount: number;
  @ApiProperty({ description: '누적 시청시간 (밀리초) — 재생이 진행된 벽시계 시간 합', example: 540000 }) watchMs: number;
  @ApiProperty({
    description: '명예의 전당 배지 — 로그인 사용자 기록이고 최근 입상(지난 8주·7일)이 있을 때만, 그 외 null (docs/tasks/games-growth D-007)',
    type: TrophiesDto,
    nullable: true,
  })
  trophies: TrophiesDto | null;
  @ApiProperty({ description: '등록 시각 (ISO, UTC)', example: '2026-10-21T06:00:00.000Z' }) createdAt: Date;
}

export class RankingListDto {
  @ApiProperty({ description: '조회한 랭킹 보드 키', example: 'default' }) boardKey: string;
  @ApiProperty({ type: [RankingItemDto] }) items: RankingItemDto[];
  @ApiProperty({ description: '기간 시작 시각 (ISO, UTC) — all이면 null', type: Date, nullable: true, example: '2026-10-19T15:00:00.000Z' })
  periodStart: Date | null;
}

export class SkinCollectionItemDto {
  @ApiProperty({ description: '아이템 id — 이름·미리보기는 프론트 레지스트리', example: 'gameboy' }) id: string;
  @ApiProperty({ description: '획득 방식 — default(기본 제공)·free(누구나). 업적·출석은 이후 조건 필드와 함께 추가', example: 'free' }) unlock: string;
  @ApiProperty({ description: '내가 보유했는지 — 게스트는 false(보유는 계정 기준)', example: true }) owned: boolean;
  @ApiProperty({ description: '지금 장착 중인지 — 게스트는 false', example: false }) equipped: boolean;
}

export class SkinCollectionSlotDto {
  @ApiProperty({ description: '슬롯 — block·effect·board·background', example: 'block' }) slot: string;
  @ApiProperty({ type: [SkinCollectionItemDto], description: '서버 카탈로그 순서' }) items: SkinCollectionItemDto[];
}

export class SkinCollectionDto {
  @ApiProperty({ description: '로그인 여부 — false면 보유·장착 표시가 모두 false', example: true }) signedIn: boolean;
  @ApiProperty({ type: [SkinCollectionSlotDto], description: '슬롯별 전체 아이템. 스킨이 없는 게임은 빈 배열' }) slots: SkinCollectionSlotDto[];
}

export class SkinCollectionResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: SkinCollectionDto }) data: SkinCollectionDto;
}

/** 보드 슬롯 스킨 — 화면 배경(background)은 보는 사람 자신의 것이라 싣지 않는다 (tetris-skins D-003) */
export class BoardSkinsDto {
  @ApiProperty({ description: '블록 스킨 id', example: 'default' }) block: string;
  @ApiProperty({ description: '이펙트 스킨 id', example: 'default' }) effect: string;
  @ApiProperty({ description: '판 배경 스킨 id', example: 'default' }) board: string;
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
  @ApiProperty({
    type: BoardSkinsDto,
    description: '보드를 그릴 스킨(보드 슬롯) — 그 판을 시작할 때의 장착(이후 바꿔도 그대로). 기능 전 기록·게스트·DEFENSE는 default (docs/tasks/tetris-skins D-007)',
  })
  skins: BoardSkinsDto;
}

export class GameReplayViewDto {
  @ApiProperty({ description: '기록 ID', example: 41 }) scoreId: number;
  @ApiProperty({ description: '이번 조회를 반영한 조회수', example: 13 }) viewCount: number;
  @ApiProperty({ description: '이번 요청이 조회수에 반영됐는지 — 같은 IP의 하루 상한을 넘으면 false(200은 그대로)', example: true })
  counted: boolean;
}

export class GameReplayWatchDto {
  @ApiProperty({ description: '기록 ID', example: 41 }) scoreId: number;
  @ApiProperty({ description: '이번 보고를 반영한 누적 시청시간 (밀리초)', example: 570000 }) watchMs: number;
  @ApiProperty({ description: '이번 보고 중 반영된 밀리초 — 같은 IP의 하루 상한을 넘은 부분은 빠진다(0이어도 200)', example: 30000 })
  countedMs: number;
}

export class PopularReplayItemDto extends RankingItemDto {
  @ApiProperty({ description: '기간 안 조회수', example: 7 }) periodViewCount: number;
  @ApiProperty({ description: '기간 안 시청시간 (밀리초)', example: 300000 }) periodWatchMs: number;
}

export class PopularReplayListDto {
  @ApiProperty({ description: '조회한 랭킹 보드 키', example: 'default' }) boardKey: string;
  @ApiProperty({ description: '기간', enum: RANKING_PERIODS, example: 'weekly' }) period: RankingPeriod;
  @ApiProperty({ description: '정렬', enum: POPULAR_SORTS, example: 'views' }) sort: PopularSort;
  @ApiProperty({ description: '기간 시작 시각 (ISO, UTC) — all이면 null', type: Date, nullable: true, example: '2026-10-19T15:00:00.000Z' })
  periodStart: Date | null;
  @ApiProperty({
    description: '인기순 — rank는 이 목록 안 순서(점수 순위 아님). viewCount·watchMs는 누적, period* 는 기간 안 값',
    type: [PopularReplayItemDto],
  })
  items: PopularReplayItemDto[];
}

export class HallOfFamePeriodDto {
  @ApiProperty({ description: '기간 종류 — weekly(주간)·daily(오늘의 테트리스)', enum: ['weekly', 'daily'], example: 'weekly' }) kind: 'weekly' | 'daily';
  @ApiProperty({ description: '랭킹 보드 키', example: 'default' }) boardKey: string;
  @ApiProperty({ description: '기간 시작 (ISO, UTC)', example: '2026-10-11T15:00:00.000Z' }) startsAt: Date;
  @ApiProperty({ description: '기간 끝(미포함) (ISO, UTC)', example: '2026-10-18T15:00:00.000Z' }) endsAt: Date;
  @ApiProperty({ description: '1~3위 — rank는 그 기간 안 순위', type: [RankingItemDto] }) podium: RankingItemDto[];
}

export class HallOfFameDto {
  @ApiProperty({ description: '끝난 기간별 시상대 (최근 먼저, 기록 없는 기간 제외)', type: [HallOfFamePeriodDto] }) periods: HallOfFamePeriodDto[];
}

export class GameBoardDto {
  @ApiProperty({ description: '랭킹 보드 키', example: 'default' }) boardKey: string;
  @ApiProperty({ description: '플레이 방식 — TETRIS null(기본)·daily·challenge, DEFENSE endless·weekly', type: String, nullable: true, example: null }) mode: string | null;
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

export class GameReplayViewResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: GameReplayViewDto }) data: GameReplayViewDto;
}

export class GameReplayWatchResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: GameReplayWatchDto }) data: GameReplayWatchDto;
}

export class PopularReplayListResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: PopularReplayListDto }) data: PopularReplayListDto;
}

export class HallOfFameResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: HallOfFameDto }) data: HallOfFameDto;
}

export class GameReplayResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: GameReplayDetailDto }) data: GameReplayDetailDto;
}

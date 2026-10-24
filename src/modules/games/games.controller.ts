import { Body, Controller, Get, HttpCode, Ip, Param, ParseIntPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCommonInternalServerErrorResponse,
  ApiCommonValidationResponse,
  ApiThrottledResponse,
} from '../../common/decorators/api-error-response.decorator';
import {
  THROTTLE_GAME_REPLAY_LONG,
  THROTTLE_GAME_REPLAY_SHORT,
  THROTTLE_GAME_SCORE_LONG,
  THROTTLE_GAME_SCORE_SHORT,
  THROTTLE_GAME_SESSION_LONG,
  THROTTLE_GAME_SESSION_SHORT,
} from '../../common/constants/throttle.constants';
import { GAME_REPLAY_CACHE_MAX_AGE_SECONDS, GAME_VERIFY_RETRY_AFTER_SECONDS } from '../../common/constants/app.constants';
import { User } from '../../entities/User';
import { AuthUnauthorizedErrorResponseDto } from '../auth/auth-error.dto';
import { GamesService } from './games.service';
import {
  CreateGameSessionDto,
  GameBoardListResponseDto,
  GameReplayResponseDto,
  GameReplayViewResponseDto,
  GameReplayWatchResponseDto,
  GameScoreSummaryResponseDto,
  GameScoreSubmittedResponseDto,
  GameSessionResponseDto,
  GetPopularReplaysQueryDto,
  GetRankingsQueryDto,
  HallOfFameResponseDto,
  PopularReplayListResponseDto,
  RankingListResponseDto,
  SubmitGameScoreDto,
  WatchReportQueryDto,
} from './games.dto';
import {
  GameChallengeExpiredErrorResponseDto,
  GameNotFoundErrorResponseDto,
  GameReplayInvalidErrorResponseDto,
  GameScoreNotFoundErrorResponseDto,
  GameSessionInvalidErrorResponseDto,
  GameSessionUnavailableErrorResponseDto,
  GameVerifyBusyErrorResponseDto,
} from './games-error.dto';

const GAME_TYPE_PARAM = {
  name: 'gameType',
  description: '게임 이름 (소문자) — tetris · defense',
  example: 'tetris',
};

/**
 * 게임 모음집 REST (docs/tasks/games DESIGN.md §2·§3·§7)
 *
 * 비로그인도 플레이·등록·조회한다(D-003). 로그인 토큰이 있으면 OptionalJwtAuthGuard가 사용자를 붙여 USER_ID를 남긴다.
 * 점수는 받지 않는다 — 서버가 리플레이를 재실행해 계산한다(D-005).
 */
@ApiTags('games')
@Controller('games')
export class GamesController {
  constructor(private readonly gamesService: GamesService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Post(':gameType/sessions')
  @Throttle({ short: THROTTLE_GAME_SESSION_SHORT, long: THROTTLE_GAME_SESSION_LONG }) // 초당 2회, 분당 20회
  @ApiOperation({
    summary: '게임 세션 발급',
    description:
      '서버가 seed를 정한다. 점수 제출 시 sessionId를 1회 사용한다(유효 시간은 게임별 — TETRIS 2시간 · DEFENSE 4시간). DEFENSE 주간 도전은 전원 같은 seed',
  })
  @ApiParam(GAME_TYPE_PARAM)
  @ApiBody({ type: CreateGameSessionDto, required: false })
  @ApiResponse({ status: 201, description: 'SUCCESS', type: GameSessionResponseDto })
  @ApiResponse({ status: 401, description: '만료·무효 토큰을 보냄 (토큰이 없으면 비로그인으로 통과) — 토큰 없이 다시 요청', type: AuthUnauthorizedErrorResponseDto })
  @ApiResponse({
    status: 404,
    description: 'GAME_NOT_FOUND(지원하지 않는 게임) · GAME_SCORE_NOT_FOUND(도전장 원본이 없음·숨김·재생 공개 전)',
    type: GameNotFoundErrorResponseDto,
  })
  @ApiResponse({ status: 409, description: 'GAME_CHALLENGE_EXPIRED — 도전장 원본의 엔진 버전이 현재와 다름', type: GameChallengeExpiredErrorResponseDto })
  @ApiCommonValidationResponse()
  @ApiThrottledResponse('요청 횟수 초과 (초당 2회 / 분당 20회)')
  // 503은 두 코드 — Swagger는 상태코드당 응답 하나라 한 항목에 모두 적는다
  @ApiResponse({
    status: 503,
    description:
      'GAME_SESSION_UNAVAILABLE: 세션 저장소(Redis) 사용 불가 — 플레이는 가능, 등록 불가 · GAME_WEEKLY_UNAVAILABLE: DEFENSE 주간 도전을 열 수 없음(서버 설정) — 무한 모드는 정상 · ' +
      'GAME_DAILY_UNAVAILABLE: TETRIS 오늘의 테트리스를 열 수 없음(서버 설정) — 기본 보드는 정상',
    type: GameSessionUnavailableErrorResponseDto,
  })
  @ApiCommonInternalServerErrorResponse()
  async createSession(@Param('gameType') gameType: string, @Body() dto: CreateGameSessionDto, @CurrentUser() user?: User) {
    const data = await this.gamesService.createSession(gameType, user?.userId ?? null, dto.board, dto.challengeScoreId);
    return { code: 'SUCCESS', data, message: '' };
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Post(':gameType/scores')
  @Throttle({ short: THROTTLE_GAME_SCORE_SHORT, long: THROTTLE_GAME_SCORE_LONG }) // 초당 1회, 분당 10회
  @ApiOperation({
    summary: '랭킹 등록 (리플레이 제출)',
    description: '점수는 보내지 않는다. 서버가 세션 seed + 입력 기록을 엔진으로 재실행해 점수를 계산하고 리플레이와 함께 저장한다',
  })
  @ApiParam(GAME_TYPE_PARAM)
  @ApiBody({ type: SubmitGameScoreDto })
  @ApiResponse({ status: 201, description: 'SUCCESS (서버 계산 점수 + 기간별 순위)', type: GameScoreSubmittedResponseDto })
  @ApiResponse({ status: 401, description: '만료·무효 토큰을 보냄 — 토큰 없이 다시 제출(세션은 소모되지 않음)', type: AuthUnauthorizedErrorResponseDto })
  @ApiResponse({ status: 404, description: '지원하지 않는 게임', type: GameNotFoundErrorResponseDto })
  @ApiResponse({
    status: 409,
    description:
      'GAME_SESSION_INVALID: 새 게임 필요 — details.reason ENGINE_VERSION(배포 뒤 옛 화면 → 새로고침) · NOT_FOUND(없음·만료·이미 사용) · GAME_MISMATCH · ' +
      'GAME_REPLAY_DUPLICATE: 같은 보드에 같은 리플레이가 이미 등록됨(세션 소모)',
    type: GameSessionInvalidErrorResponseDto,
  })
  @ApiResponse({ status: 413, description: 'PAYLOAD_TOO_LARGE: 본문 300kb 초과' })
  // 422는 네 코드 — Swagger는 상태코드당 응답 하나만 남기므로 한 항목에 모두 적는다
  @ApiResponse({
    status: 422,
    description:
      'GAME_PLAYER_NAME_INVALID: 이름 형식 위반 · GAME_PLAYER_NAME_FORBIDDEN: 금칙어 (둘 다 세션 미소모 — 이름만 바꿔 재제출) · ' +
      'VALIDATION_ERROR: 리플레이·세션 형식 위반·게임별 상한·params 형식 (세션 미소모) · ' +
      'GAME_REPLAY_INVALID(세션 소모): details.reason ELAPSED_TIME(실제 경과 시간 초과) · REPLAY_REJECTED(재현 불가, engineReason에 엔진 사유) · VERIFY_TIMEOUT(검증 시간 초과 반복)',
    type: GameReplayInvalidErrorResponseDto,
  })
  @ApiThrottledResponse('요청 횟수 초과 (초당 1회 / 분당 10회)')
  // 503도 두 코드 — Swagger는 상태코드당 응답 하나라 한 항목에 모두 적는다
  @ApiResponse({
    status: 503,
    description:
      'GAME_SESSION_UNAVAILABLE: 세션 저장소(Redis) 사용 불가 · GAME_VERIFY_BUSY: 세션 유지, Retry-After(초 = details.retryAfterSeconds) 뒤 같은 세션으로 다시 제출 — ' +
      'details.reason QUEUE_FULL · TIMEOUT · UNAVAILABLE(워커 꺼짐, 30초) · VERIFY_ERROR · IN_PROGRESS(같은 세션 검증 중) · SAVE_FAILED(저장 실패, 세션 복구됨)',
    type: GameVerifyBusyErrorResponseDto,
  })
  @ApiCommonInternalServerErrorResponse()
  async submitScore(
    @Param('gameType') gameType: string,
    @Body() dto: SubmitGameScoreDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: User,
  ) {
    try {
      const data = await this.gamesService.submitScore({ gameTypeParam: gameType, dto, userId: user?.userId ?? null, ip });
      return { code: 'SUCCESS', data, message: '' };
    } catch (error) {
      // 전역 필터는 헤더를 다루지 않는다 — 같은 응답 객체에 먼저 실어 두면 필터가 본문만 쓴다
      if (error instanceof GameVerifyBusyErrorResponseDto) {
        // 원인별 대기 시간(details.retryAfterSeconds) — 워커가 꺼졌으면 길게(games-polish BD-14)
        const details = error.details as { retryAfterSeconds?: number } | undefined;
        res.setHeader('Retry-After', String(details?.retryAfterSeconds ?? GAME_VERIFY_RETRY_AFTER_SECONDS));
      }
      throw error;
    }
  }

  @Get(':gameType/boards')
  @ApiOperation({
    summary: '랭킹 보드 목록',
    description:
      '현재·지난 랭킹 보드. TETRIS는 default + 오늘·어제 데일리(daily-YYYY-MM-DD, 서버 설정이 없으면 빠짐 — 도전장 보드 challenge-{id}는 목록에 없고 rankings?board=로 직접 조회) · DEFENSE는 무한 시즌(endless-s{N})과 이번 주·지난 주 주간 보드(weekly-YYYY-wNN, 서버 설정이 없으면 빠짐) (docs/tasks/defense DESIGN §B6)',
  })
  @ApiParam(GAME_TYPE_PARAM)
  @ApiResponse({ status: 200, description: 'SUCCESS', type: GameBoardListResponseDto })
  @ApiResponse({ status: 404, description: '지원하지 않는 게임', type: GameNotFoundErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  listBoards(@Param('gameType') gameType: string) {
    return { code: 'SUCCESS', data: this.gamesService.listBoards(gameType), message: '' };
  }

  @Get(':gameType/rankings')
  @ApiOperation({
    summary: '보드·기간별 랭킹',
    description: '점수 내림차순, 같은 점수면 먼저 저장된 기록이 위. 일간·주간 경계는 KST. board 생략 시 게임 기본 보드, 모르는 보드는 422',
  })
  @ApiParam(GAME_TYPE_PARAM)
  @ApiResponse({ status: 200, description: 'SUCCESS', type: RankingListResponseDto })
  @ApiResponse({ status: 404, description: '지원하지 않는 게임', type: GameNotFoundErrorResponseDto })
  @ApiCommonValidationResponse()
  @ApiCommonInternalServerErrorResponse()
  async getRankings(@Param('gameType') gameType: string, @Query() query: GetRankingsQueryDto) {
    const data = await this.gamesService.getRankings(gameType, query);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Get(':gameType/scores/:scoreId')
  @ApiOperation({
    summary: '기록 요약',
    description: '누구나 조회. 리플레이 입력 없이 이름·점수·상세 값·전체 순위만 — 공유 링크 미리보기(OG)용 (docs/tasks/game-share D-008)',
  })
  @ApiParam(GAME_TYPE_PARAM)
  @ApiParam({ name: 'scoreId', description: '랭킹 기록 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS (rank는 전체 기간 순위)', type: GameScoreSummaryResponseDto })
  @ApiResponse({ status: 400, description: 'scoreId가 숫자가 아님 (BAD_REQUEST)' })
  @ApiResponse({ status: 404, description: 'GAME_NOT_FOUND · GAME_SCORE_NOT_FOUND(없음·숨김)', type: GameScoreNotFoundErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async getScore(@Param('gameType') gameType: string, @Param('scoreId', ParseIntPipe) scoreId: number) {
    const data = await this.gamesService.getScore(gameType, scoreId);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Get(':gameType/scores/:scoreId/replay')
  @Throttle({ short: THROTTLE_GAME_REPLAY_SHORT, long: THROTTLE_GAME_REPLAY_LONG }) // 초당 2회, 분당 30회
  @ApiOperation({
    summary: '리플레이 재생 데이터',
    description:
      '누구나 조회. 같은 엔진 버전으로 seed + 입력 기록을 재생한다. DEFENSE 주간 보드는 그 주가 끝나고 4시간(세션 유효 시간) 뒤 공개(전원 같은 seed라 입력 복제 방지 — 그 전이면 404)',
  })
  @ApiParam(GAME_TYPE_PARAM)
  @ApiParam({ name: 'scoreId', description: '랭킹 기록 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: GameReplayResponseDto })
  @ApiResponse({ status: 400, description: 'scoreId가 숫자가 아님 (BAD_REQUEST)' })
  @ApiResponse({
    status: 404,
    description: 'GAME_NOT_FOUND · GAME_SCORE_NOT_FOUND(없음·숨김·진행 중인 DEFENSE 주간 보드)',
    type: GameScoreNotFoundErrorResponseDto,
  })
  @ApiThrottledResponse('요청 횟수 초과 (초당 2회 / 분당 30회)')
  @ApiCommonInternalServerErrorResponse()
  async getReplay(
    @Param('gameType') gameType: string,
    @Param('scoreId', ParseIntPipe) scoreId: number,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.gamesService.getReplay(gameType, scoreId);
    // 입력 기록(큰 본문)은 등록 뒤 바뀌지 않는다 — 공유 링크·재방문의 반복 조회를 브라우저가 잠깐 재사용한다(games-polish BD-06).
    // 성공 응답에만 단다(404는 주간 공개 전일 수 있어 캐시하지 않는다). 순위·숨김 반영이 최대 60초 늦을 수 있다
    res.setHeader('Cache-Control', `public, max-age=${GAME_REPLAY_CACHE_MAX_AGE_SECONDS}`);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Post(':gameType/scores/:scoreId/views')
  @HttpCode(200)
  @Throttle({ short: THROTTLE_GAME_REPLAY_SHORT, long: THROTTLE_GAME_REPLAY_LONG }) // 초당 2회, 분당 30회
  @ApiOperation({
    summary: '리플레이 조회 기록',
    description:
      '누구나 호출. 재생 화면 진입 때 조회수를 1 올린다 — 같은 브라우저 하루 1회는 프론트가 거르고, 서버는 같은 IP의 하루 상한까지만 센다(넘으면 200 + counted false). ' +
      '재생 API와 같은 공개 규칙(숨김·DEFENSE 진행 중 주간 보드는 404) (docs/tasks/replay-views)',
  })
  @ApiParam(GAME_TYPE_PARAM)
  @ApiParam({ name: 'scoreId', description: '랭킹 기록 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: GameReplayViewResponseDto })
  @ApiResponse({ status: 400, description: 'scoreId가 숫자가 아님 (BAD_REQUEST)' })
  @ApiResponse({
    status: 404,
    description: 'GAME_NOT_FOUND · GAME_SCORE_NOT_FOUND(없음·숨김·진행 중인 DEFENSE 주간 보드)',
    type: GameScoreNotFoundErrorResponseDto,
  })
  @ApiThrottledResponse('요청 횟수 초과 (초당 2회 / 분당 30회)')
  @ApiCommonInternalServerErrorResponse()
  async recordView(@Param('gameType') gameType: string, @Param('scoreId', ParseIntPipe) scoreId: number, @Ip() ip: string) {
    const data = await this.gamesService.recordView(gameType, scoreId, ip);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Post(':gameType/scores/:scoreId/watch')
  @HttpCode(200)
  @Throttle({ short: THROTTLE_GAME_REPLAY_SHORT, long: THROTTLE_GAME_REPLAY_LONG }) // 초당 2회, 분당 30회
  @ApiOperation({
    summary: '리플레이 시청시간 보고',
    description:
      '누구나 호출. 재생이 진행된 벽시계 시간의 증분(ms)을 쿼리로 보낸다 — 본문이 없어 이탈 때 keepalive·sendBeacon으로도 preflight 없이 나간다. ' +
      '같은 IP의 하루 누적은 max(리플레이 길이 × 3, 1분)까지만 반영(넘으면 200 + countedMs 0). 재생 API와 같은 공개 규칙 (docs/tasks/replay-views D-004)',
  })
  @ApiParam(GAME_TYPE_PARAM)
  @ApiParam({ name: 'scoreId', description: '랭킹 기록 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: GameReplayWatchResponseDto })
  @ApiResponse({ status: 400, description: 'scoreId가 숫자가 아님 (BAD_REQUEST)' })
  @ApiResponse({
    status: 404,
    description: 'GAME_NOT_FOUND · GAME_SCORE_NOT_FOUND(없음·숨김·진행 중인 DEFENSE 주간 보드)',
    type: GameScoreNotFoundErrorResponseDto,
  })
  @ApiCommonValidationResponse()
  @ApiThrottledResponse('요청 횟수 초과 (초당 2회 / 분당 30회)')
  @ApiCommonInternalServerErrorResponse()
  async recordWatch(
    @Param('gameType') gameType: string,
    @Param('scoreId', ParseIntPipe) scoreId: number,
    @Query() query: WatchReportQueryDto,
    @Ip() ip: string,
  ) {
    const data = await this.gamesService.recordWatch(gameType, scoreId, query.ms, ip);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Get(':gameType/hall-of-fame')
  @ApiOperation({
    summary: '명예의 전당',
    description:
      '누구나 조회. 끝났고 재생이 공개된 기간별 1~3위 — TETRIS 지난 8주(기본 보드)·지난 7일(오늘의 테트리스), DEFENSE 지난 8주(주간 보드). 최대 10분 늦게 반영 (docs/tasks/games-growth D-010)',
  })
  @ApiParam(GAME_TYPE_PARAM)
  @ApiResponse({ status: 200, description: 'SUCCESS', type: HallOfFameResponseDto })
  @ApiResponse({ status: 404, description: '지원하지 않는 게임', type: GameNotFoundErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async getHallOfFame(@Param('gameType') gameType: string) {
    const data = await this.gamesService.getHallOfFame(gameType);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Get(':gameType/popular-replays')
  @ApiOperation({
    summary: '기간별 인기 리플레이',
    description:
      '누구나 조회. 보드 안에서 기간(KST) 동안 조회수(sort=views) 또는 시청시간(sort=watch) 합이 큰 순. 숨김 제외, 진행 중인 DEFENSE 주간 보드는 빈 목록 (docs/tasks/replay-views D-005)',
  })
  @ApiParam(GAME_TYPE_PARAM)
  @ApiResponse({ status: 200, description: 'SUCCESS', type: PopularReplayListResponseDto })
  @ApiResponse({ status: 404, description: '지원하지 않는 게임', type: GameNotFoundErrorResponseDto })
  @ApiCommonValidationResponse()
  @ApiCommonInternalServerErrorResponse()
  async getPopularReplays(@Param('gameType') gameType: string, @Query() query: GetPopularReplaysQueryDto) {
    const data = await this.gamesService.getPopularReplays(gameType, query);
    return { code: 'SUCCESS', data, message: '' };
  }
}

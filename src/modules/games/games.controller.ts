import { Body, Controller, Get, Ip, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
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
import { User } from '../../entities/User';
import { AuthUnauthorizedErrorResponseDto } from '../auth/auth-error.dto';
import { GamesService } from './games.service';
import {
  GameReplayResponseDto,
  GameScoreSummaryResponseDto,
  GameScoreSubmittedResponseDto,
  GameSessionResponseDto,
  GetRankingsQueryDto,
  RankingListResponseDto,
  SubmitGameScoreDto,
} from './games.dto';
import {
  GameNotFoundErrorResponseDto,
  GameReplayInvalidErrorResponseDto,
  GameScoreNotFoundErrorResponseDto,
  GameSessionInvalidErrorResponseDto,
  GameSessionUnavailableErrorResponseDto,
} from './games-error.dto';

const GAME_TYPE_PARAM = { name: 'gameType', description: '게임 이름 (소문자) — tetris', example: 'tetris' };

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
  @ApiOperation({ summary: '게임 세션 발급', description: '서버가 seed를 정한다. 점수 제출 시 sessionId를 1회 사용한다(2시간 유효)' })
  @ApiParam(GAME_TYPE_PARAM)
  @ApiResponse({ status: 201, description: 'SUCCESS', type: GameSessionResponseDto })
  @ApiResponse({ status: 401, description: '만료·무효 토큰을 보냄 (토큰이 없으면 비로그인으로 통과) — 토큰 없이 다시 요청', type: AuthUnauthorizedErrorResponseDto })
  @ApiResponse({ status: 404, description: '지원하지 않는 게임', type: GameNotFoundErrorResponseDto })
  @ApiThrottledResponse('요청 횟수 초과 (초당 2회 / 분당 20회)')
  @ApiResponse({ status: 503, description: '세션 저장소(Redis) 사용 불가 — 플레이는 가능, 등록 불가', type: GameSessionUnavailableErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async createSession(@Param('gameType') gameType: string, @CurrentUser() user?: User) {
    const data = await this.gamesService.createSession(gameType, user?.userId ?? null);
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
  @ApiResponse({ status: 409, description: '세션 없음·만료·재사용·엔진 버전 불일치 — 새 게임 필요', type: GameSessionInvalidErrorResponseDto })
  @ApiResponse({ status: 413, description: 'PAYLOAD_TOO_LARGE: 본문 300kb 초과' })
  // 422는 네 코드 — Swagger는 상태코드당 응답 하나만 남기므로 한 항목에 모두 적는다
  @ApiResponse({
    status: 422,
    description:
      'GAME_PLAYER_NAME_INVALID: 이름 형식 위반 · GAME_PLAYER_NAME_FORBIDDEN: 금칙어 (둘 다 세션 미소모 — 이름만 바꿔 재제출) · ' +
      'VALIDATION_ERROR: 리플레이·세션 형식 위반 · GAME_REPLAY_INVALID: 재현 불가·실제 경과 시간 초과',
    type: GameReplayInvalidErrorResponseDto,
  })
  @ApiThrottledResponse('요청 횟수 초과 (초당 1회 / 분당 10회)')
  @ApiResponse({ status: 503, description: '세션 저장소(Redis) 사용 불가', type: GameSessionUnavailableErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async submitScore(
    @Param('gameType') gameType: string,
    @Body() dto: SubmitGameScoreDto,
    @Ip() ip: string,
    @CurrentUser() user?: User,
  ) {
    const data = await this.gamesService.submitScore({ gameTypeParam: gameType, dto, userId: user?.userId ?? null, ip });
    return { code: 'SUCCESS', data, message: '' };
  }

  @Get(':gameType/rankings')
  @ApiOperation({ summary: '기간별 랭킹', description: '점수 내림차순, 같은 점수면 먼저 저장된 기록이 위. 일간·주간 경계는 KST' })
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
  @ApiOperation({ summary: '리플레이 재생 데이터', description: '누구나 조회. 같은 엔진 버전으로 seed + 입력 기록을 재생한다' })
  @ApiParam(GAME_TYPE_PARAM)
  @ApiParam({ name: 'scoreId', description: '랭킹 기록 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: GameReplayResponseDto })
  @ApiResponse({ status: 400, description: 'scoreId가 숫자가 아님 (BAD_REQUEST)' })
  @ApiResponse({ status: 404, description: 'GAME_NOT_FOUND · GAME_SCORE_NOT_FOUND(없음·숨김)', type: GameScoreNotFoundErrorResponseDto })
  @ApiThrottledResponse('요청 횟수 초과 (초당 2회 / 분당 30회)')
  @ApiCommonInternalServerErrorResponse()
  async getReplay(@Param('gameType') gameType: string, @Param('scoreId', ParseIntPipe) scoreId: number) {
    const data = await this.gamesService.getReplay(gameType, scoreId);
    return { code: 'SUCCESS', data, message: '' };
  }
}

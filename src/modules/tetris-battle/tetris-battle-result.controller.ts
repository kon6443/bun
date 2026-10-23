import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCommonInternalServerErrorResponse,
  ApiCommonValidationResponse,
  ApiThrottledResponse,
} from '../../common/decorators/api-error-response.decorator';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { User } from '../../entities/User';
import { AuthUnauthorizedErrorResponseDto } from '../auth/auth-error.dto';
import { THROTTLE_BATTLE_REPLAY_SUBMIT, THROTTLE_BATTLE_RESULT_READ } from './tetris-battle.constants';
import {
  TetrisBattleMatchNotEndedErrorResponseDto,
  TetrisBattleMatchNotFoundErrorResponseDto,
  TetrisBattlePlayerTokenInvalidErrorResponseDto,
  TetrisBattleReplayNotFoundErrorResponseDto,
  TetrisBattleSubmissionClosedErrorResponseDto,
  TetrisBattleUnavailableErrorResponseDto,
} from './tetris-battle-error.dto';
import {
  BattleLobbyResponseDto,
  BattleMatchListResponseDto,
  ListBattleMatchesQueryDto,
  BattleMatchResponseDto,
  BattleReplayDetailResponseDto,
  BattleReplaySubmittedResponseDto,
  SubmitBattleReplayDto,
} from './tetris-battle-result.dto';
import { TetrisBattleResultService } from './tetris-battle-result.service';
import { TetrisBattleBrowseService } from './tetris-battle-browse.service';

const MATCH_ID_PARAM = { name: 'matchId', description: '경기 ID (matchStarting으로 받은 16자)', example: 'AbCdEfGhIjKlMnOp' };

/**
 * 테트리스 대전 경기 후 검증·결과 (docs/tasks/tetris-battle DESIGN §17)
 *
 * 비로그인 참가자도 제출한다 — 인증은 방 입장 때 받은 playerToken. 로그인 토큰이 있으면 OptionalJwtAuthGuard가 붙여 USER_ID를 남긴다.
 */
@ApiTags('tetris-battle')
@Controller('tetris-battle')
export class TetrisBattleResultController {
  constructor(
    private readonly resultService: TetrisBattleResultService,
    private readonly browseService: TetrisBattleBrowseService,
  ) {}

  // ==================== 대전 입구 (D-025) ====================

  @Get('lobby')
  @Throttle(THROTTLE_BATTLE_RESULT_READ)
  @ApiOperation({
    summary: '대전 로비 방 수',
    description: '테트리스 홈 "지금 열린 방 N개"용 — 소켓 없이. 레플리카 공통 2초 캐시(숫자가 최대 2초 늦을 수 있다)',
  })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: BattleLobbyResponseDto })
  @ApiThrottledResponse('요청 횟수 초과 (초당 3회 / 분당 60회)')
  @ApiResponse({ status: 503, description: '대전 상태 저장소(Redis) 사용 불가', type: TetrisBattleUnavailableErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async getLobby() {
    const data = await this.browseService.getLobby();
    return { code: 'SUCCESS', data, message: '' };
  }

  @Get('matches')
  @Throttle(THROTTLE_BATTLE_RESULT_READ)
  @ApiOperation({
    summary: '최근 대전 목록',
    description: '숨김 아닌 저장된 경기, 최근 저장 순. 검증 실패 참가자가 있으면 disputed=true(검증 실패는 참가자 단위). 다음 페이지는 응답의 nextCursor를 cursor로 그대로 보낸다',
  })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: BattleMatchListResponseDto })
  @ApiCommonValidationResponse()
  @ApiThrottledResponse('요청 횟수 초과 (초당 3회 / 분당 60회)')
  @ApiCommonInternalServerErrorResponse()
  async listMatches(@Query() query: ListBattleMatchesQueryDto) {
    const data = await this.browseService.listMatches(query);
    return { code: 'SUCCESS', data, message: '' };
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Post('matches/:matchId/replays')
  @Throttle(THROTTLE_BATTLE_REPLAY_SUBMIT) // 초당 2회, 분당 20회
  @ApiOperation({
    summary: '대전 리플레이 제출 (경기 후 검증)',
    description:
      '경기 종료(matchEnded) 후 60초 안에 1번. 서버가 seed·받은 가비지·lock별 공격·탈락 프레임을 실시간 기록과 대조한다. ' +
      '검증 실패도 201 + verdict INVALID(재시도 무의미)',
  })
  @ApiParam(MATCH_ID_PARAM)
  @ApiBody({ type: SubmitBattleReplayDto })
  @ApiResponse({ status: 201, description: 'SUCCESS (verdict VERIFIED·INVALID)', type: BattleReplaySubmittedResponseDto })
  @ApiResponse({ status: 401, description: '만료·무효 로그인 토큰 — 토큰 없이 다시 제출', type: AuthUnauthorizedErrorResponseDto })
  @ApiResponse({ status: 403, description: 'playerToken이 이 경기 참가자와 맞지 않음', type: TetrisBattlePlayerTokenInvalidErrorResponseDto })
  @ApiResponse({ status: 404, description: '없는 경기', type: TetrisBattleMatchNotFoundErrorResponseDto })
  @ApiResponse({
    status: 409,
    description: 'TETRIS_BATTLE_REPLAY_ALREADY_SUBMITTED 재제출 · TETRIS_BATTLE_MATCH_NOT_ENDED 진행 중',
    type: TetrisBattleMatchNotEndedErrorResponseDto,
  })
  @ApiResponse({ status: 410, description: '제출 마감(종료 후 60초) 지남', type: TetrisBattleSubmissionClosedErrorResponseDto })
  @ApiResponse({ status: 413, description: 'PAYLOAD_TOO_LARGE: 본문 300kb 초과' })
  @ApiCommonValidationResponse()
  @ApiThrottledResponse('요청 횟수 초과 (초당 2회 / 분당 20회)')
  @ApiResponse({ status: 503, description: '대전 상태 저장소(Redis) 사용 불가 · 같은 참가자의 제출을 검증하는 중(잠시 후 재시도)', type: TetrisBattleUnavailableErrorResponseDto })
  @ApiCommonInternalServerErrorResponse()
  async submitReplay(@Param('matchId') matchId: string, @Body() dto: SubmitBattleReplayDto, @CurrentUser() user?: User) {
    const data = await this.resultService.submitReplay({
      matchId,
      playerToken: dto.playerToken,
      replay: dto.replay,
      userId: user?.userId ?? null,
    });
    return { code: 'SUCCESS', data, message: '' };
  }

  @Get('matches/:matchId')
  @Throttle(THROTTLE_BATTLE_RESULT_READ)
  @ApiOperation({ summary: '대전 경기 결과', description: '숨김 아닌 저장된 경기. 검증 실패 참가자는 verdict INVALID로 표시(경기는 공개). 숨김·저장 전은 404' })
  @ApiParam(MATCH_ID_PARAM)
  @ApiResponse({ status: 200, description: 'SUCCESS (참가자 순위 오름차순)', type: BattleMatchResponseDto })
  @ApiResponse({ status: 404, description: '없음·숨김·아직 저장 전', type: TetrisBattleMatchNotFoundErrorResponseDto })
  @ApiThrottledResponse('요청 횟수 초과 (초당 3회 / 분당 60회)')
  @ApiCommonInternalServerErrorResponse()
  async getMatch(@Param('matchId') matchId: string) {
    const data = await this.resultService.getMatch(matchId);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Get('matches/:matchId/replays/:playerId')
  @Throttle(THROTTLE_BATTLE_RESULT_READ)
  @ApiOperation({ summary: '대전 리플레이', description: '저장된 경기의 VERIFIED 참가자만(MISSING·INVALID는 404). 같은 래퍼 버전으로 재생한다' })
  @ApiParam(MATCH_ID_PARAM)
  @ApiParam({ name: 'playerId', description: '참가자 ID (p1·p2…)', example: 'p1' })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: BattleReplayDetailResponseDto })
  @ApiResponse({
    status: 404,
    description: 'TETRIS_BATTLE_MATCH_NOT_FOUND 경기 없음·숨김 · TETRIS_BATTLE_REPLAY_NOT_FOUND 미제출·검증 실패',
    type: TetrisBattleReplayNotFoundErrorResponseDto,
  })
  @ApiThrottledResponse('요청 횟수 초과 (초당 3회 / 분당 60회)')
  @ApiCommonInternalServerErrorResponse()
  async getReplay(@Param('matchId') matchId: string, @Param('playerId') playerId: string) {
    const data = await this.resultService.getReplay(matchId, playerId);
    return { code: 'SUCCESS', data, message: '' };
  }
}

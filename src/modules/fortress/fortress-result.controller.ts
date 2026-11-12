import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  ApiCommonInternalServerErrorResponse,
  ApiCommonUnauthorizedResponse,
  ApiCommonValidationResponse,
  ApiThrottledResponse,
} from '../../common/decorators/api-error-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../entities/User';
import { THROTTLE_FORTRESS_RESULT_READ } from './fortress.constants';
import { FortressMatchPointsResponseDto } from './fortress-skin.dto';
import { FortressMatchNotFoundErrorResponseDto, FortressReplayNotFoundErrorResponseDto } from './fortress-error.dto';
import {
  FortressMatchListResponseDto,
  FortressMatchResponseDto,
  FortressReplayResponseDto,
  ListFortressMatchesQueryDto,
} from './fortress-result.dto';
import { FortressResultService } from './fortress-result.service';

const MATCH_ID_PARAM = {
  name: 'matchId',
  description: '경기 ID (matchStarting으로 받은 16자) — matchEnded.replay.id와 같다',
  example: 'AbCdEfGhIjKlMnOp',
};
const THROTTLED = '요청 횟수 초과 (초당 3회 / 분당 60회)';

/**
 * 포트리스 경기 결과·리플레이·최근 경기 (docs/tasks/fortress DESIGN §12, F6)
 *
 * 인증 없음 — 게스트도 결과·공유 링크·리플레이를 본다(테트리스 대전 결과 조회와 같음). 저장은 서버가 경기 종료 때 한다(제출 API 없음).
 */
@ApiTags('fortress')
@Controller('fortress')
export class FortressResultController {
  constructor(private readonly resultService: FortressResultService) {}

  @Get('matches')
  @Throttle(THROTTLE_FORTRESS_RESULT_READ)
  @ApiOperation({
    summary: '최근 포트리스 경기 목록',
    description: '숨김 아닌 저장된 경기, 최근 저장 순. 다음 페이지는 응답의 nextCursor를 cursor로 그대로 보낸다',
  })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: FortressMatchListResponseDto })
  @ApiCommonValidationResponse()
  @ApiThrottledResponse(THROTTLED)
  @ApiCommonInternalServerErrorResponse()
  async listMatches(@Query() query: ListFortressMatchesQueryDto) {
    const data = await this.resultService.listMatches(query);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Get('matches/:matchId')
  @Throttle(THROTTLE_FORTRESS_RESULT_READ)
  @ApiOperation({
    summary: '포트리스 경기 결과',
    description: '숨김 아닌 저장된 경기. 끝났는데 아직 저장 전이면 이 요청이 저장한 뒤 돌려준다. 없음·숨김·진행 중은 404',
  })
  @ApiParam(MATCH_ID_PARAM)
  @ApiResponse({ status: 200, description: 'SUCCESS (참가자 순위 오름차순, 같으면 slot 순)', type: FortressMatchResponseDto })
  @ApiResponse({ status: 404, description: '없음·숨김·진행 중', type: FortressMatchNotFoundErrorResponseDto })
  @ApiThrottledResponse(THROTTLED)
  @ApiCommonInternalServerErrorResponse()
  async getMatch(@Param('matchId') matchId: string) {
    const data = await this.resultService.getMatch(matchId);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Get('matches/:matchId/replay')
  @Throttle(THROTTLE_FORTRESS_RESULT_READ)
  @ApiOperation({
    summary: '포트리스 리플레이',
    description:
      '경기당 1개(replay id = matchId). 엔진 config·actions 그대로 — 같은 engineVersion 엔진의 simulateMatch(config, actions)로 재생, 마지막 stateHash로 대조',
  })
  @ApiParam(MATCH_ID_PARAM)
  @ApiResponse({ status: 200, description: 'SUCCESS', type: FortressReplayResponseDto })
  @ApiResponse({
    status: 404,
    description: 'FORTRESS_MATCH_NOT_FOUND 경기 없음·숨김·진행 중 · FORTRESS_REPLAY_NOT_FOUND 리플레이 행 없음',
    type: FortressReplayNotFoundErrorResponseDto,
  })
  @ApiThrottledResponse(THROTTLED)
  @ApiCommonInternalServerErrorResponse()
  async getReplay(@Param('matchId') matchId: string) {
    const data = await this.resultService.getReplay(matchId);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Get('matches/:matchId/points')
  @Throttle(THROTTLE_FORTRESS_RESULT_READ)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '이 경기에서 내가 얻은 포인트',
    description:
      '로그인 사용자 전용(DESIGN §13). 결과 화면용 — matchEnded에는 적립액이 없다(감쇠·일일 상한은 저장 때 정해진다). 끝났는데 저장 전이면 이 요청이 저장(적립 포함)한 뒤 돌려준다. 게스트로 참가했거나 참가하지 않았으면 participant false',
  })
  @ApiParam(MATCH_ID_PARAM)
  @ApiResponse({ status: 200, description: 'SUCCESS', type: FortressMatchPointsResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 404, description: '없음·숨김·진행 중', type: FortressMatchNotFoundErrorResponseDto })
  @ApiThrottledResponse(THROTTLED)
  @ApiCommonInternalServerErrorResponse()
  async getMyPoints(@Param('matchId') matchId: string, @CurrentUser() user: User) {
    const data = await this.resultService.getMyPoints(matchId, user.userId);
    return { code: 'SUCCESS', data, message: '' };
  }
}

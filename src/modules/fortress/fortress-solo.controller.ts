import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  ApiCommonInternalServerErrorResponse,
  ApiCommonUnauthorizedResponse,
  ApiThrottledResponse,
} from '../../common/decorators/api-error-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { User } from '../../entities/User';
import { THROTTLE_FORTRESS_SOLO_UPLOAD } from './fortress.constants';
import { FortressSoloEngineMismatchErrorResponseDto, FortressSoloReplayInvalidErrorResponseDto } from './fortress-error.dto';
import { UploadSoloMatchDto, UploadSoloMatchResponseDto } from './fortress-solo.dto';
import { FortressSoloService } from './fortress-solo.service';

/**
 * AI전·같은 기기 대전 기록 업로드 (docs/tasks/fortress DECISIONS D-027) — 온라인 경기와 달리 클라이언트에서만 돈 경기를
 * 서버가 엔진으로 다시 돌려 검증한 뒤 저장한다. 결과·리플레이 조회는 기존 FortressResultController(GET matches/:matchId·replay)
 */
@ApiTags('fortress')
@Controller('fortress')
export class FortressSoloController {
  constructor(private readonly soloService: FortressSoloService) {}

  @Post('solo-matches')
  @HttpCode(201)
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle(THROTTLE_FORTRESS_SOLO_UPLOAD)
  @ApiOperation({
    summary: 'AI전·같은 기기 대전 기록 업로드 (공유용)',
    description:
      '게스트 가능. 서버가 엔진으로 처음부터 다시 돌려 규칙에 맞게 끝난 경기인지 확인한 뒤 저장하고 matchId를 돌려준다 — 결과·리플레이는 기존 GET matches/:matchId·replay로 본다(source solo). 포인트·랭킹 없음, 최근 목록에 나오지 않는다. 이름은 서버가 정하고(P{n}·P{n} (AI 하·중·상)), 스킨은 로그인이면 첫 사람 자리만 계정 장착. 토큰이 있는데 무효면 401',
  })
  @ApiBody({ type: UploadSoloMatchDto })
  @ApiResponse({ status: 201, description: 'SUCCESS', type: UploadSoloMatchResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 409, description: 'FORTRESS_SOLO_ENGINE_MISMATCH 서버 엔진 버전과 다름', type: FortressSoloEngineMismatchErrorResponseDto })
  // 422 두 갈래를 한 항목으로 — Swagger는 상태코드당 응답 스키마 하나만 남긴다(리뷰 A, games.controller와 같은 방식)
  @ApiResponse({
    status: 422,
    description:
      'VALIDATION_ERROR 요청 형식(모르는 필드·이름/스킨 필드 포함) · FORTRESS_SOLO_REPLAY_INVALID 재시뮬레이션 실패 — details.reason CONFIG·ACTION(details.at)·NOT_ENDED·HASH',
    type: FortressSoloReplayInvalidErrorResponseDto,
  })
  @ApiResponse({ status: 413, description: 'PAYLOAD_TOO_LARGE: 본문 300kb 초과' })
  @ApiThrottledResponse('요청 횟수 초과 (초당 1회 / 분당 6회)')
  @ApiCommonInternalServerErrorResponse()
  async uploadSolo(@Body() dto: UploadSoloMatchDto, @CurrentUser() user: User | undefined) {
    const data = await this.soloService.upload(dto, user?.userId ?? null);
    return { code: 'SUCCESS', data, message: '' };
  }
}

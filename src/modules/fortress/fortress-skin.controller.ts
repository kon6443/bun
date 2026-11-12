import { Body, Controller, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonUnauthorizedResponse, ApiCommonValidationResponse } from '../../common/decorators/api-error-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../entities/User';
import {
  UserNotFoundErrorResponseDto,
  UserPointsInsufficientErrorResponseDto,
  UserSkinNotOwnedErrorResponseDto,
  UserSkinUnknownErrorResponseDto,
} from '../users/users-error.dto';
import { EquipFortressSkinDto, FortressSkinsResponseDto, UpgradeFortressSkinDto } from './fortress-skin.dto';
import { FortressSkinService } from './fortress-skin.service';

/**
 * 포트리스 탱크 스킨 (docs/tasks/fortress DESIGN §13) — 로그인 전용. 의미·에러는 테트리스 `users/me/skins`와 같고 슬롯이 탱크 1개다.
 * 장착은 다음 방 입장·재연결 때 대기실·경기 화면에 반영되고, 경기 시작 때 리플레이에 고정된다
 */
@ApiTags('fortress')
@ApiBearerAuth()
@Controller('fortress/skins')
export class FortressSkinController {
  constructor(private readonly skinService: FortressSkinService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '내 탱크 스킨 — 장착·아이템·레벨·포인트', description: '로그인 사용자 전용. 아이템마다 보유·장착·레벨·다음 강화 비용, 공용 포인트 지갑' })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: FortressSkinsResponseDto })
  @ApiCommonUnauthorizedResponse()
  async getSkins(@CurrentUser() user: User) {
    const data = await this.skinService.getSkins(user.userId);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Put('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: '탱크 스킨 장착',
    description: '로그인 사용자 전용. 대기실·경기·리플레이에서 남에게도 보인다. 방에 있으면 다음 입장·재연결 때 반영(진행 중인 경기 자리는 바뀌지 않는다)',
  })
  @ApiResponse({ status: 200, description: '장착 성공 — GET me와 같은 형태', type: FortressSkinsResponseDto })
  @ApiCommonValidationResponse()
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '아직 얻지 않은 아이템 (USER_SKIN_NOT_OWNED)', type: UserSkinNotOwnedErrorResponseDto })
  @ApiResponse({ status: 422, description: '카탈로그에 없는 아이템 (USER_SKIN_UNKNOWN, details { slot: tank, id })', type: UserSkinUnknownErrorResponseDto })
  async equip(@CurrentUser() user: User, @Body() dto: EquipFortressSkinDto) {
    const data = await this.skinService.equip(user.userId, dto.skinId);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Post('me/upgrade')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: '탱크 스킨 한 단계 강화',
    description:
      '로그인 사용자 전용. 공용 포인트를 써서 한 단계 올린다(비용은 테트리스 스킨과 같다). level은 목표 레벨 — 이미 그 레벨 이상이면 차감 없이 지금 상태(중복 클릭 안전)',
  })
  @ApiResponse({ status: 200, description: '강화 성공(또는 이미 그 레벨) — GET me와 같은 형태', type: FortressSkinsResponseDto })
  @ApiCommonValidationResponse()
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '아직 얻지 않은 아이템 (USER_SKIN_NOT_OWNED)', type: UserSkinNotOwnedErrorResponseDto })
  @ApiResponse({
    status: 409,
    description: '포인트 부족 (USER_POINTS_INSUFFICIENT, details { balance, cost }) · 한 단계를 건너뜀 (USER_SKIN_LEVEL_MISMATCH, details { slot: tank, id, level(현재) })',
    type: UserPointsInsufficientErrorResponseDto,
  })
  @ApiResponse({ status: 404, description: '사용자를 찾을 수 없음 (USER_NOT_FOUND)', type: UserNotFoundErrorResponseDto })
  @ApiResponse({ status: 422, description: '카탈로그에 없는 아이템 (USER_SKIN_UNKNOWN)', type: UserSkinUnknownErrorResponseDto })
  async upgrade(@CurrentUser() user: User, @Body() dto: UpgradeFortressSkinDto) {
    const data = await this.skinService.upgrade(user.userId, dto.skinId, dto.level);
    return { code: 'SUCCESS', data, message: '' };
  }
}

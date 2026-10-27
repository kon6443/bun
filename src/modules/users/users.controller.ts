import { Controller, Get, Put, Post, Body, HttpCode, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UserSkinService } from './user-skin.service';
import {
  UpdateUserDto,
  UserProfileResponseDto,
  UpdateUserResponseDto,
  UpdateUserSkinsDto,
  UpgradeUserSkinDto,
  UserSkinsResponseDto,
  GetPointHistoryQueryDto,
  PointHistoryResponseDto,
} from './users.dto';
import { UserPointService } from './user-point.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../entities/User';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCommonUnauthorizedResponse,
  ApiCommonValidationResponse,
} from '../../common/decorators/api-error-response.decorator';
import {
  UserNotFoundErrorResponseDto,
  UserPointsInsufficientErrorResponseDto,
  UserSkinNotOwnedErrorResponseDto,
  UserSkinUnknownErrorResponseDto,
} from './users-error.dto';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly userSkinService: UserSkinService,
    private readonly userPointService: UserPointService,
  ) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '내 프로필 조회' })
  @ApiResponse({ status: 200, description: '프로필 조회 성공', type: UserProfileResponseDto })
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 404, description: '사용자를 찾을 수 없음', type: UserNotFoundErrorResponseDto })
  async getProfile(@CurrentUser() user: User) {
    const data = await this.usersService.getProfile(user.userId);
    return {
      code: 'SUCCESS',
      data,
      message: '',
    };
  }

  @Put('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '내 프로필 수정 (닉네임)' })
  @ApiResponse({ status: 200, description: '프로필 수정 성공', type: UpdateUserResponseDto })
  @ApiCommonValidationResponse()
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 404, description: '사용자를 찾을 수 없음', type: UserNotFoundErrorResponseDto })
  async updateProfile(@CurrentUser() user: User, @Body() dto: UpdateUserDto) {
    const data = await this.usersService.updateProfile(user.userId, dto);
    return {
      code: 'SUCCESS',
      data,
      message: '',
    };
  }

  @Get('me/skins')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: '내 스킨 — 장착 상태와 카탈로그',
    description: '로그인 사용자 전용. 슬롯(block·effect·board·background)마다 장착한 아이템·그 레벨, 아이템 목록(보유·레벨·다음 비용), 포인트 (docs/tasks/tetris-skins D-003 · skin-levels D-002)',
  })
  @ApiResponse({ status: 200, description: '조회 성공', type: UserSkinsResponseDto })
  @ApiCommonUnauthorizedResponse()
  async getSkins(@CurrentUser() user: User) {
    const data = await this.userSkinService.getSkins(user.userId);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Put('me/skins')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: '스킨 장착',
    description:
      '로그인 사용자 전용. 보낸 슬롯만 바꾼다. 보드 슬롯(block·effect·board)은 남의 화면(대전 상대·리플레이)에서도 이 사용자 보드에 쓰이고, background는 내 화면에만. 대전 중이면 다음 입장·재연결 때 반영',
  })
  @ApiResponse({ status: 200, description: '장착 성공 — 장착 상태와 카탈로그', type: UserSkinsResponseDto })
  @ApiCommonValidationResponse()
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '아직 얻지 않은 아이템 (USER_SKIN_NOT_OWNED)', type: UserSkinNotOwnedErrorResponseDto })
  @ApiResponse({ status: 422, description: '카탈로그에 없는 아이템 (USER_SKIN_UNKNOWN)', type: UserSkinUnknownErrorResponseDto })
  async updateSkins(@CurrentUser() user: User, @Body() dto: UpdateUserSkinsDto) {
    const data = await this.userSkinService.equip(user.userId, dto);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Post('me/skins/upgrade')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: '스킨 한 단계 강화',
    description:
      '로그인 사용자 전용. 포인트(원장 합계 — 로그인 테트리스 기록 적립 − 소비)를 써서 아이템(슬롯 × 아이템)을 한 단계 올린다. level은 목표 레벨 — 이미 그 레벨 이상이면 차감 없이 지금 상태(중복 클릭 안전). 대전 중이면 다음 입장·재연결 때 반영 (docs/tasks/skin-levels D-002·D-004)',
  })
  @ApiResponse({ status: 200, description: '강화 성공(또는 이미 그 레벨) — GET me/skins와 같은 형태', type: UserSkinsResponseDto })
  @ApiCommonValidationResponse()
  @ApiCommonUnauthorizedResponse()
  @ApiResponse({ status: 403, description: '아직 얻지 않은 아이템 (USER_SKIN_NOT_OWNED)', type: UserSkinNotOwnedErrorResponseDto })
  @ApiResponse({
    status: 409,
    description:
      '포인트 부족 (USER_POINTS_INSUFFICIENT, details { balance, cost }) · 한 단계를 건너뜀 (USER_SKIN_LEVEL_MISMATCH, details { slot, id, level(현재) }) — 응답 형식은 같고 code만 다르다',
    type: UserPointsInsufficientErrorResponseDto,
  })
  @ApiResponse({ status: 404, description: '사용자를 찾을 수 없음 (USER_NOT_FOUND)', type: UserNotFoundErrorResponseDto })
  @ApiResponse({ status: 422, description: '카탈로그에 없는 아이템 (USER_SKIN_UNKNOWN)', type: UserSkinUnknownErrorResponseDto })
  async upgradeSkin(@CurrentUser() user: User, @Body() dto: UpgradeUserSkinDto) {
    const data = await this.userSkinService.upgrade(user.userId, dto.slot, dto.skinId, dto.level);
    return { code: 'SUCCESS', data, message: '' };
  }

  @Get('me/points/history')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: '내 포인트 내역',
    description: '로그인 사용자 전용. 포인트 원장 최신순(적립·소비·보상) + 현재 포인트. 다음 페이지는 nextCursor를 beforeId로, type=earn|spend로 거르기 (docs/tasks/skin-levels D-004·D-005)',
  })
  @ApiResponse({ status: 200, description: '조회 성공', type: PointHistoryResponseDto })
  @ApiCommonValidationResponse()
  @ApiCommonUnauthorizedResponse()
  async getPointHistory(@CurrentUser() user: User, @Query() query: GetPointHistoryQueryDto) {
    const data = await this.userPointService.history(user.userId, query);
    return { code: 'SUCCESS', data, message: '' };
  }
}

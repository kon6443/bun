import { Controller, Get, Put, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UserSkinService } from './user-skin.service';
import {
  UpdateUserDto,
  UserProfileResponseDto,
  UpdateUserResponseDto,
  UpdateUserSkinsDto,
  UserSkinsResponseDto,
} from './users.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../entities/User';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCommonUnauthorizedResponse,
  ApiCommonValidationResponse,
} from '../../common/decorators/api-error-response.decorator';
import {
  UserNotFoundErrorResponseDto,
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
    description: '로그인 사용자 전용. 슬롯(block·effect·board·background)마다 장착한 아이템과 아이템 목록·보유 여부 (docs/tasks/tetris-skins D-003)',
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
}

import { Controller, Get, Put, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto, UserProfileResponseDto, UpdateUserResponseDto } from './users.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../entities/User';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCommonUnauthorizedResponse,
  ApiCommonValidationResponse,
} from '../../common/decorators/api-error-response.decorator';
import { UserNotFoundErrorResponseDto } from './users-error.dto';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

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
}

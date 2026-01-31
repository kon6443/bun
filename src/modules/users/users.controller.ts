import { Controller, Get, Put, Body, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserProfileResponseDto } from './dto/response/user-profile-response.dto';
import { UpdateUserResponseDto } from './dto/response/update-user-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../entities/User';

type RequestWithUser = Request & { user: User };

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '내 프로필 조회' })
  @ApiResponse({ status: 200, description: '프로필 조회 성공', type: UserProfileResponseDto })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 404, description: '사용자를 찾을 수 없음' })
  async getProfile(@Req() req: RequestWithUser) {
    const userId = req.user.userId;
    const data = await this.usersService.getProfile(userId);
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
  @ApiResponse({ status: 400, description: '잘못된 요청' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 404, description: '사용자를 찾을 수 없음' })
  async updateProfile(@Req() req: RequestWithUser, @Body() dto: UpdateUserDto) {
    const userId = req.user.userId;
    const data = await this.usersService.updateProfile(userId, dto);
    return {
      code: 'SUCCESS',
      data,
      message: '',
    };
  }
}

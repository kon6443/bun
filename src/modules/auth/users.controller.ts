import { Controller, Put, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { UpdateUserNameDto, UpdateUserNameResponseDto } from './auth.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../entities/User';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly authService: AuthService) {}

  @UseGuards(JwtAuthGuard)
  @Put('me')
  @ApiOperation({ summary: '내 닉네임 수정' })
  @ApiBody({ type: UpdateUserNameDto })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: UpdateUserNameResponseDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async updateMyName(
    @CurrentUser() user: User,
    @Body() dto: UpdateUserNameDto,
  ) {
    const result = await this.authService.updateUserName(user.userId, dto.userName);
    return { code: 'SUCCESS', data: result, message: '' };
  }
}

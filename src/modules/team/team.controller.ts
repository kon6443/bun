import { Controller, Get, Query, Headers, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiHeader } from '@nestjs/swagger';
import { TeamService } from './team.service';

@ApiTags('teams')
@Controller('teams')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Get()
  @ApiOperation({ summary: '내 팀 목록 조회' })
  @ApiQuery({ name: 'userId', required: false, type: Number })
  @ApiHeader({ name: 'x-user-id', required: false })
  @ApiResponse({ status: 200, description: '성공' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  async getMyTeams(
    @Query('userId') queryUserId?: string,
    @Headers('x-user-id') headerUserId?: string,
  ) {
    const rawUserId = headerUserId || queryUserId;
    if (!rawUserId) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    const userId = Number(rawUserId);
    if (Number.isNaN(userId)) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    const teams = await this.teamService.getTeamsByUserId(userId);
    return { data: teams };
  }
}


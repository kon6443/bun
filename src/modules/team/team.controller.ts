import { Controller, Get, Post, Req, UseGuards, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { TeamService } from './team.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Request } from 'express';
import { User } from '../../entities/User';
import { CreateTeamDto } from './dto/create-team.dto';

@ApiTags('teams')
@Controller('teams')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: '내 팀 목록 조회' })
  @ApiResponse({ status: 200, description: 'SUCCESS' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async getMyTeams(@Req() req: Request & { user: User }) {
    const user = req.user;
    console.log(user);
    const teamMembers = await this.teamService.getTeamMembersBy({ userIds: [user.userId], actStatus: [1]});
    return { data: teamMembers };
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  @ApiOperation({ summary: '팀 생성' })
  @ApiBody({ type: CreateTeamDto })
  @ApiResponse({ status: 200, description: 'SUCCESS' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async postMyTeams(
    @Req() req: Request & { user: User },
    @Body() createTeamDto: CreateTeamDto,
  ) {
    const user = req.user;
    createTeamDto.actStatus = 1;
    createTeamDto.leaderId = user.userId;
    await this.teamService.insertTeam({ createTeamDto });
    return { message: 'SUCCESS', action: '' };
  }
}


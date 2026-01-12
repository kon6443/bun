import { Controller, Get, Post, Patch, Req, UseGuards, Body, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam } from '@nestjs/swagger';
import { TeamService } from './team.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Request } from 'express';
import { User } from '../../entities/User';
import { CreateTeamDto } from './dto/create-team.dto';
import { CreateTeamTaskDto } from './dto/create-team-task.dto';
import { UpdateTeamTaskDto } from './dto/update-team-task.dto';
import { TeamMemberListResponseDto } from './dto/response/team-member-response.dto';
import { CreateTeamResponseDto } from './dto/response/create-team-response.dto';
import { CreateTeamTaskResponseDto, UpdateTeamTaskResponseDto } from './dto/response/team-task-response.dto';

@ApiTags('teams')
@Controller('teams')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: '내 팀 목록 조회' })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: TeamMemberListResponseDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async getMyTeams(@Req() req: Request & { user: User }) {
    const user = req.user;
    console.log(user);
    const teamMembers = await this.teamService.getTeamMembersBy({ userIds: [user.userId], actStatus: [1] });
    return { data: teamMembers };
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  @ApiOperation({ summary: '팀 생성' })
  @ApiBody({ type: CreateTeamDto })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: CreateTeamResponseDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async postMyTeams(@Req() req: Request & { user: User }, @Body() createTeamDto: CreateTeamDto) {
    const user = req.user;
    createTeamDto.actStatus = 1;
    createTeamDto.leaderId = user.userId;
    await this.teamService.insertTeam({ createTeamDto });
    return { message: 'SUCCESS', action: '' };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':teamId/tasks')
  @ApiOperation({ summary: '팀 태스크 생성' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiBody({ type: CreateTeamTaskDto })
  @ApiResponse({ status: 201, description: 'SUCCESS', type: CreateTeamTaskResponseDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async createTask(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() createTaskDto: CreateTeamTaskDto,
  ) {
    const user = req.user;
    const task = await this.teamService.createTask({
      teamId,
      createTaskDto,
      userId: user.userId,
    });
    return { message: 'SUCCESS', data: task };
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':teamId/tasks/:taskId')
  @ApiOperation({ summary: '팀 태스크 수정' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiParam({ name: 'taskId', description: '태스크 ID', type: Number })
  @ApiBody({ type: UpdateTeamTaskDto })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: UpdateTeamTaskResponseDto })
  @ApiResponse({ status: 400, description: '태스크가 해당 팀에 속하지 않습니다.' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 멤버만 태스크를 수정할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '팀 또는 태스크를 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async updateTask(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('taskId', ParseIntPipe) taskId: number,
    @Body() updateTaskDto: UpdateTeamTaskDto,
  ) {
    const user = req.user;
    const task = await this.teamService.updateTask({
      teamId,
      taskId,
      updateTaskDto,
      userId: user.userId,
    });
    return { message: 'SUCCESS', data: task };
  }
}

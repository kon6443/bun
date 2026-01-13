import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Req,
  UseGuards,
  Body,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam } from '@nestjs/swagger';
import { TeamService } from './team.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Request } from 'express';
import { User } from '../../entities/User';
import { CreateTeamDto } from './dto/create-team.dto';
import { CreateTeamTaskDto } from './dto/create-team-task.dto';
import { UpdateTeamTaskDto } from './dto/update-team-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { UpdateTaskActiveStatusDto } from './dto/update-task-active-status.dto';
import { CreateTaskCommentDto } from './dto/create-task-comment.dto';
import { UpdateTaskCommentDto } from './dto/update-task-comment.dto';
import { ActStatus } from '../../common/enums/task-status.enum';
import { TeamMemberListResponseDto } from './dto/response/team-member-response.dto';
import { CreateTeamResponseDto } from './dto/response/create-team-response.dto';
import {
  CreateTeamTaskResponseDto,
  UpdateTeamTaskResponseDto,
  TeamTaskListResponseDto,
  GetTaskDetailResponseDto,
} from './dto/response/team-task-response.dto';
import {
  CreateTaskCommentResponseDto,
  UpdateTaskCommentResponseDto,
  DeleteTaskCommentResponseDto,
} from './dto/response/task-comment-response.dto';

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
    const teamMembers = await this.teamService.getTeamMembersBy({
      userIds: [user.userId],
      actStatus: [ActStatus.ACTIVE],
    });
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
    createTeamDto.actStatus = ActStatus.ACTIVE;
    createTeamDto.leaderId = user.userId;
    await this.teamService.insertTeam({ createTeamDto });
    return { message: 'SUCCESS', action: '' };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':teamId/tasks')
  @ApiOperation({ summary: '팀 태스크 목록 조회' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: TeamTaskListResponseDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async getTasks(@Req() req: Request & { user: User }, @Param('teamId', ParseIntPipe) teamId: number) {
    const user = req.user;
    const tasks = await this.teamService.getTasksByTeamId(teamId, user.userId);
    return { message: 'SUCCESS', data: tasks };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':teamId/tasks/:taskId')
  @ApiOperation({ summary: '팀 태스크 상세 조회' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiParam({ name: 'taskId', description: '태스크 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: GetTaskDetailResponseDto })
  @ApiResponse({ status: 400, description: '태스크가 해당 팀에 속하지 않습니다.' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '태스크를 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async getTaskDetail(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('taskId', ParseIntPipe) taskId: number,
  ) {
    const user = req.user;
    const { task, comments } = await this.teamService.getTaskWithComments(teamId, taskId, user.userId);
    return {
      message: 'SUCCESS',
      data: {
        ...task,
        comments,
      },
    };
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

  @UseGuards(JwtAuthGuard)
  @Put(':teamId/tasks/:taskId/status')
  @ApiOperation({ summary: '팀 태스크 작업 상태 변경' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiParam({ name: 'taskId', description: '태스크 ID', type: Number })
  @ApiBody({ type: UpdateTaskStatusDto })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: UpdateTeamTaskResponseDto })
  @ApiResponse({ status: 400, description: '태스크가 해당 팀에 속하지 않습니다.' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 멤버만 태스크 상태를 변경할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '태스크를 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async updateTaskStatus(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('taskId', ParseIntPipe) taskId: number,
    @Body() updateStatusDto: UpdateTaskStatusDto,
  ) {
    const user = req.user;
    const task = await this.teamService.updateTaskStatus({
      teamId,
      taskId,
      updateStatusDto,
      userId: user.userId,
    });
    return { message: 'SUCCESS', data: task };
  }

  @UseGuards(JwtAuthGuard)
  @Put(':teamId/tasks/:taskId/active-status')
  @ApiOperation({ summary: '팀 태스크 활성 상태 변경' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiParam({ name: 'taskId', description: '태스크 ID', type: Number })
  @ApiBody({ type: UpdateTaskActiveStatusDto })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: UpdateTeamTaskResponseDto })
  @ApiResponse({ status: 400, description: '태스크가 해당 팀에 속하지 않습니다.' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 멤버만 태스크 활성 상태를 변경할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '태스크를 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async updateTaskActiveStatus(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('taskId', ParseIntPipe) taskId: number,
    @Body() updateActiveStatusDto: UpdateTaskActiveStatusDto,
  ) {
    const user = req.user;
    const task = await this.teamService.updateTaskActiveStatus({
      teamId,
      taskId,
      updateActiveStatusDto,
      userId: user.userId,
    });
    return { message: 'SUCCESS', data: task };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':teamId/tasks/:taskId/comments')
  @ApiOperation({ summary: '팀 태스크 댓글 생성' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiParam({ name: 'taskId', description: '태스크 ID', type: Number })
  @ApiBody({ type: CreateTaskCommentDto })
  @ApiResponse({ status: 201, description: 'SUCCESS', type: CreateTaskCommentResponseDto })
  @ApiResponse({ status: 400, description: '태스크가 해당 팀에 속하지 않습니다.' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 멤버만 댓글을 작성할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '팀 또는 태스크를 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async createTaskComment(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('taskId', ParseIntPipe) taskId: number,
    @Body() createCommentDto: CreateTaskCommentDto,
  ) {
    const user = req.user;
    const comment = await this.teamService.createTaskComment({
      teamId,
      taskId,
      createCommentDto,
      userId: user.userId,
    });
    return { message: 'SUCCESS', data: comment };
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':teamId/tasks/:taskId/comments/:commentId')
  @ApiOperation({ summary: '팀 태스크 댓글 수정' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiParam({ name: 'taskId', description: '태스크 ID', type: Number })
  @ApiParam({ name: 'commentId', description: '댓글 ID', type: Number })
  @ApiBody({ type: UpdateTaskCommentDto })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: UpdateTaskCommentResponseDto })
  @ApiResponse({ status: 400, description: '댓글이 해당 태스크/팀에 속하지 않거나 이미 삭제된 댓글입니다.' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '댓글 작성자만 수정할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '댓글을 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async updateTaskComment(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('taskId', ParseIntPipe) taskId: number,
    @Param('commentId', ParseIntPipe) commentId: number,
    @Body() updateCommentDto: UpdateTaskCommentDto,
  ) {
    const user = req.user;
    const comment = await this.teamService.updateTaskComment({
      teamId,
      taskId,
      commentId,
      updateCommentDto,
      userId: user.userId,
    });
    return { message: 'SUCCESS', data: comment };
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':teamId/tasks/:taskId/comments/:commentId')
  @ApiOperation({ summary: '팀 태스크 댓글 삭제(비활성화)' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiParam({ name: 'taskId', description: '태스크 ID', type: Number })
  @ApiParam({ name: 'commentId', description: '댓글 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: DeleteTaskCommentResponseDto })
  @ApiResponse({ status: 400, description: '댓글이 해당 태스크/팀에 속하지 않거나 이미 삭제된 댓글입니다.' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '댓글 작성자만 삭제할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '댓글을 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async deleteTaskComment(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('taskId', ParseIntPipe) taskId: number,
    @Param('commentId', ParseIntPipe) commentId: number,
  ) {
    const user = req.user;
    await this.teamService.deleteTaskComment({
      teamId,
      taskId,
      commentId,
      userId: user.userId,
    });
    return { message: 'SUCCESS' };
  }
}

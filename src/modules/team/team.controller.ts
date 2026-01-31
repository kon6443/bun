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
import { Request } from 'express';
import { TeamService } from './team.service';
import {
  CreateTeamDto,
  UpdateTeamDto,
  CreateTeamTaskDto,
  UpdateTeamTaskDto,
  UpdateTaskStatusDto,
  UpdateTaskActiveStatusDto,
  CreateTaskCommentDto,
  UpdateTaskCommentDto,
  CreateTeamInviteDto,
  AcceptTeamInviteDto,
  TeamMemberListResponseDto,
  CreateTeamResponseDto,
  UpdateTeamResponseDto,
  CreateTeamTaskResponseDto,
  UpdateTeamTaskResponseDto,
  TeamTaskListResponseDto,
  GetTaskDetailResponseDto,
  CreateTaskCommentResponseDto,
  UpdateTaskCommentResponseDto,
  DeleteTaskCommentResponseDto,
  TeamUsersListResponseDto,
  CreateTeamInviteResponseDto,
  AcceptTeamInviteResponseDto,
  CreateTelegramLinkResponseDto,
  TelegramStatusResponseDto,
  DeleteTelegramLinkResponseDto,
} from './team.dto';
import { TeamForbiddenErrorResponseDto } from './team-error.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { User } from '../../entities/User';
import { ActStatus } from '../../common/enums/task-status.enum';
import { TelegramService } from '../notification/telegram.service';

@ApiTags('teams')
@Controller('teams')
export class TeamController {
  constructor(
    private readonly teamService: TeamService,
    private readonly telegramService: TelegramService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: '내 팀 목록 조회' })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: TeamMemberListResponseDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async getMyTeams(@Req() req: Request & { user: User }) {
    const user = req.user;
    const teamMembers = await this.teamService.getTeamMembersBy({
      userIds: [user.userId],
      actStatus: [ActStatus.ACTIVE],
    });
    return { code: 'SUCCESS', data: teamMembers, message: '' };
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
    return { code: 'SUCCESS', data: null, message: '' };
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':teamId')
  @ApiOperation({ summary: '팀 정보 수정' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiBody({ type: UpdateTeamDto })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: UpdateTeamResponseDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 멤버만 팀 정보를 수정할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async updateTeam(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() updateTeamDto: UpdateTeamDto,
  ) {
    const user = req.user;
    const team = await this.teamService.updateTeam({
      teamId,
      updateTeamDto,
      userId: user.userId,
    });
    return {
      code: 'SUCCESS',
      data: {
        teamId: team.teamId,
        teamName: team.teamName,
        teamDescription: team.teamDescription,
        leaderId: team.leaderId,
        crtdAt: team.crtdAt,
        actStatus: team.actStatus,
      },
      message: '',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':teamId/users')
  @ApiOperation({ summary: '팀 사용자 목록 조회' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: TeamUsersListResponseDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async getTeamUsers(@Req() req: Request & { user: User }, @Param('teamId', ParseIntPipe) teamId: number) {
    const user = req.user;
    const users = await this.teamService.getTeamUsers(teamId, user.userId);
    return { code: 'SUCCESS', data: users, message: '' };
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
    const { team, tasks } = await this.teamService.getTasksByTeamId(teamId, user.userId);
    return {
      code: 'SUCCESS',
      data: {
        team: {
          teamId: team.teamId,
          teamName: team.teamName,
          teamDescription: team.teamDescription,
          leaderId: team.leaderId,
          crtdAt: team.crtdAt,
          actStatus: team.actStatus,
        },
        tasks,
      },
      message: '',
    };
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
      code: 'SUCCESS',
      data: {
        ...task,
        comments,
      },
      message: '',
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
    return { code: 'SUCCESS', data: task, message: '' };
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
    return { code: 'SUCCESS', data: task, message: '' };
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
    return { code: 'SUCCESS', data: task, message: '' };
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
    return { code: 'SUCCESS', data: task, message: '' };
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
    return { code: 'SUCCESS', data: comment, message: '' };
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
    return { code: 'SUCCESS', data: comment, message: '' };
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
    return { code: 'SUCCESS', data: null, message: '' };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':teamId/invites')
  @ApiOperation({ summary: '팀 초대 링크 생성' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiBody({ type: CreateTeamInviteDto })
  @ApiResponse({ status: 201, description: 'SUCCESS', type: CreateTeamInviteResponseDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 리더 또는 매니저만 초대 링크를 생성할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async createTeamInvite(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() createInviteDto: CreateTeamInviteDto,
  ) {
    const user = req.user;
    const result = await this.teamService.createTeamInvite({
      teamId,
      createInviteDto,
      userId: user.userId,
    });
    return {
      code: 'SUCCESS',
      data: result,
      message: '',
    };
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Post('invites/accept')
  @ApiOperation({ summary: '팀 초대 수락 (비회원도 가능)' })
  @ApiBody({ type: AcceptTeamInviteDto })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: AcceptTeamInviteResponseDto })
  @ApiResponse({
    status: 400,
    description: '유효하지 않거나 만료된 초대 링크입니다. 또는 이미 팀 멤버입니다.',
  })
  @ApiResponse({ status: 401, description: '회원가입이 필요합니다. (비회원인 경우)' })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async acceptTeamInvite(
    @Req() req: Request & { user?: User },
    @Body() acceptInviteDto: AcceptTeamInviteDto,
  ) {
    const userId = req.user?.userId || null;
    const result = await this.teamService.acceptTeamInvite({
      token: acceptInviteDto.token,
      userId,
    });
    return {
      code: 'SUCCESS',
      data: result,
      message: '',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':teamId/invites')
  @ApiOperation({ summary: '팀 초대 링크 목록 조회' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 리더 또는 매니저만 초대 링크를 조회할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async getTeamInvites(@Req() req: Request & { user: User }, @Param('teamId', ParseIntPipe) teamId: number) {
    const user = req.user;
    const invites = await this.teamService.getTeamInvites(teamId, user.userId);
    return {
      code: 'SUCCESS',
      data: invites,
      message: '',
    };
  }

  // ==================== 텔레그램 연동 API ====================

  @UseGuards(JwtAuthGuard)
  @Post(':teamId/telegram/link')
  @ApiOperation({ summary: '텔레그램 연동 링크 생성' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 201, description: 'SUCCESS', type: CreateTelegramLinkResponseDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 리더 또는 매니저만 텔레그램 연동을 할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async createTelegramLink(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
  ) {
    const user = req.user;
    // MASTER/MANAGER 권한 체크
    const [teamMembers] = await this.teamService.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [user.userId],
      actStatus: [ActStatus.ACTIVE],
    });

    if (!teamMembers || !['MASTER', 'MANAGER'].includes(teamMembers?.role)) {
      throw new TeamForbiddenErrorResponseDto('팀 리더 또는 매니저만 텔레그램 연동을 할 수 있습니다.');
    }

    const result = await this.telegramService.generateLinkToken(teamId);
    return {
      code: 'SUCCESS',
      data: result,
      message: '',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':teamId/telegram/status')
  @ApiOperation({ summary: '텔레그램 연동 상태 조회' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: TelegramStatusResponseDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 멤버만 접근할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async getTelegramStatus(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
  ) {
    const user = req.user;
    // 팀 멤버 확인
    await this.teamService.verifyTeamMemberAccess(teamId, user.userId);

    const status = await this.telegramService.getLinkStatus(teamId);
    return {
      message: 'SUCCESS',
      data: status,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':teamId/telegram/link')
  @ApiOperation({ summary: '텔레그램 연동 해제' })
  @ApiParam({ name: 'teamId', description: '팀 ID', type: Number })
  @ApiResponse({ status: 200, description: 'SUCCESS', type: DeleteTelegramLinkResponseDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: '팀 리더 또는 매니저만 텔레그램 연동을 해제할 수 있습니다.' })
  @ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.' })
  @ApiResponse({ status: 500, description: 'INTERNAL SERVER ERROR' })
  async deleteTelegramLink(
    @Req() req: Request & { user: User },
    @Param('teamId', ParseIntPipe) teamId: number,
  ) {
    const user = req.user;
    // MASTER/MANAGER 권한 체크
    const [teamMembers] = await this.teamService.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [user.userId],
      actStatus: [ActStatus.ACTIVE],
    });

    if (!teamMembers || !['MASTER', 'MANAGER'].includes(teamMembers?.role)) {
      throw new TeamForbiddenErrorResponseDto('팀 리더 또는 매니저만 텔레그램 연동을 해제할 수 있습니다.');
    }

    await this.telegramService.unlinkTeam(teamId);
    return { code: 'SUCCESS', data: null, message: '' };
  }
}

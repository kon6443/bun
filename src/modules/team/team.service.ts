import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { INVITE_MAX_EXPIRATION_MS, INVITE_TOKEN_EXPIRY_SECONDS } from '../../common/constants/app.constants';
import { sign, verify, JwtPayload } from 'jsonwebtoken';
import { TeamMember } from '../../entities/TeamMember';
import { Team } from '../../entities/Team';
import { TeamTask } from '../../entities/TeamTask';
import { TaskComment } from '../../entities/TaskComment';
import { TeamInvitation } from '../../entities/TeamInvitation';
import { User } from '../../entities/User';
import {
  CreateTeamDto,
  UpdateTeamDto,
  CreateTeamTaskDto,
  UpdateTeamTaskDto,
  CreateTaskCommentDto,
  UpdateTaskCommentDto,
  UpdateTaskStatusDto,
  UpdateTaskActiveStatusDto,
  CreateTeamInviteDto,
  TeamMemberRoleType,
  MemberStatusFilterType,
} from './team.dto';
import {
  TeamNotFoundErrorResponseDto,
  TeamForbiddenErrorResponseDto,
  TeamTaskNotFoundErrorResponseDto,
  TeamTaskBadRequestErrorResponseDto,
  TeamCommentNotFoundErrorResponseDto,
  TeamCommentForbiddenErrorResponseDto,
  TeamInviteNotFoundErrorResponseDto,
  TeamInviteExpiredErrorResponseDto,
  TeamInviteForbiddenErrorResponseDto,
  TeamMemberAlreadyExistsErrorResponseDto,
  TeamMemberNotFoundErrorResponseDto,
  TeamRoleChangeForbiddenErrorResponseDto,
  TeamInvalidRoleErrorResponseDto,
  TeamSelfRoleChangeErrorResponseDto,
  TeamMemberStatusChangeForbiddenErrorResponseDto,
  TeamSelfStatusChangeErrorResponseDto,
  TeamMasterStatusChangeErrorResponseDto,
} from './team-error.dto';
import {
  RoleKey,
  canChangeRole,
  canManageRole,
  ROLE_LABELS,
  hasManagementPermission,
  MANAGEMENT_ROLES,
} from '../../common/constants/role.constants';
import { ActStatus, TaskStatus, TaskStatusMsg } from '../../common/enums/task-status.enum';
import { Inject } from '@nestjs/common';
import {
  INotificationPort,
  NOTIFICATION_PORT,
} from '../../common/port/notification.port';
import { formatDateTime } from '../../common/utils/date.utils';
import { AuthUnauthorizedErrorResponseDto, AuthInvalidTokenErrorResponseDto } from '../auth/auth-error.dto';

// export type TeamMemberType = {
//   teamId: number;
//   teamName: string;
//   crtdAt: Date;
// };

export type TeamType = {
  teamId: number;
  teamName: string;
  crtdAt: Date;
  actStatus: number;
  leaderId: number;
  telegramChatId: number | null;
  discordWebhookUrl: string | null;
  teamDescription: string | null;
};

export type UserTeamType = {
  teamId: number;
  userId: number;
  joinedAt: Date;
  role: string;
  userActStatus: number;
};

export type TeamMemberType = TeamType & UserTeamType;

// TeamMemberRoleType is now exported from team.dto.ts

@Injectable()
export class TeamService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Team)
    private readonly teamRepository: Repository<Team>,
    @InjectRepository(TeamMember)
    private readonly teamMemberRepository: Repository<TeamMember>,
    @InjectRepository(TeamTask)
    private readonly teamTaskRepository: Repository<TeamTask>,
    @InjectRepository(TaskComment)
    private readonly taskCommentRepository: Repository<TaskComment>,
    @InjectRepository(TeamInvitation)
    private readonly teamInvitationRepository: Repository<TeamInvitation>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
    @Inject(NOTIFICATION_PORT)
    private readonly notificationPort: INotificationPort,
  ) {}

  getTeamTaskUrl({teamId, taskId}:{teamId: number, taskId: number}): string {
    return `${this.configService.get<string>('NEXT_PUBLIC_DOMAIN')}/teams/${teamId}/tasks/${taskId}`;
  }

  /**
   * 팀 멤버 조회 (재사용 가능한 공통 메서드)
   * @param userIds 사용자 ID 목록 (선택)
   * @param actStatus 팀 활성 상태 목록 (선택)
   * @param teamIds 팀 ID 목록 (선택)
   * @param userActStatus 팀 멤버 활성 상태 목록 (선택, 기본값: 활성만)
   * @returns 팀 멤버 목록
   */
  async getTeamMembersBy({
    userIds,
    actStatus,
    teamIds,
    userActStatus,
  }: {
    userIds?: number[];
    actStatus?: number[];
    teamIds?: number[];
    userActStatus?: number[];
  }): Promise<TeamMemberType[]> {
    const teamMembersQueryBuilder = this.teamMemberRepository
      .createQueryBuilder('ut')
      .innerJoinAndSelect('ut.team', 't')
      .select([
        'ut.teamId',
        'ut.userId',
        'ut.joinedAt',
        'ut.role',
        'ut.actStatus',
        't.teamName',
        't.teamDescription',
        't.crtdAt',
        't.actStatus',
        't.leaderId',
        't.telegramChatId',
        't.discordWebhookUrl',
      ]);

    if (userIds?.length) {
      teamMembersQueryBuilder.andWhere('ut.userId IN (:...userIds)', { userIds });
    }

    if (teamIds?.length) {
      teamMembersQueryBuilder.andWhere('t.teamId IN (:...teamIds)', { teamIds });
    }

    if (actStatus?.length) {
      teamMembersQueryBuilder.andWhere('t.actStatus IN (:...actStatus)', { actStatus });
    }

    // 멤버 활성 상태 필터 (기본값: 활성만)
    if (userActStatus?.length) {
      teamMembersQueryBuilder.andWhere('ut.actStatus IN (:...userActStatus)', { userActStatus });
    }

    const teamMembers = await teamMembersQueryBuilder.orderBy('ut.joinedAt', 'DESC').getMany();
    return teamMembers.map(tm => {
      return {
        teamId: tm.teamId,
        userId: tm.userId,
        joinedAt: tm.joinedAt,
        role: tm.role,
        userActStatus: tm.actStatus,
        teamName: tm.team.teamName,
        teamDescription: tm.team.teamDescription,
        crtdAt: tm.team.crtdAt,
        actStatus: tm.team.actStatus,
        leaderId: tm.team.leaderId,
        telegramChatId: tm.team.telegramChatId,
        discordWebhookUrl: tm.team.discordWebhookUrl,
      };
    });
  }

  /**
   * 태스크 목록 조회 (재사용 가능한 공통 메서드)
   * @param teamIds 팀 ID 목록 (선택)
   * @param taskIds 태스크 ID 목록 (선택)
   * @param actStatus 활성 상태 목록 (선택)
   * @returns 태스크 목록 (생성자 이름 포함, 시작일시 내림차순)
   */
  async getTeamTasksBy({
    teamIds,
    taskIds,
    actStatus,
  }: {
    teamIds?: number[];
    taskIds?: number[];
    actStatus?: number[];
  }): Promise<
    Array<{
      teamName: string;
      teamDescription: string | null;
      leaderId: number;
      telegramChatId: number | null;
      discordWebhookUrl: string | null;
      taskId: number;
      teamId: number;
      taskName: string;
      taskDescription: string | null;
      taskStatus: number;
      actStatus: number;
      startAt: Date | null;
      endAt: Date | null;
      completedAt: Date | null;
      crtdAt: Date;
      crtdBy: number;
      userName: string | null;
    }>
  > {
    const tasksQueryBuilder = this.teamTaskRepository
      .createQueryBuilder('task')
      .innerJoinAndSelect('task.team', 'team')
      .leftJoinAndSelect('task.user', 'user')
      .select([
        'team.teamName',
        'team.teamDescription',
        'team.leaderId',
        'team.telegramChatId',
        'team.discordWebhookUrl',
        'task.taskId',
        'task.teamId',
        'task.taskName',
        'task.taskDescription',
        'task.taskStatus',
        'task.actStatus',
        'task.startAt',
        'task.endAt',
        'task.completedAt',
        'task.crtdAt',
        'task.crtdBy',
        'user.userName',
      ]);

    if (teamIds?.length) {
      tasksQueryBuilder.andWhere('task.teamId IN (:...teamIds)', { teamIds });
    }

    if (taskIds?.length) {
      tasksQueryBuilder.andWhere('task.taskId IN (:...taskIds)', { taskIds });
    }

    if (actStatus?.length) {
      tasksQueryBuilder.andWhere('task.actStatus IN (:...actStatus)', { actStatus });
    }

    const tasks = await tasksQueryBuilder
      .addOrderBy('task.startAt', 'ASC')
      .addOrderBy('task.taskId', 'DESC')
      .addOrderBy('task.endAt', 'ASC')
      .getMany();

    return tasks.map(task => ({
      teamName: task.team.teamName,
      teamDescription: task.team.teamDescription,
      leaderId: task.team.leaderId,
      telegramChatId: task.team.telegramChatId,
      discordWebhookUrl: task.team.discordWebhookUrl,
      taskId: task.taskId,
      teamId: task.teamId,
      taskName: task.taskName,
      taskDescription: task.taskDescription,
      taskStatus: task.taskStatus,
      actStatus: task.actStatus,
      startAt: task.startAt,
      endAt: task.endAt,
      completedAt: task.completedAt,
      crtdAt: task.crtdAt,
      crtdBy: task.crtdBy,
      userName: task.user?.userName || null,
    }));
  }

  async insertTeamMember({
    userId,
    teamId,
    role,
  }: {
    userId: number;
    teamId: number;
    role: string;
  }): Promise<void> {
    const newTeamMember = this.teamMemberRepository.create({
      userId,
      teamId,
      joinedAt: new Date(),
      role,
    });
    await this.teamMemberRepository.save(newTeamMember);
  }

  async insertTeam({ createTeamDto }: { createTeamDto: CreateTeamDto }): Promise<void> {
    await this.dataSource.transaction(async (manager: EntityManager) => {
      // 1. Team 생성
      const newTeam = manager.create(Team, createTeamDto);
      const savedTeam = await manager.save(Team, newTeam);

      // 2. TeamMember 삽입 (같은 트랜잭션 내)
      const newTeamMember = manager.create(TeamMember, {
        userId: createTeamDto.leaderId,
        teamId: savedTeam.teamId,
        role: 'MASTER' as RoleKey,
      });
      await manager.save(TeamMember, newTeamMember);
    });
  }

  async updateTeam({
    teamId,
    updateTeamDto,
    userId,
  }: {
    teamId: number;
    updateTeamDto: UpdateTeamDto;
    userId: number;
  }): Promise<Team> {
    // 1. 팀 멤버 권한 확인
    await this.verifyTeamMemberAccess(teamId, userId);

    // 2. 팀 존재 여부 확인
    const team = await this.teamRepository.findOne({
      where: { teamId },
    });

    if (!team) {
      throw new TeamNotFoundErrorResponseDto();
    }

    // 3. 수정 가능한 필드만 업데이트
    if (updateTeamDto.teamName !== undefined) {
      team.teamName = updateTeamDto.teamName;
    }
    if (updateTeamDto.teamDescription !== undefined) {
      team.teamDescription = updateTeamDto.teamDescription || null;
    }

    // 4. 업데이트된 엔티티 저장
    return await this.teamRepository.save(team);
  }

  async createTask({
    teamId,
    createTaskDto,
    userId,
  }: {
    teamId: number;
    createTaskDto: CreateTeamTaskDto;
    userId: number;
  }): Promise<TeamTask> {
    // 팀 존재 여부 확인
    const team = await this.teamRepository.findOne({
      where: { teamId, actStatus: ActStatus.ACTIVE },
    });

    if (!team) {
      throw new TeamNotFoundErrorResponseDto();
    }

    // 태스크 생성
    const taskEntity = this.teamTaskRepository.create({
      teamId,
      taskName: createTaskDto.taskName,
      taskDescription: createTaskDto.taskDescription || null,
      taskStatus: createTaskDto.taskStatus ?? TaskStatus.CREATED,
      actStatus: ActStatus.ACTIVE, // 새로 생성된 태스크는 기본적으로 활성 상태
      crtdBy: userId,
      startAt: createTaskDto.startAt || null,
      endAt: createTaskDto.endAt || null,
    });

    const task = await this.teamTaskRepository.save(taskEntity);

    const url = this.getTeamTaskUrl({ teamId, taskId: task.taskId });
    const message = [
      `[${team.teamName}] - ${task.taskName}`,
      `✅ 태스크 생성 ✅`,
      task.startAt || task.endAt
        ? `📅 기간: ${formatDateTime(task.startAt)} ~ ${formatDateTime(task.endAt)}`
        : null,
    ].filter(Boolean).join('\n');
    this.notificationPort.notifyTeam({ team, message, url });

    return task;
  }

  async updateTask({
    teamId,
    taskId,
    updateTaskDto,
    userId,
  }: {
    teamId: number;
    taskId: number;
    updateTaskDto: UpdateTeamTaskDto;
    userId: number;
  }): Promise<TeamTask> {
    // 팀 멤버 권한 확인 (활성화된 멤버만)
    const teamMember = await this.verifyTeamMemberAccess(teamId, userId);

    // 태스크 존재 여부 확인
    const task = await this.teamTaskRepository.findOne({
      where: { taskId },
    });

    if (!task) {
      throw new TeamTaskNotFoundErrorResponseDto();
    }

    // 태스크가 해당 팀에 속하는지 확인
    if (task.teamId !== teamId) {
      throw new TeamTaskBadRequestErrorResponseDto('태스크가 해당 팀에 속하지 않습니다.');
    }

    // 수정 가능한 필드만 업데이트 (taskStatus, actStatus는 별도 API로 관리)
    if (updateTaskDto.taskName !== undefined) {
      task.taskName = updateTaskDto.taskName;
    }
    if (updateTaskDto.taskDescription !== undefined) {
      task.taskDescription = updateTaskDto.taskDescription || null;
    }
    if (updateTaskDto.startAt !== undefined) {
      task.startAt = updateTaskDto.startAt || null;
    }
    if (updateTaskDto.endAt !== undefined) {
      task.endAt = updateTaskDto.endAt || null;
    }

    // 업데이트된 엔티티 저장
    await this.teamTaskRepository.save(task);

    const url = this.getTeamTaskUrl({ teamId, taskId });
    const message = [
      `[${teamMember.teamName}]`,
      `🔄 태스크 수정 🔄`,
      task.startAt || task.endAt
        ? `📅 기간: ${formatDateTime(task.startAt)} ~ ${formatDateTime(task.endAt)}`
        : null,
    ].filter(Boolean).join('\n');
    this.notificationPort.notifyTeam({ team: teamMember, message, url });

    return task;
  }

  /**
   * 태스크 작업 상태 변경
   * @param teamId 팀 ID
   * @param taskId 태스크 ID
   * @param updateStatusDto 상태 변경 DTO
   * @param userId 사용자 ID
   * @returns 업데이트된 태스크
   */
  async updateTaskStatus({
    teamId,
    taskId,
    updateStatusDto,
    userId,
  }: {
    teamId: number;
    taskId: number;
    updateStatusDto: UpdateTaskStatusDto;
    userId: number;
  }): Promise<TeamTask> {
    // 팀 멤버 권한 확인 (활성화된 멤버만)
    const teamMember = await this.verifyTeamMemberAccess(teamId, userId);

    // 태스크 존재 여부 확인
    const task = await this.teamTaskRepository.findOne({
      where: { taskId },
    });

    if (!task) {
      throw new TeamTaskNotFoundErrorResponseDto();
    }

    // 태스크가 해당 팀에 속하는지 확인
    if (task.teamId !== teamId) {
      throw new TeamTaskBadRequestErrorResponseDto('태스크가 해당 팀에 속하지 않습니다.');
    }

    // 작업 상태 업데이트
    const oldTaskStatus = task.taskStatus;
    task.taskStatus = updateStatusDto.taskStatus;

    // completedAt 자동 관리: COMPLETED/CANCELLED → 현재 시간, 그 외 → null
    const isTerminalStatus =
      task.taskStatus === TaskStatus.COMPLETED || task.taskStatus === TaskStatus.CANCELLED;
    task.completedAt = isTerminalStatus ? new Date() : null;

    // 업데이트된 엔티티 저장
    await this.teamTaskRepository.save(task);
    const url = this.getTeamTaskUrl({ teamId, taskId });
    const message = [
      `[${teamMember.teamName}] - ${task.taskName}`,
      `🔄 태스크 작업 상태 변경 🔄`,
      `[${TaskStatusMsg[oldTaskStatus]}] → [${TaskStatusMsg[task.taskStatus]}]`,
      task.startAt || task.endAt
        ? `📅 기간: ${formatDateTime(task.startAt)} ~ ${formatDateTime(task.endAt)}`
        : null,
    ].filter(Boolean).join('\n');
    this.notificationPort.notifyTeam({ team: teamMember, message, url });

    return task;
  }

  /**
   * 태스크 활성 상태 변경
   * @param teamId 팀 ID
   * @param taskId 태스크 ID
   * @param updateActiveStatusDto 활성 상태 변경 DTO
   * @param userId 사용자 ID
   * @returns 업데이트된 태스크
   */
  async updateTaskActiveStatus({
    teamId,
    taskId,
    updateActiveStatusDto,
    userId,
  }: {
    teamId: number;
    taskId: number;
    updateActiveStatusDto: UpdateTaskActiveStatusDto;
    userId: number;
  }): Promise<TeamTask> {
    // 1. 팀 멤버 권한 확인 (활성화된 멤버만)
    await this.verifyTeamMemberAccess(teamId, userId);

    // 2. 태스크 존재 여부 확인
    const task = await this.teamTaskRepository.findOne({
      where: { taskId },
    });

    if (!task) {
      throw new TeamTaskNotFoundErrorResponseDto();
    }

    // 3. 태스크가 해당 팀에 속하는지 확인
    if (task.teamId !== teamId) {
      throw new TeamTaskBadRequestErrorResponseDto('태스크가 해당 팀에 속하지 않습니다.');
    }

    // 4. 활성 상태 업데이트
    task.actStatus = updateActiveStatusDto.actStatus;

    // 5. 업데이트된 엔티티 저장
    return await this.teamTaskRepository.save(task);
  }

  async createTaskComment({
    teamId,
    taskId,
    createCommentDto,
    userId,
  }: {
    teamId: number;
    taskId: number;
    createCommentDto: CreateTaskCommentDto;
    userId: number;
  }): Promise<TaskComment> {
    // 1. 팀 멤버 권한 확인 (활성화된 멤버만)
    const teamMember = await this.verifyTeamMemberAccess(teamId, userId);

    // 2. 태스크 존재 여부 확인 (활성 태스크만)
    const task = await this.teamTaskRepository.findOne({
      where: { taskId, teamId, actStatus: ActStatus.ACTIVE },
    });

    if (!task) {
      throw new TeamTaskNotFoundErrorResponseDto();
    }

    // 3. 댓글 생성
    const newComment = this.taskCommentRepository.create({
      teamId,
      taskId,
      userId,
      commentContent: createCommentDto.commentContent,
      status: ActStatus.ACTIVE,
    });

    const comment = await this.taskCommentRepository.save(newComment);
    const url = this.getTeamTaskUrl({ teamId, taskId });
    const message = [
      `[${teamMember.teamName}] - ${task.taskName}`,
      `💬 새로운 댓글이 등록되었습니다 💬`,
      // `${comment.user.userName}: ${comment.commentContent}`,
      comment.commentContent,
    ].filter(Boolean).join('\n');
    this.notificationPort.notifyTeam({ team: teamMember, message, url });
    return comment;
  }

  async updateTaskComment({
    teamId,
    taskId,
    commentId,
    updateCommentDto,
    userId,
  }: {
    teamId: number;
    taskId: number;
    commentId: number;
    updateCommentDto: UpdateTaskCommentDto;
    userId: number;
  }): Promise<TaskComment> {
    // 댓글 존재 여부 확인
    const comment = await this.taskCommentRepository.findOne({
      where: { commentId },
    });

    if (!comment) {
      throw new TeamCommentNotFoundErrorResponseDto();
    }

    // 댓글 작성자 권한 확인
    if (comment.userId !== userId) {
      throw new TeamCommentForbiddenErrorResponseDto('댓글 작성자만 수정할 수 있습니다.');
    }

    // 댓글이 해당 태스크에 속하는지 확인
    if (comment.taskId !== taskId) {
      throw new TeamTaskBadRequestErrorResponseDto('댓글이 해당 태스크에 속하지 않습니다.');
    }

    // 댓글이 해당 팀에 속하는지 확인
    if (comment.teamId !== teamId) {
      throw new TeamTaskBadRequestErrorResponseDto('댓글이 해당 팀에 속하지 않습니다.');
    }

    // 댓글이 활성 상태인지 확인
    if (comment.status !== ActStatus.ACTIVE) {
      throw new TeamTaskBadRequestErrorResponseDto('삭제된 댓글은 수정할 수 없습니다.');
    }

    const [teamTask] = await this.getTeamTasksBy({taskIds: [taskId], teamIds: [teamId], actStatus: [ActStatus.ACTIVE]});

    if (!teamTask) {
      throw new TeamTaskNotFoundErrorResponseDto('활성 태스크를 찾을 수 없습니다.');
    }

    // 수정 가능한 필드만 업데이트
    if (updateCommentDto.commentContent !== undefined) {
      comment.commentContent = updateCommentDto.commentContent;
    }
    comment.mdfdAt = new Date();

    // 업데이트된 엔티티 저장
    const updatedComment = await this.taskCommentRepository.save(comment);
    const url = this.getTeamTaskUrl({ teamId, taskId });
    const message = [
      `[${teamTask.teamName}]`,
      `💬 ${teamTask.taskName} 태스크에 댓글이 수정되었습니다 💬`,
      updatedComment.commentContent,
    ].filter(Boolean).join('\n');
    this.notificationPort.notifyTeam({
      team: { teamId: teamTask.teamId, teamName: teamTask.teamName, telegramChatId: teamTask.telegramChatId, discordWebhookUrl: teamTask.discordWebhookUrl },
      message,
      url,
    });
    return updatedComment;
  }

  async deleteTaskComment({
    teamId,
    taskId,
    commentId,
    userId,
  }: {
    teamId: number;
    taskId: number;
    commentId: number;
    userId: number;
  }): Promise<void> {
    // 1. 댓글 존재 여부 확인
    const comment = await this.taskCommentRepository.findOne({
      where: { commentId },
    });

    if (!comment) {
      throw new TeamCommentNotFoundErrorResponseDto();
    }

    // 2. 댓글 작성자 권한 확인
    if (comment.userId !== userId) {
      throw new TeamCommentForbiddenErrorResponseDto('댓글 작성자만 삭제할 수 있습니다.');
    }

    // 3. 댓글이 해당 태스크에 속하는지 확인
    if (comment.taskId !== taskId) {
      throw new TeamTaskBadRequestErrorResponseDto('댓글이 해당 태스크에 속하지 않습니다.');
    }

    // 4. 댓글이 해당 팀에 속하는지 확인
    if (comment.teamId !== teamId) {
      throw new TeamTaskBadRequestErrorResponseDto('댓글이 해당 팀에 속하지 않습니다.');
    }

    // 5. 댓글이 이미 삭제된 상태인지 확인
    if (comment.status === ActStatus.INACTIVE) {
      throw new TeamTaskBadRequestErrorResponseDto('이미 삭제된 댓글입니다.');
    }

    // 6. 소프트 삭제 (status를 비활성으로 변경)
    comment.status = ActStatus.INACTIVE;
    comment.mdfdAt = new Date();

    await this.taskCommentRepository.save(comment);
  }

  /**
   * 팀 멤버 권한 확인 (재사용 가능한 메서드)
   * @param teamId 팀 ID
   * @param userId 사용자 ID
   * @throws ForbiddenException 팀 멤버가 아니거나 비활성화된 경우
   */
  async verifyTeamMemberAccess(teamId: number, userId: number): Promise<TeamMemberType> {
    const [teamMember] = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [userId],
      actStatus: [ActStatus.ACTIVE],
      userActStatus: [ActStatus.ACTIVE],
    });

    if (!teamMember) {
      throw new TeamForbiddenErrorResponseDto('팀 멤버만 접근할 수 있습니다.');
    }

    return teamMember;
  }

  /**
   * 팀의 태스크 목록 조회
   * @param teamId 팀 ID
   * @param userId 사용자 ID
   * @returns 팀 정보와 태스크 목록 (시작일시 내림차순, 생성자 이름 포함)
   */
  async getTasksByTeamId(
    teamId: number,
    userId: number,
    actStatusFilter?: number[],
  ): Promise<{
    team: Team;
    tasks: Array<{
      taskId: number;
      teamId: number;
      taskName: string;
      taskDescription: string | null;
      taskStatus: number;
      actStatus: number;
      startAt: Date | null;
      endAt: Date | null;
      completedAt: Date | null;
      crtdAt: Date;
      crtdBy: number;
      userName: string | null;
    }>;
  }> {
    // 1. 팀 멤버 권한 확인
    await this.verifyTeamMemberAccess(teamId, userId);

    // 2. 팀 정보 조회
    const team = await this.teamRepository.findOne({
      where: { teamId },
    });

    if (!team) {
      throw new TeamNotFoundErrorResponseDto();
    }

    // 3. 태스크 목록 조회 (기본: 활성 태스크만, actStatusFilter로 변경 가능)
    const tasks = await this.getTeamTasksBy({
      teamIds: [teamId],
      actStatus: actStatusFilter ?? [ActStatus.ACTIVE],
    });

    return { team, tasks };
  }

  /**
   * 태스크의 댓글 목록 조회 (재사용 가능한 메서드)
   * @param taskId 태스크 ID
   * @returns 댓글 목록 (작성자 정보 포함, 생성일시 오름차순)
   */
  async getCommentsByTaskId(taskId: number): Promise<
    Array<{
      commentId: number;
      teamId: number;
      taskId: number;
      userId: number;
      userName: string | null;
      commentContent: string;
      status: number;
      mdfdAt: Date | null;
      crtdAt: Date;
    }>
  > {
    const comments = await this.taskCommentRepository
      .createQueryBuilder('comment')
      .leftJoinAndSelect('comment.user', 'user')
      .where('comment.taskId = :taskId', { taskId })
      .orderBy('comment.commentId', 'ASC')
      .select([
        'comment.commentId',
        'comment.teamId',
        'comment.taskId',
        'comment.userId',
        'comment.commentContent',
        'comment.status',
        'comment.mdfdAt',
        'comment.crtdAt',
        'user.userName',
      ])
      .getMany();

    return comments.map(comment => ({
      commentId: comment.commentId,
      teamId: comment.teamId,
      taskId: comment.taskId,
      userId: comment.userId,
      userName: comment.user?.userName || null,
      commentContent: comment.commentContent,
      status: comment.status,
      mdfdAt: comment.mdfdAt,
      crtdAt: comment.crtdAt,
    }));
  }

  /**
   * 태스크 상세 조회 (댓글 포함)
   * @param teamId 팀 ID
   * @param taskId 태스크 ID
   * @param userId 사용자 ID
   * @returns 태스크 정보 (생성자 이름 포함)와 댓글 목록
   */
  async getTaskWithComments(
    teamId: number,
    taskId: number,
    userId: number,
  ): Promise<{
    task: {
      taskId: number;
      teamId: number;
      taskName: string;
      taskDescription: string | null;
      taskStatus: number;
      actStatus: number;
      startAt: Date | null;
      endAt: Date | null;
      completedAt: Date | null;
      crtdAt: Date;
      crtdBy: number;
      userName: string | null;
    };
    comments: Array<{
      commentId: number;
      teamId: number;
      taskId: number;
      userId: number;
      userName: string | null;
      commentContent: string;
      status: number;
      mdfdAt: Date | null;
      crtdAt: Date;
    }>;
  }> {
    // 1. 팀 멤버 권한 확인
    await this.verifyTeamMemberAccess(teamId, userId);

    // 2. 태스크 존재 여부 확인 (생성자 이름 포함)
    const tasks = await this.getTeamTasksBy({
      taskIds: [taskId],
    });
    const task = tasks[0];

    if (!task) {
      throw new TeamTaskNotFoundErrorResponseDto();
    }

    // 3. 태스크가 해당 팀에 속하는지 확인
    if (task.teamId !== teamId) {
      throw new TeamTaskBadRequestErrorResponseDto('태스크가 해당 팀에 속하지 않습니다.');
    }

    // 4. 댓글 목록 조회
    const comments = await this.getCommentsByTaskId(taskId);

    return {
      task,
      comments,
    };
  }

  /**
   * 팀의 사용자 목록 조회
   * @param teamId 팀 ID
   * @param userId 사용자 ID (권한 확인용)
   * @param statusFilter 멤버 상태 필터 ('all' | 'active' | 'inactive', 기본값: 'active')
   * @returns 사용자 목록
   */
  async getTeamUsers(
    teamId: number,
    userId: number,
    statusFilter?: MemberStatusFilterType,
  ): Promise<
    Array<{
      userId: number;
      userName: string | null;
      birth: Date | null;
      kakaoEmail: string | null;
      role: TeamMemberRoleType;
      createdDate: Date;
      isActivated: 0 | 1;
      userActStatus: 0 | 1;
    }>
  > {
    // 1. 팀 멤버 권한 확인 (활성화된 멤버만)
    await this.verifyTeamMemberAccess(teamId, userId);

    // 2. 팀 멤버와 사용자 정보 조회
    const queryBuilder = this.teamMemberRepository
      .createQueryBuilder('tm')
      .innerJoin('tm.user', 'user')
      .where('tm.teamId = :teamId', { teamId })
      .andWhere('user.isActivated = :isActivated', { isActivated: 1 })
      .select([
        'user.userId',
        'user.userName',
        'user.birth',
        'user.kakaoEmail',
        'tm.role',
        'tm.actStatus',
        'user.createdDate',
        'user.isActivated',
      ])
      .orderBy('user.userId', 'ASC');

    // 멤버 상태 필터 적용 (0: 비활성, 1: 활성, undefined: 전체)
    if (statusFilter === 1) {
      queryBuilder.andWhere('tm.actStatus = :userActStatus', { userActStatus: ActStatus.ACTIVE });
    } else if (statusFilter === 0) {
      queryBuilder.andWhere('tm.actStatus = :userActStatus', { userActStatus: ActStatus.INACTIVE });
    }
    // undefined인 경우 필터 없음 (전체 조회)

    const rawResults = await queryBuilder.getRawMany();

    // 3. Raw 데이터를 원하는 형태로 매핑
    return rawResults.map(raw => ({
      userId: raw.user_USER_ID,
      userName: raw.user_USER_NAME,
      birth: raw.user_BIRTH,
      kakaoEmail: raw.user_KAKAO_EMAIL,
      role: raw.tm_ROLE,
      createdDate: raw.user_CREATED_DATE,
      isActivated: raw.user_IS_ACTIVATED,
      userActStatus: raw.tm_ACT_STATUS,
    }));
  }

  /**
   * 초대 링크 생성
   * @param teamId 팀 ID
   * @param createInviteDto 초대 링크 생성 DTO
   * @param userId 생성자 ID (팀 리더만 가능)
   * @returns 초대 링크 URL, 만료시간, 최대 사용 횟수
   */
  async createTeamInvite({
    teamId,
    createInviteDto,
    userId,
  }: {
    teamId: number;
    createInviteDto: CreateTeamInviteDto;
    userId: number;
  }): Promise<{ inviteLink: string; endAt: Date; usageMaxCnt: number }> {
    if (!userId) {
      throw new AuthUnauthorizedErrorResponseDto('팀 초대를 생성하려면 회원가입이 필요합니다.');
    }
    if (!teamId) {
      throw new TeamTaskBadRequestErrorResponseDto('팀 ID가 필요합니다.');
    }
    // // 1. 팀 존재 여부 및 활성 상태 확인
    // const team = await this.teamRepository.findOne({
    //   where: { teamId, actStatus: ActStatus.ACTIVE },
    // });

    // if (!team) {
    //   throw new TeamNotFoundErrorResponseDto();
    // }

    // 2. 팀 멤버 권한 확인 (MASTER 또는 MANAGER만 허용)
    // const teamMember = await this.teamMemberRepository.findOne({
    //   where: { teamId, userId },
    // });

    const teamMembers = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [userId],
      actStatus: [ActStatus.ACTIVE],
      userActStatus: [ActStatus.ACTIVE],
    });

    if (!teamMembers?.length || !MANAGEMENT_ROLES.includes(teamMembers[0].role as RoleKey)) {
      throw new TeamInviteForbiddenErrorResponseDto('팀 리더 또는 매니저만 초대 링크를 생성할 수 있습니다.');
    }

    // 3. 만료시간 검증
    const endAt = createInviteDto.endAt;
    const now = new Date();
    if (endAt <= now) {
      throw new TeamInviteExpiredErrorResponseDto('만료 시간은 현재 시간보다 이후여야 합니다.');
    }
    // 최대 7일 제한
    const maxEndAt = new Date(now.getTime() + INVITE_MAX_EXPIRATION_MS);
    if (endAt > maxEndAt) {
      throw new TeamInviteExpiredErrorResponseDto('만료 시간은 현재 시간부터 최대 7일까지만 설정 가능합니다.');
    }

    // 4. JWT 토큰 생성
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new AuthInvalidTokenErrorResponseDto('JWT_SECRET이 설정되지 않았습니다.');
    }

    const tokenPayload = {
      teamId,
      userId,
    };

    // JWT 만료시간은 고정 8일로 설정
    // DB의 endAt은 최대 7일까지만 설정 가능하므로, JWT는 항상 DB보다 길게 유지됨
    // 실제 만료 검증은 DB의 endAt으로 수행
    const token = sign(tokenPayload, secret, {
      expiresIn: INVITE_TOKEN_EXPIRY_SECONDS,
    });

    // 5. TeamInvitation 엔티티 저장
    const newInvite = this.teamInvitationRepository.create({
      teamId,
      token,
      userId,
      endAt,
      usageMaxCnt: createInviteDto.usageMaxCnt,
      usageCurCnt: 0,
      actStatus: ActStatus.ACTIVE,
    });

    await this.teamInvitationRepository.save(newInvite);

    // 6. 초대 링크 URL 생성 (프론트엔드 페이지로 리다이렉트)
    const frontendDomain = this.configService.get<string>('NEXT_PUBLIC_DOMAIN');
    if (!frontendDomain) {
      throw new TeamTaskBadRequestErrorResponseDto(
        'NEXT_PUBLIC_DOMAIN 환경변수가 설정되지 않았습니다. 초대 링크를 생성할 수 없습니다.',
      );
    }
    const inviteLink = `${frontendDomain}/teams/invitation?token=${token}`;

    return {
      inviteLink,
      endAt,
      usageMaxCnt: createInviteDto.usageMaxCnt,
    };
  }

  /**
   * 초대 토큰 검증
   * @param inviteToken 초대 토큰
   * @returns 검증된 초대 정보
   */
  async verifyTeamInviteToken(token: string): Promise<{
    teamId: number;
    teamName: string;
    userId: number;
    endAt: Date;
    usageMaxCnt: number;
    usageCurCnt: number;
    actStatus: ActStatus;
  }> {
    // 1. JWT 토큰 검증
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new AuthInvalidTokenErrorResponseDto('JWT_SECRET이 설정되지 않았습니다.');
    }

    let payload: JwtPayload & {
      teamId: number;
      userId: number;
    };

    try {
      payload = verify(token, secret) as JwtPayload & {
        teamId: number;
        userId: number;
      };
    } catch (_error) {
      throw new TeamInviteExpiredErrorResponseDto('유효하지 않거나 만료된 초대 링크입니다.');
    }

    // 2. 데이터베이스에서 초대 정보 조회
    const invite = await this.teamInvitationRepository.findOne({
      where: { teamId: payload.teamId, token, actStatus: ActStatus.ACTIVE },
    });

    if (!invite) {
      throw new TeamInviteNotFoundErrorResponseDto();
    }

    // 3. 만료시간 확인 (DB의 endAt만 확인 - DB에서 관리)
    const now = new Date();
    if (now > invite.endAt) {
      throw new TeamInviteExpiredErrorResponseDto();
    }

    // 4. 팀 활성 상태 확인
    const team = await this.teamRepository.findOne({
      where: { teamId: invite.teamId, actStatus: ActStatus.ACTIVE },
    });

    if (!team) {
      throw new TeamNotFoundErrorResponseDto('팀을 찾을 수 없거나 비활성 상태입니다.');
    }

    // 5. JWT payload의 teamId와 DB의 teamId 일치 확인 (보안 강화)
    if (payload.teamId !== invite.teamId) {
      throw new TeamInviteExpiredErrorResponseDto('유효하지 않은 초대 링크입니다.');
    }

    // 6. 사용 횟수 확인
    if (invite.usageCurCnt >= invite.usageMaxCnt) {
      throw new TeamInviteExpiredErrorResponseDto('초대 링크의 사용 횟수가 초과되었습니다.');
    }

    return {
      teamId: invite.teamId, // DB의 teamId 사용 (검증 완료)
      teamName: team.teamName,
      userId: payload.userId,
      endAt: invite.endAt,
      usageMaxCnt: invite.usageMaxCnt,
      usageCurCnt: invite.usageCurCnt,
      actStatus: invite.actStatus,
    };
  }

  /**
   * 초대 수락 및 팀 가입
   * @param token 초대 토큰
   * @param userId 사용자 ID (비회원인 경우 null)
   * @returns 가입한 팀 정보
   */
  async acceptTeamInvite({
    token,
    userId,
  }: {
    token: string;
    userId: number | null;
  }): Promise<{ teamId: number; teamName: string; message: string }> {
    // 사용자 ID가 null인 경우는 비회원이므로, 회원가입이 필요함
    if (!userId) {
      throw new AuthUnauthorizedErrorResponseDto('팀 초대를 수락하려면 회원가입이 필요합니다.');
    }
    // 1. 토큰 검증
    const inviteInfo = await this.verifyTeamInviteToken(token);

    // 2. 사용자 ID가 제공된 경우, 이미 팀 멤버인지 확인 (비활성화 포함)
    const existingMember = await this.teamMemberRepository.findOne({
      where: {
        teamId: inviteInfo.teamId,
        userId,
      },
    });

    // 3. 트랜잭션으로 팀 가입/재활성화 및 사용 횟수 증가
    let message = '팀에 성공적으로 가입했습니다.';

    await this.dataSource.transaction(async (manager: EntityManager) => {
      // 동시성 제어: SELECT FOR UPDATE로 락을 걸어 사용 횟수 확인 및 증가
      const invite = await manager
        .createQueryBuilder(TeamInvitation, 'invite')
        .setLock('pessimistic_write') // SELECT FOR UPDATE
        .where('invite.teamId = :teamId', { teamId: inviteInfo.teamId })
        .andWhere('invite.token = :token', { token })
        .andWhere('invite.actStatus = :actStatus', { actStatus: ActStatus.ACTIVE })
        .getOne();

      if (!invite) {
        throw new TeamInviteNotFoundErrorResponseDto();
      }

      // 사용 횟수 재확인 (락을 건 상태에서)
      if (invite.usageCurCnt >= invite.usageMaxCnt) {
        throw new TeamInviteExpiredErrorResponseDto('초대 링크의 사용 횟수가 초과되었습니다.');
      }

      if (existingMember) {
        // 이미 멤버인 경우
        if (existingMember.actStatus === ActStatus.ACTIVE) {
          // 활성화된 멤버면 이미 가입됨
          throw new TeamMemberAlreadyExistsErrorResponseDto();
        }

        // 비활성화된 멤버인 경우: 재활성화 (MEMBER 역할로 초기화)
        await manager.update(
          TeamMember,
          { teamId: inviteInfo.teamId, userId },
          {
            actStatus: ActStatus.ACTIVE,
            role: 'MEMBER' as RoleKey,
            joinedAt: new Date(),
          },
        );
        message = '팀에 다시 가입했습니다.';
      } else {
        // 새 멤버인 경우: TeamMember 추가
        const newTeamMember = manager.create(TeamMember, {
          userId,
          teamId: inviteInfo.teamId,
          role: 'MEMBER' as RoleKey,
          actStatus: ActStatus.ACTIVE,
        });
        await manager.save(TeamMember, newTeamMember);
      }

      // 사용 횟수 증가
      invite.usageCurCnt += 1;
      await manager.save(TeamInvitation, invite);
    });

    return {
      teamId: inviteInfo.teamId,
      teamName: inviteInfo.teamName,
      message,
    };
  }

  /**
   * 팀의 초대 링크 목록 조회
   * @param teamId 팀 ID
   * @param userId 사용자 ID (팀 리더만 조회 가능)
   * @returns 초대 링크 목록
   */
  async getTeamInvites(teamId: number, userId: number): Promise<TeamInvitation[]> {
    if (!userId) {
      throw new AuthUnauthorizedErrorResponseDto('팀 초대를 조회하려면 회원가입이 필요합니다.');
    }
    if (!teamId) {
      throw new TeamTaskBadRequestErrorResponseDto('팀 ID가 필요합니다.');
    }
    // 팀 멤버 권한 확인 (MASTER 또는 MANAGER만 허용, 활성화된 멤버만)
    const teamMembers = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [userId],
      actStatus: [ActStatus.ACTIVE],
      userActStatus: [ActStatus.ACTIVE],
    });

    if (!teamMembers?.length || !MANAGEMENT_ROLES.includes(teamMembers[0].role as RoleKey)) {
      throw new TeamInviteForbiddenErrorResponseDto('팀 리더 또는 매니저만 초대 링크를 조회할 수 있습니다.');
    }

    // 3. 초대 링크 목록 조회
    const invites = await this.teamInvitationRepository.find({
      where: { teamId, actStatus: ActStatus.ACTIVE },
      order: { invId: 'DESC' },
    });

    return invites;
  }

  /**
   * 팀 멤버 역할 변경
   * @param teamId 팀 ID
   * @param targetUserId 대상 사용자 ID
   * @param newRole 새 역할
   * @param actorUserId 요청자 사용자 ID
   * @returns 변경된 멤버 정보
   */
  async updateMemberRole({
    teamId,
    targetUserId,
    newRole,
    actorUserId,
  }: {
    teamId: number;
    targetUserId: number;
    newRole: 'MANAGER' | 'MEMBER';
    actorUserId: number;
  }): Promise<{
    teamId: number;
    userId: number;
    userName: string | null;
    previousRole: string;
    newRole: string;
    teamName: string;
  }> {
    // 1. 본인 역할 변경 차단
    if (actorUserId === targetUserId) {
      throw new TeamSelfRoleChangeErrorResponseDto();
    }

    // 2. newRole 유효성 검사 (DTO에서 'MANAGER' | 'MEMBER'로 제한됨)
    // MASTER로 변경은 타입 레벨에서 차단됨 (팀당 1명 유지 정책)

    // 3. 요청자 팀 멤버 정보 조회 (활성화된 멤버만)
    const [actorMember] = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [actorUserId],
      actStatus: [ActStatus.ACTIVE],
      userActStatus: [ActStatus.ACTIVE],
    });

    if (!actorMember) {
      throw new TeamForbiddenErrorResponseDto('팀 멤버만 역할을 변경할 수 있습니다.');
    }

    const actorRole = actorMember.role.toUpperCase() as RoleKey;

    // 4. 요청자 관리 권한 확인
    if (!hasManagementPermission(actorRole)) {
      throw new TeamRoleChangeForbiddenErrorResponseDto('역할을 변경할 권한이 없습니다.');
    }

    // 5. 대상 사용자 팀 멤버 정보 조회 (활성화된 멤버만)
    const [targetMember] = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [targetUserId],
      actStatus: [ActStatus.ACTIVE],
      userActStatus: [ActStatus.ACTIVE],
    });

    if (!targetMember) {
      throw new TeamMemberNotFoundErrorResponseDto('대상 사용자가 팀 멤버가 아닙니다.');
    }

    const targetCurrentRole = targetMember.role.toUpperCase() as RoleKey;

    // 6. 역할 변경 가능 여부 검증
    if (!canChangeRole(actorRole, targetCurrentRole, newRole)) {
      throw new TeamRoleChangeForbiddenErrorResponseDto(
        `${ROLE_LABELS[actorRole]}는 ${ROLE_LABELS[targetCurrentRole]}를 ${ROLE_LABELS[newRole]}로 변경할 수 없습니다.`,
      );
    }

    // 7. 역할이 동일하면 변경하지 않음
    if (targetCurrentRole === newRole) {
      throw new TeamInvalidRoleErrorResponseDto('현재 역할과 동일한 역할로는 변경할 수 없습니다.');
    }

    // 8. 역할 변경
    const previousRole = targetMember.role;
    await this.teamMemberRepository.update(
      { teamId, userId: targetUserId },
      { role: newRole },
    );

    // 9. 대상 사용자 이름 조회
    const targetUser = await this.userRepository.findOne({
      where: { userId: targetUserId },
      select: ['userName'],
    });

    const userName = targetUser?.userName || null;

    // 10. 알림 전송
    const message = [
      `[${actorMember.teamName}]`,
      `🔄 역할 변경 알림 🔄`,
      `${userName || `사용자 ${targetUserId}`}님의 역할이 변경되었습니다.`,
      `${ROLE_LABELS[previousRole as RoleKey] || previousRole} → ${ROLE_LABELS[newRole]}`,
    ].join('\n');

    this.notificationPort.notifyTeam({
      team: { teamId, teamName: actorMember.teamName, telegramChatId: actorMember.telegramChatId, discordWebhookUrl: actorMember.discordWebhookUrl },
      message,
    });

    return {
      teamId,
      userId: targetUserId,
      userName,
      previousRole,
      newRole,
      teamName: actorMember.teamName,
    };
  }

  /**
   * 팀 멤버 활성 상태 변경 (토글)
   * @param teamId 팀 ID
   * @param targetUserId 대상 사용자 ID
   * @param newStatus 새 상태 (0: 비활성, 1: 활성)
   * @param actorUserId 요청자 사용자 ID
   * @returns 변경된 멤버 정보
   */
  async updateMemberStatus({
    teamId,
    targetUserId,
    newStatus,
    actorUserId,
  }: {
    teamId: number;
    targetUserId: number;
    newStatus: ActStatus;
    actorUserId: number;
  }): Promise<{
    teamId: number;
    userId: number;
    userName: string | null;
    previousStatus: number;
    newStatus: number;
    teamName: string;
  }> {
    // 1. 본인 상태 변경 차단
    if (actorUserId === targetUserId) {
      throw new TeamSelfStatusChangeErrorResponseDto();
    }

    // 2. 요청자 팀 멤버 정보 조회 (활성화된 멤버만)
    const [actorMember] = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [actorUserId],
      actStatus: [ActStatus.ACTIVE],
      userActStatus: [ActStatus.ACTIVE],
    });

    if (!actorMember) {
      throw new TeamForbiddenErrorResponseDto('팀 멤버만 상태를 변경할 수 있습니다.');
    }

    const actorRole = actorMember.role.toUpperCase() as RoleKey;

    // 3. 요청자 관리 권한 확인
    if (!hasManagementPermission(actorRole)) {
      throw new TeamMemberStatusChangeForbiddenErrorResponseDto('멤버 상태를 변경할 권한이 없습니다.');
    }

    // 4. 대상 사용자 팀 멤버 정보 조회 (비활성화된 멤버 포함)
    const [targetMember] = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [targetUserId],
      actStatus: [ActStatus.ACTIVE],
      // userActStatus 필터 없음 (비활성화된 멤버도 조회)
    });

    if (!targetMember) {
      throw new TeamMemberNotFoundErrorResponseDto('대상 사용자가 팀 멤버가 아닙니다.');
    }

    const targetCurrentRole = targetMember.role.toUpperCase() as RoleKey;

    // 5. MASTER는 상태 변경 불가
    if (targetCurrentRole === 'MASTER') {
      throw new TeamMasterStatusChangeErrorResponseDto();
    }

    // 6. 대상자 관리 가능 여부 확인 (역할 변경 권한과 동일)
    if (!canManageRole(actorRole, targetCurrentRole)) {
      throw new TeamMemberStatusChangeForbiddenErrorResponseDto(
        `${ROLE_LABELS[actorRole]}는 ${ROLE_LABELS[targetCurrentRole]}의 상태를 변경할 수 없습니다.`,
      );
    }

    // 7. 상태가 동일하면 변경하지 않음
    const previousStatus = targetMember.userActStatus;
    if (previousStatus === newStatus) {
      throw new TeamInvalidRoleErrorResponseDto(
        newStatus === ActStatus.ACTIVE ? '이미 활성화된 멤버입니다.' : '이미 비활성화된 멤버입니다.',
      );
    }

    // 8. 상태 변경
    await this.teamMemberRepository.update(
      { teamId, userId: targetUserId },
      { actStatus: newStatus },
    );

    // 9. 대상 사용자 이름 조회
    const targetUser = await this.userRepository.findOne({
      where: { userId: targetUserId },
      select: ['userName'],
    });

    const userName = targetUser?.userName || null;

    // 10. 알림 전송
    const statusLabel = newStatus === ActStatus.ACTIVE ? '활성화' : '비활성화';
    const message = [
      `[${actorMember.teamName}]`,
      `🔄 멤버 상태 변경 알림 🔄`,
      `${userName || `사용자 ${targetUserId}`}님이 ${statusLabel}되었습니다.`,
    ].join('\n');

    this.notificationPort.notifyTeam({
      team: { teamId, teamName: actorMember.teamName, telegramChatId: actorMember.telegramChatId, discordWebhookUrl: actorMember.discordWebhookUrl },
      message,
    });

    return {
      teamId,
      userId: targetUserId,
      userName,
      previousStatus,
      newStatus,
      teamName: actorMember.teamName,
    };
  }
}

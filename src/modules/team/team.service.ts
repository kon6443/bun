import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { sign, verify, JwtPayload } from 'jsonwebtoken';
import { TeamMember } from '../../entities/TeamMember';
import { Team } from '@/entities/Team';
import { TeamTask } from '@/entities/TeamTask';
import { TaskComment } from '@/entities/TaskComment';
import { TeamInvitation } from '@/entities/TeamInvitation';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { CreateTeamTaskDto } from './dto/create-team-task.dto';
import { UpdateTeamTaskDto } from './dto/update-team-task.dto';
import { CreateTaskCommentDto } from './dto/create-task-comment.dto';
import { UpdateTaskCommentDto } from './dto/update-task-comment.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { UpdateTaskActiveStatusDto } from './dto/update-task-active-status.dto';
import { CreateTeamInviteDto } from './dto/create-team-invite.dto';
import { AcceptTeamInviteDto } from './dto/accept-team-invite.dto';
import { ActStatus, TaskStatus } from '../../common/enums/task-status.enum';

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
};

export type UserTeamType = {
  teamId: number;
  userId: number;
  joinedAt: Date;
  role: string;
};

export type TeamMemberType = TeamType & UserTeamType;

export type TeamMemberRoleType = 'MASTER' | 'MANAGER' | 'MEMBER';

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
    private readonly configService: ConfigService,
  ) {}

  async getTeamMembersBy({
    userIds,
    actStatus,
    teamIds,
  }: {
    userIds?: number[];
    actStatus?: number[];
    teamIds?: number[];
  }): Promise<TeamMemberType[]> {
    const teamMembersQueryBuilder = this.teamMemberRepository
      .createQueryBuilder('ut')
      .innerJoinAndSelect('ut.team', 't')
      .select([
        'ut.teamId',
        'ut.userId',
        'ut.joinedAt',
        'ut.role',
        't.teamName',
        't.teamDescription',
        't.crtdAt',
        't.actStatus',
        't.leaderId',
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

    const teamMembers = await teamMembersQueryBuilder.orderBy('ut.joinedAt', 'DESC').getMany();
    return teamMembers.map(tm => {
      return {
        teamId: tm.teamId,
        userId: tm.userId,
        joinedAt: tm.joinedAt,
        role: tm.role,
        teamName: tm.team.teamName,
        teamDescription: tm.team.teamDescription,
        crtdAt: tm.team.crtdAt,
        actStatus: tm.team.actStatus,
        leaderId: tm.team.leaderId,
      };
    });
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
        role: 'MASTER',
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
      throw new NotFoundException('팀을 찾을 수 없습니다.');
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
      throw new NotFoundException('팀을 찾을 수 없습니다.');
    }

    // 태스크 생성
    const newTask = this.teamTaskRepository.create({
      teamId,
      taskName: createTaskDto.taskName,
      taskDescription: createTaskDto.taskDescription || null,
      taskStatus: createTaskDto.taskStatus ?? TaskStatus.CREATED,
      actStatus: ActStatus.ACTIVE, // 새로 생성된 태스크는 기본적으로 활성 상태
      crtdBy: userId,
      startAt: createTaskDto.startAt || null,
      endAt: createTaskDto.endAt || null,
    });

    return await this.teamTaskRepository.save(newTask);
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
    // 1. 팀 멤버 권한 확인
    const teamMembers = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [userId],
      actStatus: [ActStatus.ACTIVE],
    });

    if (!teamMembers?.length) {
      throw new ForbiddenException('팀 멤버만 태스크를 수정할 수 있습니다.');
    }

    // 2. 태스크 존재 여부 확인
    const task = await this.teamTaskRepository.findOne({
      where: { taskId },
    });

    if (!task) {
      throw new NotFoundException('태스크를 찾을 수 없습니다.');
    }

    // 3. 태스크가 해당 팀에 속하는지 확인
    if (task.teamId !== teamId) {
      throw new BadRequestException('태스크가 해당 팀에 속하지 않습니다.');
    }

    // 4. 수정 가능한 필드만 업데이트 (taskStatus, actStatus는 별도 API로 관리)
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

    // 5. 업데이트된 엔티티 저장
    return await this.teamTaskRepository.save(task);
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
    // 1. 팀 멤버 권한 확인
    const teamMembers = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [userId],
      actStatus: [ActStatus.ACTIVE],
    });

    if (!teamMembers?.length) {
      throw new ForbiddenException('팀 멤버만 태스크 상태를 변경할 수 있습니다.');
    }

    // 2. 태스크 존재 여부 확인
    const task = await this.teamTaskRepository.findOne({
      where: { taskId },
    });

    if (!task) {
      throw new NotFoundException('태스크를 찾을 수 없습니다.');
    }

    // 3. 태스크가 해당 팀에 속하는지 확인
    if (task.teamId !== teamId) {
      throw new BadRequestException('태스크가 해당 팀에 속하지 않습니다.');
    }

    // 4. 작업 상태 업데이트
    task.taskStatus = updateStatusDto.taskStatus;

    // 5. 업데이트된 엔티티 저장
    return await this.teamTaskRepository.save(task);
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
    // 1. 팀 멤버 권한 확인
    const teamMembers = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [userId],
      actStatus: [ActStatus.ACTIVE],
    });

    if (!teamMembers?.length) {
      throw new ForbiddenException('팀 멤버만 태스크 활성 상태를 변경할 수 있습니다.');
    }

    // 2. 태스크 존재 여부 확인
    const task = await this.teamTaskRepository.findOne({
      where: { taskId },
    });

    if (!task) {
      throw new NotFoundException('태스크를 찾을 수 없습니다.');
    }

    // 3. 태스크가 해당 팀에 속하는지 확인
    if (task.teamId !== teamId) {
      throw new BadRequestException('태스크가 해당 팀에 속하지 않습니다.');
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
    // 1. 팀 멤버 권한 확인
    const teamMembers = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [userId],
      actStatus: [ActStatus.ACTIVE],
    });

    if (!teamMembers?.length) {
      throw new ForbiddenException('팀 멤버만 댓글을 작성할 수 있습니다.');
    }

    // 2. 태스크 존재 여부 확인 (활성 태스크만)
    const task = await this.teamTaskRepository.findOne({
      where: { taskId, teamId, actStatus: ActStatus.ACTIVE },
    });

    if (!task) {
      throw new NotFoundException('태스크를 찾을 수 없습니다.');
    }

    // 3. 댓글 생성
    const newComment = this.taskCommentRepository.create({
      teamId,
      taskId,
      userId,
      commentContent: createCommentDto.commentContent,
      status: ActStatus.ACTIVE,
    });

    return await this.taskCommentRepository.save(newComment);
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
    // 1. 댓글 존재 여부 확인
    const comment = await this.taskCommentRepository.findOne({
      where: { commentId },
    });

    if (!comment) {
      throw new NotFoundException('댓글을 찾을 수 없습니다.');
    }

    // 2. 댓글 작성자 권한 확인
    if (comment.userId !== userId) {
      throw new ForbiddenException('댓글 작성자만 수정할 수 있습니다.');
    }

    // 3. 댓글이 해당 태스크에 속하는지 확인
    if (comment.taskId !== taskId) {
      throw new BadRequestException('댓글이 해당 태스크에 속하지 않습니다.');
    }

    // 4. 댓글이 해당 팀에 속하는지 확인
    if (comment.teamId !== teamId) {
      throw new BadRequestException('댓글이 해당 팀에 속하지 않습니다.');
    }

    // 5. 댓글이 활성 상태인지 확인
    if (comment.status !== ActStatus.ACTIVE) {
      throw new BadRequestException('삭제된 댓글은 수정할 수 없습니다.');
    }

    // 6. 수정 가능한 필드만 업데이트
    if (updateCommentDto.commentContent !== undefined) {
      comment.commentContent = updateCommentDto.commentContent;
    }
    comment.mdfdAt = new Date();

    // 7. 업데이트된 엔티티 저장
    return await this.taskCommentRepository.save(comment);
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
      throw new NotFoundException('댓글을 찾을 수 없습니다.');
    }

    // 2. 댓글 작성자 권한 확인
    if (comment.userId !== userId) {
      throw new ForbiddenException('댓글 작성자만 삭제할 수 있습니다.');
    }

    // 3. 댓글이 해당 태스크에 속하는지 확인
    if (comment.taskId !== taskId) {
      throw new BadRequestException('댓글이 해당 태스크에 속하지 않습니다.');
    }

    // 4. 댓글이 해당 팀에 속하는지 확인
    if (comment.teamId !== teamId) {
      throw new BadRequestException('댓글이 해당 팀에 속하지 않습니다.');
    }

    // 5. 댓글이 이미 삭제된 상태인지 확인
    if (comment.status === ActStatus.INACTIVE) {
      throw new BadRequestException('이미 삭제된 댓글입니다.');
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
   * @throws ForbiddenException 팀 멤버가 아닐 경우
   */
  async verifyTeamMemberAccess(teamId: number, userId: number): Promise<void> {
    const teamMembers = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [userId],
      actStatus: [1],
    });

    if (!teamMembers?.length) {
      throw new ForbiddenException('팀 멤버만 접근할 수 있습니다.');
    }
  }

  /**
   * 팀의 태스크 목록 조회
   * @param teamId 팀 ID
   * @param userId 사용자 ID
   * @returns 팀 정보와 태스크 목록 (시작일시 내림차순)
   */
  async getTasksByTeamId(teamId: number, userId: number): Promise<{ team: Team; tasks: TeamTask[] }> {
    // 1. 팀 멤버 권한 확인
    await this.verifyTeamMemberAccess(teamId, userId);

    // 2. 팀 정보 조회
    const team = await this.teamRepository.findOne({
      where: { teamId },
    });

    if (!team) {
      throw new NotFoundException('팀을 찾을 수 없습니다.');
    }

    // 3. 태스크 목록 조회 (활성 태스크만, 시작일시 내림차순)
    const tasks = await this.teamTaskRepository
      .createQueryBuilder('task')
      .where('task.teamId = :teamId', { teamId })
      .andWhere('task.actStatus = :actStatus', { actStatus: ActStatus.ACTIVE })
      .orderBy('task.startAt', 'DESC')
      .addOrderBy('task.crtdAt', 'DESC') // startAt이 null인 경우를 대비하여 생성일시로 추가 정렬
      .getMany();

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
      .orderBy('comment.crtdAt', 'ASC')
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
   * @returns 태스크 정보와 댓글 목록
   */
  async getTaskWithComments(
    teamId: number,
    taskId: number,
    userId: number,
  ): Promise<{
    task: TeamTask;
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

    // 2. 태스크 존재 여부 확인
    const task = await this.teamTaskRepository.findOne({
      where: { taskId },
    });

    if (!task) {
      throw new NotFoundException('태스크를 찾을 수 없습니다.');
    }

    // 3. 태스크가 해당 팀에 속하는지 확인
    if (task.teamId !== teamId) {
      throw new BadRequestException('태스크가 해당 팀에 속하지 않습니다.');
    }

    // 4. 댓글 목록 조회
    const comments = await this.getCommentsByTaskId(taskId);

    return {
      task,
      comments,
    };
  }

  /**
   * 팀의 활성화된 사용자 목록 조회
   * @param teamId 팀 ID
   * @param userId 사용자 ID (권한 확인용)
   * @returns 활성화된 사용자 목록
   */
  async getTeamUsers(
    teamId: number,
    userId: number,
  ): Promise<
    Array<{
      userId: number;
      userName: string | null;
      birth: Date | null;
      kakaoEmail: string | null;
      role: TeamMemberRoleType;
      createdDate: Date;
      isActivated: 0 | 1;
    }>
  > {
    // 1. 팀 멤버 권한 확인
    await this.verifyTeamMemberAccess(teamId, userId);

    // 2. 팀 멤버와 사용자 정보 조회 (활성화된 사용자만)
    const rawResults = await this.teamMemberRepository
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
        'user.createdDate',
        'user.isActivated',
      ])
      .orderBy('user.userId', 'ASC')
      .getRawMany();

    // 3. Raw 데이터를 원하는 형태로 매핑
    return rawResults.map(raw => ({
      userId: raw.user_USER_ID,
      userName: raw.user_USER_NAME,
      birth: raw.user_BIRTH,
      kakaoEmail: raw.user_KAKAO_EMAIL,
      role: raw.tm_ROLE,
      createdDate: raw.user_CREATED_DATE,
      isActivated: raw.user_IS_ACTIVATED,
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
      throw new UnauthorizedException('팀 초대를 조회하려면 회원가입이 필요합니다.');
    }
    if (!teamId) {
      throw new BadRequestException('팀 ID가 필요합니다.');
    }
    // // 1. 팀 존재 여부 및 활성 상태 확인
    // const team = await this.teamRepository.findOne({
    //   where: { teamId, actStatus: ActStatus.ACTIVE },
    // });

    // if (!team) {
    //   throw new NotFoundException('팀을 찾을 수 없습니다.');
    // }

    // 2. 팀 멤버 권한 확인 (MASTER 또는 MANAGER만 허용)
    // const teamMember = await this.teamMemberRepository.findOne({
    //   where: { teamId, userId },
    // });

    const teamMembers = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [userId],
      actStatus: [ActStatus.ACTIVE],
    });

    if (!teamMembers?.length || ['MASTER', 'MANAGER'].includes(teamMembers[0].role)) {
      throw new ForbiddenException('팀 리더 또는 매니저만 초대 링크를 생성할 수 있습니다.');
    }

    // 3. 만료시간 검증
    const endAt = createInviteDto.endAt;
    const now = new Date();
    if (endAt <= now) {
      throw new BadRequestException('만료 시간은 현재 시간보다 이후여야 합니다.');
    }
    // 최대 7일 제한
    const maxEndAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7일 후
    if (endAt > maxEndAt) {
      throw new BadRequestException('만료 시간은 현재 시간부터 최대 7일까지만 설정 가능합니다.');
    }

    // 4. JWT 토큰 생성
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new UnauthorizedException('JWT_SECRET not configured');
    }

    const tokenPayload = {
      teamId,
      userId,
    };

    // JWT 만료시간은 고정 8일로 설정
    // DB의 endAt은 최대 7일까지만 설정 가능하므로, JWT는 항상 DB보다 길게 유지됨
    // 실제 만료 검증은 DB의 endAt으로 수행
    const token = sign(tokenPayload, secret, {
      expiresIn: 8 * 24 * 60 * 60, // 8일 (691200초) 고정
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
      throw new BadRequestException(
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
      throw new UnauthorizedException('JWT_SECRET not configured');
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
    } catch (error) {
      throw new BadRequestException('유효하지 않거나 만료된 초대 링크입니다.');
    }

    // 2. 데이터베이스에서 초대 정보 조회
    const invite = await this.teamInvitationRepository.findOne({
      where: { teamId: payload.teamId, token, actStatus: ActStatus.ACTIVE },
    });

    if (!invite) {
      throw new NotFoundException('초대 링크를 찾을 수 없습니다.');
    }

    // 3. 만료시간 확인 (DB의 endAt만 확인 - DB에서 관리)
    const now = new Date();
    if (now > invite.endAt) {
      throw new BadRequestException('만료된 초대 링크입니다.');
    }

    // 4. 팀 활성 상태 확인
    const team = await this.teamRepository.findOne({
      where: { teamId: invite.teamId, actStatus: ActStatus.ACTIVE },
    });

    if (!team) {
      throw new NotFoundException('팀을 찾을 수 없거나 비활성 상태입니다.');
    }

    // 5. JWT payload의 teamId와 DB의 teamId 일치 확인 (보안 강화)
    if (payload.teamId !== invite.teamId) {
      throw new BadRequestException('유효하지 않은 초대 링크입니다.');
    }

    // 6. 사용 횟수 확인
    if (invite.usageCurCnt >= invite.usageMaxCnt) {
      throw new BadRequestException('초대 링크의 사용 횟수가 초과되었습니다.');
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
      throw new UnauthorizedException('팀 초대를 수락하려면 회원가입이 필요합니다.');
    }
    // 1. 토큰 검증
    const inviteInfo = await this.verifyTeamInviteToken(token);

    // 2. 사용자 ID가 제공된 경우, 이미 팀 멤버인지 확인
    const existingMember = await this.teamMemberRepository.findOne({
      where: {
        teamId: inviteInfo.teamId,
        userId,
      },
    });

    if (existingMember) {
      throw new BadRequestException('이미 팀 멤버입니다.');
    }

    // 3. 트랜잭션으로 팀 가입 및 사용 횟수 증가
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
        throw new NotFoundException('초대 링크를 찾을 수 없습니다.');
      }

      // 사용 횟수 재확인 (락을 건 상태에서)
      if (invite.usageCurCnt >= invite.usageMaxCnt) {
        throw new BadRequestException('초대 링크의 사용 횟수가 초과되었습니다.');
      }

      // TeamMember 추가
      const newTeamMember = manager.create(TeamMember, {
        userId,
        teamId: inviteInfo.teamId,
        role: 'MEMBER',
      });
      await manager.save(TeamMember, newTeamMember);

      // 사용 횟수 증가
      invite.usageCurCnt += 1;
      await manager.save(TeamInvitation, invite);
    });

    return {
      teamId: inviteInfo.teamId,
      teamName: inviteInfo.teamName,
      message: '팀에 성공적으로 가입했습니다.',
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
      throw new UnauthorizedException('팀 초대를 조회하려면 회원가입이 필요합니다.');
    }
    if (!teamId) {
      throw new BadRequestException('팀 ID가 필요합니다.');
    }
    // 팀 멤버 권한 확인 (MASTER 또는 MANAGER만 허용)
    const teamMembers = await this.getTeamMembersBy({
      teamIds: [teamId],
      userIds: [userId],
      actStatus: [ActStatus.ACTIVE],
    });

    if (!teamMembers?.length || ['MASTER', 'MANAGER'].includes(teamMembers[0].role)) {
      throw new ForbiddenException('팀 리더 또는 매니저만 초대 링크를 조회할 수 있습니다.');
    }

    // 3. 초대 링크 목록 조회
    const invites = await this.teamInvitationRepository.find({
      where: { teamId, actStatus: ActStatus.ACTIVE },
      order: { invId: 'DESC' },
    });

    return invites;
  }
}

import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { TeamMember } from '../../entities/TeamMember';
import { Team } from '@/entities/Team';
import { TeamTask } from '@/entities/TeamTask';
import { TaskComment } from '@/entities/TaskComment';
import { CreateTeamDto } from './dto/create-team.dto';
import { CreateTeamTaskDto } from './dto/create-team-task.dto';
import { UpdateTeamTaskDto } from './dto/update-team-task.dto';
import { CreateTaskCommentDto } from './dto/create-task-comment.dto';
import { UpdateTaskCommentDto } from './dto/update-task-comment.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { UpdateTaskActiveStatusDto } from './dto/update-task-active-status.dto';
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
      createdDate: raw.user_CREATED_DATE,
      isActivated: raw.user_IS_ACTIVATED,
    }));
  }
}

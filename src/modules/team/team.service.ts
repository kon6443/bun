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
import { CreateTeamDto } from './dto/create-team.dto';
import { CreateTeamTaskDto } from './dto/create-team-task.dto';
import { UpdateTeamTaskDto } from './dto/update-team-task.dto';

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
      where: { teamId, actStatus: 1 },
    });

    if (!team) {
      throw new NotFoundException('팀을 찾을 수 없습니다.');
    }

    // 태스크 생성
    const newTask = this.teamTaskRepository.create({
      teamId,
      taskName: createTaskDto.taskName,
      taskDescription: createTaskDto.taskDescription || null,
      taskStatus: createTaskDto.taskStatus ?? 0,
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
      actStatus: [1],
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

    // 4. 수정 가능한 필드만 업데이트
    if (updateTaskDto.taskName !== undefined) {
      task.taskName = updateTaskDto.taskName;
    }
    if (updateTaskDto.taskDescription !== undefined) {
      task.taskDescription = updateTaskDto.taskDescription || null;
    }
    if (updateTaskDto.taskStatus !== undefined) {
      task.taskStatus = updateTaskDto.taskStatus;
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
}

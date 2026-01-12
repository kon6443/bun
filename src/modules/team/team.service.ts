import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { TeamMember } from '../../entities/TeamMember';
import { Team } from '@/entities/Team';
import { CreateTeamDto } from './dto/create-team.dto';

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
  ) {}

  async getTeamMembersBy({
    userIds,
    actStatus,
  }: {
    userIds: number[];
    actStatus: number[];
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
        't.crtdAt',
        't.actStatus',
        't.leaderId',
      ]);

    if (userIds?.length) {
      teamMembersQueryBuilder.andWhere('ut.userId IN (:...userIds)', { userIds });
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
}

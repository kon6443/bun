import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TeamMember } from '../../entities/TeamMember';

export type TeamSummary = {
  teamId: number;
  teamName: string;
  description?: string;
  ownerId: number;
  createdAt: Date;
  memberRole?: string;
};

@Injectable()
export class TeamService {
  constructor(
    @InjectRepository(TeamMember)
    private readonly teamMemberRepository: Repository<TeamMember>,
  ) {}

  async getTeamsByUserId(userId: number): Promise<TeamSummary[]> {
    if (!userId || Number.isNaN(userId)) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    const teamMembers = await this.teamMemberRepository
      .createQueryBuilder('tm')
      .innerJoinAndSelect('tm.team', 'team')
      .where('tm.userId = :userId', { userId })
      .orderBy('team.createdAt', 'DESC')
      .getMany();

    return teamMembers.map((tm) => ({
      teamId: tm.team.teamId,
      teamName: tm.team.teamName,
      description: tm.team.description || undefined,
      ownerId: tm.team.ownerId,
      createdAt: tm.team.createdAt,
      memberRole: tm.role,
    }));
  }
}



import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TeamMember } from '../../entities/TeamMember';

export type TeamSummary = {
  teamId: number;
  teamName: string;
  // description?: string;
  // ownerId: number;
  crtdAt: Date;
  // memberRole?: string;
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
      .orderBy('tm.teamId', 'DESC')
      .getMany();

    console.log('teamMembers', teamMembers);
    return teamMembers.map((tm) => ({
      teamId: tm.team.teamId,
      teamName: tm.team.teamName,
      // description: tm.team.description || undefined,
      // ownerId: tm.team.ownerId,
      crtdAt: tm.team.crtdAt,
      // memberRole: tm.role,
    }));
  }
}







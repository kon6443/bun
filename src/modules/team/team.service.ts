import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TeamMember } from '../../entities/TeamMember';

export type TeamMemberType = {
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

  // async getTeamMembersBy({userIds, actStatus}: {userIds: number[], actStatus: number[]}): Promise<TeamMemberType[]> {
  async getTeamMembersBy({userIds, actStatus}: {userIds: number[], actStatus: number[]}): Promise<TeamMember[]> {

    const teamMembersQueryBuilder = this.teamMemberRepository
      .createQueryBuilder('ut')
      .select([
        'ut.teamId',
        'ut.joinedAt',
        'ut.role',
      ])
      .innerJoinAndSelect('ut.team', 't')
      .addSelect([
        't.teamName',
        't.crtdAt',
        't.actStatus',
        't.leaderId',
      ]);

    if(userIds?.length) {
      teamMembersQueryBuilder.andWhere('ut.userId IN (:...userIds)', { userIds });
    }

    if(actStatus?.length) {
      teamMembersQueryBuilder.andWhere('t.actStatus IN (:...actStatus)', { actStatus });
    }

    const teamMembers = await teamMembersQueryBuilder.orderBy('ut.joinedAt', 'DESC').getMany();
    console.log(teamMembers);
    return teamMembers;
    // return teamMembers.map((tm) => ({
    //   teamId: tm.team.teamId,
    //   teamName: tm.team.teamName,
    //   crtdAt: tm.team.crtdAt,
    // }));
  }
}







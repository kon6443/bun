import { AppDataSource } from "../database/data-source";
import { Team } from "../entities/Team";
import { TeamMember } from "../entities/TeamMember";

export type TeamRow = {
  teamId: number;
  teamName: string;
  description?: string;
  ownerId: number;
  createdAt: Date;
  memberRole?: string;
};

class TeamRepository {
  async findTeamsByUserId(userId: number): Promise<TeamRow[]> {
    const teamMemberRepository = AppDataSource.getRepository(TeamMember);

    const teamMembers = await teamMemberRepository
      .createQueryBuilder("tm")
      .innerJoinAndSelect("tm.team", "team")
      .where("tm.userId = :userId", { userId })
      .orderBy("team.createdAt", "DESC")
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

const teamRepositoryInstance = new TeamRepository();
export default teamRepositoryInstance;


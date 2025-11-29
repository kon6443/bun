import teamRepositoryInstance, {
  TeamRow,
} from "../repositories/teamRepository";
import utilServiceInstance from "./utils";

export type TeamSummary = {
  teamId: number;
  teamName: string;
  description?: string;
  ownerId: number;
  createdAt: Date;
  memberRole?: string;
};

class TeamService {
  async getTeamsByUserId(userId: number | undefined): Promise<TeamSummary[]> {
    if (!userId || Number.isNaN(userId)) {
      utilServiceInstance.handleError({
        message: "UNAUTHORIZED",
        status: 401,
      });
    }

    const teams = await teamRepositoryInstance.findTeamsByUserId(userId!);
    return teams.map(this.mapTeamRowToSummary);
  }

  private mapTeamRowToSummary(team: TeamRow): TeamSummary {
    return {
      teamId: team.teamId,
      teamName: team.teamName,
      description: team.description,
      ownerId: team.ownerId,
      createdAt: team.createdAt,
      memberRole: team.memberRole,
    };
  }
}

const teamServiceInstance = new TeamService();
export default teamServiceInstance;


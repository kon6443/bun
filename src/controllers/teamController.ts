import teamServiceInstance from "../services/teamService";

class TeamController {
  async getMyTeams({ userId }: { userId: number | undefined }) {
    return teamServiceInstance.getTeamsByUserId(userId);
  }
}

const teamControllerInstance = new TeamController();
export default teamControllerInstance;


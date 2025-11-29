import { oracleAutonomousRepository } from "./oracleAutonomousRepository";

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
    const sql = `
      SELECT
        t.team_id AS team_id,
        t.team_name AS team_name,
        t.description AS description,
        t.owner_id AS owner_id,
        t.created_at AS created_at,
        tm.role AS member_role
      FROM teams t
      INNER JOIN team_members tm ON tm.team_id = t.team_id
      WHERE tm.user_id = :userId
      ORDER BY t.created_at DESC
    `;

    const rows = (await oracleAutonomousRepository.execute<TeamRow>(sql, {
      userId,
    })) as TeamRow[] | undefined;

    return rows ?? [];
  }
}

const teamRepositoryInstance = new TeamRepository();
export default teamRepositoryInstance;


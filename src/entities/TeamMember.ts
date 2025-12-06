import "reflect-metadata";
import { Entity, Column, ManyToOne, JoinColumn, PrimaryColumn } from "typeorm";
import { User } from "./User";
import { Team } from "./Team";

@Entity("USER_TEAMS")
export class TeamMember {
  @PrimaryColumn({ name: "TEAM_ID", type: "number" })
  teamId: number;

  @PrimaryColumn({ name: "USER_ID", type: "number" })
  userId: number;

  @Column({ name: "ROLE", type: "varchar2" })
  role: string;

  // 관계
  @ManyToOne(() => Team, (team) => team.members)
  @JoinColumn({ name: "TEAM_ID" })
  team: Team;

  @ManyToOne(() => User, (user) => user.teamMembers)
  @JoinColumn({ name: "USER_ID" })
  user: User;
}


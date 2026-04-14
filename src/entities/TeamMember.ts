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

  @Column({ name: "JOINED_AT", type: "timestamp with time zone" })
  joinedAt: Date;

  @Column({ name: "ROLE", type: "varchar2" })
  role: string;

  @Column({ name: "ACT_STATUS", type: "number", default: 1 })
  actStatus: number;

  // 관계
  @ManyToOne(() => Team, (team) => team.teamMembers)
  @JoinColumn({ name: "TEAM_ID" })
  team: Team;

  @ManyToOne(() => User, (user) => user.teamMembers)
  @JoinColumn({ name: "USER_ID" })
  user: User;
}


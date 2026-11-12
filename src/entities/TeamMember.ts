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

  @Column({ name: "JOINED_AT", type: "timestamp with time zone", nullable: true })
  joinedAt: Date;

  @Column({ name: "ROLE", type: "varchar2", length: 50, nullable: true })
  role: string;

  @Column({ name: "ACT_STATUS", type: "number", default: 1 })
  actStatus: number;

  // 팀 안에서만 보이는 닉네임 — 가입 때 계정 닉네임을 복사하고 이후 독립 (docs/tasks/team-nickname D-004).
  // NULL은 복사 전 데이터만 해당하며 읽을 때 계정 닉네임으로 대체한다
  @Column({ name: "TEAM_NICKNAME", type: "varchar2", length: 100, nullable: true })
  teamNickname: string | null;

  // 관계
  @ManyToOne(() => Team, (team) => team.teamMembers)
  @JoinColumn({ name: "TEAM_ID" })
  team: Team;

  @ManyToOne(() => User, (user) => user.teamMembers)
  @JoinColumn({ name: "USER_ID" })
  user: User;
}


import "reflect-metadata";
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, OneToMany, JoinColumn, ManyToMany } from "typeorm";
import { User } from "./User";
import { TeamMember } from "./TeamMember";

@Entity("TEAMS")
export class Team {
  @PrimaryGeneratedColumn({ name: "TEAM_ID" })
  teamId: number;

  @Column({ name: "TEAM_NAME", type: "varchar2" })
  teamName: string;

  @Column({ name: "LEADER_ID", type: "number" })
  leaderId: number;

  @Column({ name: "CRTD_AT", type: "timestamp" })
  crtdAt: Date;
  
  @Column({ name: "ACT_STATUS", type: "number" })
  actStatus: number;

  // 관계
  @ManyToMany(() => User, (user) => user.userId)
  @JoinColumn({ name: "LEADER_ID" })
  users: User[];

  // @OneToMany(() => TeamMember, (teamMember) => teamMember.teamId)
  @ManyToMany(() => TeamMember, (teamMember) => teamMember.teamId)
  teamMembers: TeamMember[];
}


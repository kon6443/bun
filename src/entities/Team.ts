import "reflect-metadata";
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, OneToMany, JoinColumn } from "typeorm";
import { User } from "./User";
import { TeamMember } from "./TeamMember";

@Entity("TEAMS")
export class Team {
  @PrimaryGeneratedColumn({ name: "TEAM_ID" })
  teamId: number;

  @Column({ name: "TEAM_NAME", type: "varchar2" })
  teamName: string;

  // @Column({ name: "DESCRIPTION", nullable: true, type: "varchar2" })
  // description: string | null;

  // @Column({ name: "OWNER_ID", type: "number" })
  // ownerId: number;

  @Column({ name: "CRTD_AT", type: "timestamp" })
  crtdAt: Date;

  // 관계
  // @ManyToOne(() => User, (user) => user.teamMembers)
  // @JoinColumn({ name: "OWNER_ID" })
  // owner: User;

  @OneToMany(() => TeamMember, (teamMember) => teamMember.team)
  members: TeamMember[];
}


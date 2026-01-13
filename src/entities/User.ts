import "reflect-metadata";
import { Entity, Column, PrimaryGeneratedColumn, OneToMany } from "typeorm";
import { TeamMember } from "./TeamMember";
import { Team } from "./Team";

@Entity("USERS")
export class User {
  @PrimaryGeneratedColumn({ name: "USER_ID" })
  userId: number;

  @Column({ name: "USER_NAME", nullable: true, type: "varchar2" })
  userName: string | null;

  @Column({ name: "BIRTH", nullable: true, type: "date" })
  birth: Date | null;

  // @Column({ name: "KAKAO_ID", unique: true, type: "varchar2" })
  // kakaoId: string;
  @Column({ name: "KAKAO_ID", unique: true, type: "number" })
  kakaoId: number;

  @Column({ name: "KAKAO_EMAIL", nullable: true, type: "varchar2" })
  kakaoEmail: string | null;

  @Column({ name: "CREATED_DATE", type: "timestamp" })
  createdDate: Date;

  @Column({ name: "IS_ACTIVATED", type: "number", default: 1 })
  isActivated: 0 | 1;

  // 관계
  @OneToMany(() => Team, (team) => team.leaderId)
  teams: Team[];

  @OneToMany(() => TeamMember, (teamMember) => teamMember.user)
  teamMembers: TeamMember[];
}


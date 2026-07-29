import "reflect-metadata";
import { Entity, Column, PrimaryGeneratedColumn, OneToMany } from "typeorm";
import { TeamMember } from "./TeamMember";
import { Team } from "./Team";

@Entity("USERS")
export class User {
  @PrimaryGeneratedColumn({ name: "USER_ID" })
  userId: number;

  @Column({ name: "USER_NAME", nullable: true, type: "varchar2", length: 100 })
  userName: string | null;

  @Column({ name: "BIRTH", nullable: true, type: "date" })
  birth: Date | null;

  // DB: VARCHAR2(100) NOT NULL — 유니크 제약 없음 (카카오 API의 number id는 auth.service 경계에서 string 변환)
  @Column({ name: "KAKAO_ID", type: "varchar2", length: 100 })
  kakaoId: string;

  @Column({ name: "KAKAO_EMAIL", nullable: true, type: "varchar2", length: 100 })
  kakaoEmail: string | null;

  @Column({ name: "CREATED_DATE", type: "timestamp with time zone", nullable: true })
  createdDate: Date;

  @Column({ name: "IS_ACTIVATED", type: "number", default: 1 })
  isActivated: 0 | 1;

  // 관계
  @OneToMany(() => Team, (team) => team.leader)
  teams: Team[];

  @OneToMany(() => TeamMember, (teamMember) => teamMember.user)
  teamMembers: TeamMember[];
}


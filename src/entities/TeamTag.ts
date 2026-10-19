import 'reflect-metadata';
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Team } from './Team';

/**
 * 팀 태그 정의 — 스키마: migrations/*-CreateTeamTags.ts (docs/tasks/team-task-tags DESIGN.md §1-1)
 *
 * 팀 단위로 관리하며 태스크와는 TeamTaskTag로 N:M 연결된다. 삭제는 하드 삭제(연결은 FK CASCADE).
 */
@Entity('TEAM_TAGS')
export class TeamTag {
  // DB: GENERATED ALWAYS AS IDENTITY — INSERT 시 ID 생략 필수 (명시 값은 ORA-32795 거부)
  @PrimaryGeneratedColumn({ name: 'TAG_ID' })
  tagId: number;

  @Column({ name: 'TEAM_ID', type: 'number' })
  teamId: number;

  // 앞뒤 공백 제거 후 1~20자. 팀 안 대소문자 무시 유니크는 DB 함수 기반 인덱스가 강제한다
  @Column({ name: 'TAG_NAME', type: 'varchar2', length: 80 })
  tagName: string;

  // #RRGGBB 대문자 (DB CHECK)
  @Column({ name: 'TAG_COLOR', type: 'varchar2', length: 7 })
  tagColor: string;

  // 팀 안 표시 순서(오름차순). 빈 번호 허용 — 상대 순서만 의미
  @Column({ name: 'SORT_ORDER', type: 'number' })
  sortOrder: number;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;

  // 사용자 삭제 시 NULL (태그는 팀 자산)
  @Column({ name: 'CRTD_BY', type: 'number', nullable: true })
  crtdBy: number | null;

  @Column({ name: 'MDFD_AT', type: 'timestamp with time zone', nullable: true })
  mdfdAt: Date | null;

  // 관계
  @ManyToOne(() => Team)
  @JoinColumn({ name: 'TEAM_ID' })
  team: Team;
}

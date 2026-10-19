import 'reflect-metadata';
import { Entity, Column, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';
import { TeamTask } from './TeamTask';
import { TeamTag } from './TeamTag';

/**
 * 태스크↔태그 연결 — 스키마: migrations/*-CreateTeamTaskTags.ts (docs/tasks/team-task-tags DESIGN.md §1-2)
 *
 * 태스크당 최대 10개, 태스크와 태그가 같은 팀이라는 조건은 서비스가 검증한다(DB 제약 없음).
 */
@Entity('TEAM_TASK_TAGS')
export class TeamTaskTag {
  @PrimaryColumn({ name: 'TASK_ID', type: 'number' })
  taskId: number;

  @PrimaryColumn({ name: 'TAG_ID', type: 'number' })
  tagId: number;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;

  // 관계
  @ManyToOne(() => TeamTask)
  @JoinColumn({ name: 'TASK_ID' })
  task: TeamTask;

  @ManyToOne(() => TeamTag)
  @JoinColumn({ name: 'TAG_ID' })
  tag: TeamTag;
}

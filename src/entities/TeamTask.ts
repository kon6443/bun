import 'reflect-metadata';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  ManyToMany,
} from 'typeorm';
import { User } from './User';
import { Team } from './Team';
import { TaskStatus, ActStatus } from '../common/enums/task-status.enum';

@Entity('TEAM_TASKS')
export class TeamTask {
  @PrimaryGeneratedColumn({ name: 'TASK_ID' })
  taskId: number;

  @Column({ name: 'TEAM_ID', type: 'number' })
  teamId: number;

  @Column({ name: 'TASK_NAME', type: 'varchar2' })
  taskName: string;

  @Column({ name: 'TASK_DESCRIPTION', type: 'clob', nullable: true })
  taskDescription: string | null;

  // 태스크 작업 상태 (TaskStatus enum 참조)
  @Column({ name: 'TASK_STATUS', type: 'number' })
  taskStatus: TaskStatus; // TaskStatus.CREATED(1): 생성됨, TaskStatus.IN_PROGRESS(2): 진행중, TaskStatus.COMPLETED(3): 완료, TaskStatus.ON_HOLD(4): 보류, TaskStatus.CANCELLED(5): 취소

  // 태스크 활성 상태 (ActStatus enum 참조)
  @Column({ name: 'ACT_STATUS', type: 'number' })
  actStatus: ActStatus; // ActStatus.INACTIVE(0): 비활성, ActStatus.ACTIVE(1): 활성(노출)

  @Column({ name: 'START_AT', type: 'timestamp', nullable: true })
  startAt: Date | null;

  @Column({ name: 'END_AT', type: 'timestamp', nullable: true })
  endAt: Date | null;

  @Column({ name: 'CRTD_AT', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;

  @Column({ name: 'CRTD_BY', type: 'number' })
  crtdBy: number;

  // 관계
  @ManyToOne(() => Team)
  @JoinColumn({ name: 'TEAM_ID' })
  team: Team;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'CRTD_BY' })
  user: User;
}

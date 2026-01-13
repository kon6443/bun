import 'reflect-metadata';
import {
  Entity,
  Column,
  PrimaryColumn,
  ManyToOne,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Team } from './Team';
import { TeamTask } from './TeamTask';
import { User } from './User';


@Entity('TASK_COMMENTS')
export class TaskComment {
  @PrimaryColumn({ name: 'COMMENT_ID', type: 'number' })
  commentId: number;

  @Column({ name: 'TEAM_ID', type: 'number' })
  teamId: number;

  @Column({ name: 'TASK_ID', type: 'number' })
  taskId: number;

  @Column({ name: 'USER_ID', type: 'number' })
  userId: number;

  @Column({ name: 'COMMENT_CONTENT', type: 'clob' })
  commentContent: string;

  @Column({ name: 'STATUS', type: 'number', default: 1 })
  status: number; // 0: 비활성, 1: 활성(노출)

  @Column({ name: 'MDFD_AT', type: 'timestamp', nullable: true })
  mdfdAt: Date | null;

  @Column({ name: 'CRTD_AT', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;

  // 관계
  @OneToOne(() => Team)
  @JoinColumn({ name: 'TEAM_ID' })
  team: Team;

  @ManyToOne(() => TeamTask)
  @JoinColumn({ name: 'TASK_ID' })
  task: TeamTask;

  @OneToOne(() => User)
  @JoinColumn({ name: 'USER_ID' })
  user: User;
}

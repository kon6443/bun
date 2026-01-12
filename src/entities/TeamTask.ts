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

  @Column({ name: 'TASK_STATUS', type: 'number' })
  taskStatus: number;

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

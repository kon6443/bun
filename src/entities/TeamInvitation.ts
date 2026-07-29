import 'reflect-metadata';
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Team } from './Team';
import { User } from './User';
import { ActStatus } from '../common/enums/task-status.enum';

@Entity('TEAM_INVITATIONS')
export class TeamInvitation {
  @PrimaryGeneratedColumn({ name: 'INV_ID' })
  invId: number;

  @Column({ name: 'TEAM_ID', type: 'number', nullable: true })
  teamId: number;

  @Column({ name: 'USER_ID', type: 'number', nullable: true })
  userId: number;

  // DB는 마이그레이션(ExpandTeamInvitationsToken) 적용 후 VARCHAR2(500)
  @Column({ name: 'TOKEN', type: 'varchar2', length: 500, nullable: true })
  // @Index('IDX_INVITE_TOKEN', { unique: true })
  token: string;

  @Column({ name: 'USAGE_CUR_CNT', type: 'number', default: 0, nullable: false })
  usageCurCnt: number;

  @Column({ name: 'USAGE_MAX_CNT', type: 'number', default: 1, nullable: false })
  usageMaxCnt: number;

  @Column({ name: 'ACT_STATUS', type: 'number', default: ActStatus.ACTIVE, nullable: false })
  actStatus: ActStatus;

  @Column({ name: 'END_AT', type: 'timestamp with time zone', nullable: false })
  endAt: Date;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP', nullable: true })
  crtdAt: Date;

  // 관계
  @ManyToOne(() => Team, team => team.teamId)
  @JoinColumn({ name: 'TEAM_ID' })
  team: Team;

  @ManyToOne(() => User, user => user.userId)
  @JoinColumn({ name: 'USER_ID' })
  user: User;
}

import 'reflect-metadata';
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Team } from './Team';
import { ActStatus } from '../common/enums/task-status.enum';

@Entity('TEAM_TELEGRAM_LINKS')
export class TelegramLink {
  @PrimaryGeneratedColumn({ name: 'LINK_ID' })
  linkId: number;

  @Column({ name: 'TEAM_ID', type: 'number' })
  teamId: number;

  // 텔레그램 연동 토큰
  @Column({ name: 'TOKEN', type: 'varchar2', length: 500 })
  token: string;

  // 텔레그램 연동 토큰 활성 상태
  @Column({ name: 'ACT_STATUS', type: 'number', default: ActStatus.ACTIVE, nullable: false })
  actStatus: ActStatus;

  // 텔레그램 연동 토큰 만료 시간
  @Column({ name: 'END_AT', type: 'timestamp', nullable: false })
  endAt: Date;

  // 텔레그램 연동 토큰 사용 시간
  @Column({ name: 'USED_AT', type: 'timestamp', nullable: true })
  usedAt: Date | null;

  // 텔레그램 연동 토큰 생성 시간
  @Column({ name: 'CRTD_AT', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', nullable: false })
  crtdAt: Date;

  @ManyToOne(() => Team, team => team.teamId)
  @JoinColumn({ name: 'TEAM_ID' })
  team: Team;
}

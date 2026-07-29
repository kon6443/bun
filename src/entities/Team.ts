import 'reflect-metadata';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  JoinColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';
import { User } from './User';
import { TeamMember } from './TeamMember';

@Entity('TEAMS')
export class Team {
  @PrimaryGeneratedColumn({ name: 'TEAM_ID' })
  teamId: number;

  @Column({ name: 'TEAM_NAME', type: 'varchar2', length: 50 })
  teamName: string;

  @Column({ name: 'TEAM_DESCRIPTION', type: 'varchar2', length: 100, nullable: true })
  teamDescription: string | null;

  @Column({ name: 'LEADER_ID', type: 'number' })
  leaderId: number;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', nullable: true })
  crtdAt: Date;

  @Column({ name: 'ACT_STATUS', type: 'number' })
  actStatus: number;

  @Column({ name: 'TELEGRAM_CHAT_ID', type: 'number', nullable: true })
  telegramChatId: number | null;

  @Column({ name: 'DISCORD_WEBHOOK_URL', type: 'varchar2', length: 500, nullable: true })
  discordWebhookUrl: string | null;

  // 관계
  @ManyToOne(() => User, (user) => user.teams)
  @JoinColumn({ name: 'LEADER_ID' })
  leader: User;

  @OneToMany(() => TeamMember, (teamMember) => teamMember.team)
  teamMembers: TeamMember[];
}

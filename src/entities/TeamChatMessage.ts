import 'reflect-metadata';
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Team } from './Team';
import { User } from './User';

/**
 * 팀 채팅 메시지 — 스키마: migrations/*-CreateTeamChatMessages.ts
 *
 * MESSAGE_ID는 팀 안에서 단조 증가하는 순서 키다. 읽음 커서(TeamChatReadCursor)가
 * "이 ID까지 읽었다"로 동작하므로 ID 순서 = 시간 순서라는 전제에 기대고 있다.
 */
@Entity('TEAM_CHAT_MESSAGES')
export class TeamChatMessage {
  // DB: GENERATED ALWAYS AS IDENTITY (ORDER) — INSERT 시 ID 생략 필수 (명시 값은 ORA-32795 거부)
  @PrimaryGeneratedColumn({ name: 'MESSAGE_ID' })
  messageId: number;

  @Column({ name: 'TEAM_ID', type: 'number' })
  teamId: number;

  @Column({ name: 'USER_ID', type: 'number' })
  userId: number;

  @Column({ name: 'CONTENT', type: 'clob' })
  content: string;

  @Column({ name: 'CLIENT_MSG_ID', type: 'varchar2', length: 64 })
  clientMsgId: string;

  @Column({ name: 'STATUS', type: 'number', default: 1 })
  status: number; // 0: 삭제(숨김), 1: 활성(노출)

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;

  // 관계
  @ManyToOne(() => Team)
  @JoinColumn({ name: 'TEAM_ID' })
  team: Team;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'USER_ID' })
  user: User;
}

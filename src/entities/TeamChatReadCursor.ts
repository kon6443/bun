import 'reflect-metadata';
import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * 팀 채팅 읽음 커서 — 스키마: migrations/*-CreateTeamChatReadCursors.ts
 *
 * 팀·멤버당 1행. "이 멤버는 LAST_READ_MESSAGE_ID 이하의 메시지를 모두 읽었다"를 뜻한다.
 * 메시지별 읽음 행을 두지 않고 이 숫자 하나로 안 읽은 인원 수·읽은 사람·안읽음 배지를 계산한다.
 * 행이 없으면 0(아무것도 안 읽음)으로 간주한다. 값은 커지기만 한다(chat-read-cursor.ts).
 */
@Entity('TEAM_CHAT_READ_CURSORS')
export class TeamChatReadCursor {
  @PrimaryColumn({ name: 'TEAM_ID', type: 'number' })
  teamId: number;

  @PrimaryColumn({ name: 'USER_ID', type: 'number' })
  userId: number;

  @Column({ name: 'LAST_READ_MESSAGE_ID', type: 'number', default: 0 })
  lastReadMessageId: number;

  @Column({ name: 'UPDATED_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}

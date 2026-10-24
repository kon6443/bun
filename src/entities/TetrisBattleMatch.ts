import 'reflect-metadata';
import { Entity, Column, PrimaryColumn } from 'typeorm';

export const TETRIS_BATTLE_MATCH_STATUSES = ['VERIFIED', 'DISPUTED'] as const;
export type TetrisBattleMatchStatus = (typeof TETRIS_BATTLE_MATCH_STATUSES)[number];

/**
 * 테트리스 대전 경기 — 스키마: migrations/*-CreateTetrisBattleMatches.ts (docs/tasks/tetris-battle DESIGN §17-2)
 *
 * 경기 후 검증(P5)을 마친 경기만 저장한다. STATUS: 제출자 전원 VERIFIED(미제출 MISSING 포함)면 VERIFIED,
 * INVALID가 하나라도 있으면 DISPUTED(표시용). 조회는 IS_HIDDEN = 0이면 DISPUTED도 공개 — 검증 실패는 참가자 단위이고
 * 재생은 VERIFIED 참가자만(tetris-audit D-004).
 */
@Entity('TETRIS_BATTLE_MATCHES')
export class TetrisBattleMatch {
  // 서버가 발급한 12바이트 base64url (IDENTITY 아님)
  @PrimaryColumn({ name: 'MATCH_ID', type: 'varchar2', length: 16 })
  matchId: string;

  // 1~20자(코드 포인트), 80바이트 이하
  @Column({ name: 'ROOM_NAME', type: 'varchar2', length: 80 })
  roomName: string;

  @Column({ name: 'SEED', type: 'number' })
  seed: number;

  // DB CHECK 2~4
  @Column({ name: 'PLAYER_COUNT', type: 'number' })
  playerCount: number;

  // DB CHECK: TETRIS_BATTLE_MATCH_STATUSES
  @Column({ name: 'STATUS', type: 'varchar2', length: 10 })
  status: TetrisBattleMatchStatus;

  @Column({ name: 'STARTED_AT', type: 'timestamp with time zone' })
  startedAt: Date;

  @Column({ name: 'ENDED_AT', type: 'timestamp with time zone' })
  endedAt: Date;

  @Column({ name: 'IS_HIDDEN', type: 'number', default: 0 })
  isHidden: 0 | 1;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;
}

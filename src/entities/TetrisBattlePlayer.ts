import 'reflect-metadata';
import { Entity, Column, PrimaryColumn } from 'typeorm';

export const TETRIS_BATTLE_VERDICTS = ['VERIFIED', 'INVALID', 'MISSING'] as const;
export type TetrisBattleVerdict = (typeof TETRIS_BATTLE_VERDICTS)[number];

export const TETRIS_BATTLE_KO_REASONS = ['topout', 'disconnect', 'leave'] as const;
export type TetrisBattleKoReason = (typeof TETRIS_BATTLE_KO_REASONS)[number];

/**
 * 테트리스 대전 참가자 결과 — 스키마: migrations/*-CreateTetrisBattlePlayers.ts (DESIGN §17-2)
 *
 * 통계(순위·KO·보낸/받은 줄·블록·최대 콤보·프레임)는 실시간 서버 기록이다. VERDICT는 그 플레이어 리플레이의 경기 후 검증 결과
 * (미제출 = MISSING — 새로고침 기권·끊김).
 */
@Entity('TETRIS_BATTLE_PLAYERS')
export class TetrisBattlePlayer {
  @PrimaryColumn({ name: 'MATCH_ID', type: 'varchar2', length: 16 })
  matchId: string;

  // 방 내 id (p1, p2, …)
  @PrimaryColumn({ name: 'PLAYER_ID', type: 'varchar2', length: 8 })
  playerId: string;

  // 1~12자, 48바이트 이하 (게임 이름 정책)
  @Column({ name: 'NAME', type: 'varchar2', length: 48 })
  name: string;

  // 로그인 참가자면 USER_ID, 게스트·탈퇴면 NULL
  @Column({ name: 'USER_ID', type: 'number', nullable: true })
  userId: number | null;

  @Column({ name: 'PLACE', type: 'number' })
  place: number;

  @Column({ name: 'KOS', type: 'number' })
  kos: number;

  @Column({ name: 'SENT', type: 'number' })
  sent: number;

  @Column({ name: 'RECEIVED', type: 'number' })
  received: number;

  @Column({ name: 'PIECES', type: 'number' })
  pieces: number;

  @Column({ name: 'MAX_COMBO', type: 'number' })
  maxCombo: number;

  @Column({ name: 'FRAMES', type: 'number' })
  frames: number;

  // 탈락 사유 (우승자 NULL). DB CHECK: TETRIS_BATTLE_KO_REASONS
  @Column({ name: 'KO_REASON', type: 'varchar2', length: 10, nullable: true })
  koReason: TetrisBattleKoReason | null;

  // DB CHECK: TETRIS_BATTLE_VERDICTS
  @Column({ name: 'VERDICT', type: 'varchar2', length: 10 })
  verdict: TetrisBattleVerdict;
}

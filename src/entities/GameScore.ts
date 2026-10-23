import 'reflect-metadata';
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { User } from './User';

export const GAME_TYPES = ['TETRIS', 'DEFENSE'] as const;
export type GameType = (typeof GAME_TYPES)[number];

/**
 * 게임 공용 랭킹 기록 — 스키마: migrations/*-CreateGameScores.ts (docs/tasks/games DESIGN.md §1)
 *
 * 점수는 서버가 리플레이를 재실행해 계산한 값만 저장한다. 리플레이 본문은 GameReplay(별도 테이블, D-013).
 * 조회는 IS_HIDDEN = 0만 — 운영자가 SQL로 숨긴다.
 */
@Entity('GAME_SCORES')
export class GameScore {
  // DB: GENERATED ALWAYS AS IDENTITY — INSERT 시 ID 생략 필수 (명시 값은 ORA-32795 거부)
  @PrimaryGeneratedColumn({ name: 'SCORE_ID' })
  scoreId: number;

  // DB CHECK: GAME_TYPES (migrations/*-AlterGameTypeCheckAddDefense.ts)
  @Column({ name: 'GAME_TYPE', type: 'varchar2', length: 20 })
  gameType: GameType;

  @Column({ name: 'SCORE', type: 'number' })
  score: number;

  // 랭킹 보드 — 테트리스 'default', 디펜스 'endless-s{시즌}'·'weekly-{주차}'. DB CHECK: 소문자·숫자·하이픈 1~40자 (migrations/*-AddGameScoresBoardKey.ts)
  @Column({ name: 'BOARD_KEY', type: 'varchar2', length: 40, default: 'default' })
  boardKey: string;

  // 1~12자, 48바이트 이하
  @Column({ name: 'PLAYER_NAME', type: 'varchar2', length: 48 })
  playerName: string;

  // 비로그인 등록이면 NULL, 탈퇴 시 NULL
  @Column({ name: 'USER_ID', type: 'number', nullable: true })
  userId: number | null;

  @Column({ name: 'DURATION_MS', type: 'number' })
  durationMs: number;

  // 게임별 상세 값 JSON 문자열 (DB CHECK IS JSON)
  @Column({ name: 'DETAIL', type: 'clob' })
  detail: string;

  // 응답에 싣지 않는다 — 운영자 도배 판별용
  @Column({ name: 'IP_HASH', type: 'varchar2', length: 64, nullable: true })
  ipHash: string | null;

  @Column({ name: 'IS_HIDDEN', type: 'number', default: 0 })
  isHidden: 0 | 1;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;

  // 관계
  @ManyToOne(() => User)
  @JoinColumn({ name: 'USER_ID' })
  user: User | null;
}

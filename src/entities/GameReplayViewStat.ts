import 'reflect-metadata';
import { Entity, Column, PrimaryColumn } from 'typeorm';
import type { GameType } from './GameScore';

/**
 * 리플레이 조회 일별 집계 — 스키마: migrations/*-CreateGameReplayViewStats.ts (docs/tasks/replay-views D-001)
 *
 * 기록 1건 × KST 하루 1행. 누적 조회수·시청시간은 이 테이블의 SUM이다(따로 저장하지 않는다 — 두 곳에 두면 어긋난다).
 * 기간별 인기 목록은 STAT_DATE 범위로 묶어 센다. (SCORE_ID, GAME_TYPE) 복합 FK가 GAME_SCORES와 게임 종류 일치를 강제한다.
 */
@Entity('GAME_REPLAY_VIEW_STATS')
export class GameReplayViewStat {
  @PrimaryColumn({ name: 'SCORE_ID', type: 'number' })
  scoreId: number;

  // 집계 하루 = KST 날짜 'YYYY-MM-DD' (kstDateOf). 시각이 아니라 날짜 키 — Oracle은 TIMESTAMP WITH TIME ZONE을 PK로 못 쓰고(ORA-02329),
  // 시간대 없는 TIMESTAMP는 세션 시간대(로컬 KST·운영 UTC)에 따라 저장값이 달라진다(docs/tasks/replay-views D-006)
  @PrimaryColumn({ name: 'STAT_DATE', type: 'varchar2', length: 10 })
  statDate: string;

  @Column({ name: 'GAME_TYPE', type: 'varchar2', length: 20 })
  gameType: GameType;

  @Column({ name: 'VIEW_COUNT', type: 'number', default: 0 })
  viewCount: number;

  // 재생이 진행된 벽시계 시간 합 (밀리초) — 배속을 곱하지 않는다
  @Column({ name: 'WATCH_MS', type: 'number', default: 0 })
  watchMs: number;
}

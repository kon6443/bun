import 'reflect-metadata';
import { Entity, Column, PrimaryColumn } from 'typeorm';
import type { GameType } from './GameScore';

/**
 * 게임 리플레이 — 스키마: migrations/*-CreateGameReplays.ts (docs/tasks/games DESIGN.md §1-2)
 *
 * 랭킹 기록 1건당 1개. (SCORE_ID, GAME_TYPE) 복합 FK가 GAME_SCORES와 게임 종류 일치를 강제한다(D-012).
 * 랭킹 목록 조회는 이 테이블을 읽지 않는다 — 재생 API에서 기록 1건 단위로만 읽는다(D-013).
 */
@Entity('GAME_REPLAYS')
export class GameReplay {
  // GAME_SCORES.SCORE_ID를 그대로 쓴다 (IDENTITY 아님)
  @PrimaryColumn({ name: 'SCORE_ID', type: 'number' })
  scoreId: number;

  @Column({ name: 'GAME_TYPE', type: 'varchar2', length: 20 })
  gameType: GameType;

  @Column({ name: 'ENGINE_VERSION', type: 'number' })
  engineVersion: number;

  @Column({ name: 'SEED', type: 'number' })
  seed: number;

  // 리플레이 본문 JSON을 gzip한 바이너리 — 게임별 params(테트리스 das·arr) + frames·inputs. seed·엔진 버전은 컬럼에 따로
  @Column({ name: 'REPLAY', type: 'blob' })
  replay: Buffer;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;
}

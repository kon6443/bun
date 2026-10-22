import 'reflect-metadata';
import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * 테트리스 대전 리플레이 — 스키마: migrations/*-CreateTetrisBattleReplays.ts (DESIGN §17-2)
 *
 * 제출된 리플레이(검증 통과·실패 모두 — 실패는 조사용)를 참가자 1명당 1개 보관한다. 재생 API는 VERIFIED 참가자만 내준다.
 * 경기 목록 조회는 이 테이블을 읽지 않는다(LOB) — 재생할 때 1건 단위로만 읽는다.
 */
@Entity('TETRIS_BATTLE_REPLAYS')
export class TetrisBattleReplay {
  @PrimaryColumn({ name: 'MATCH_ID', type: 'varchar2', length: 16 })
  matchId: string;

  @PrimaryColumn({ name: 'PLAYER_ID', type: 'varchar2', length: 8 })
  playerId: string;

  @Column({ name: 'BATTLE_ENGINE_VERSION', type: 'number' })
  battleEngineVersion: number;

  // 대전 리플레이 JSON(battleEngineVersion 제외 — seed·das·arr·frames·inputs·garbage)을 gzip한 바이너리
  @Column({ name: 'REPLAY', type: 'blob' })
  replay: Buffer;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;
}

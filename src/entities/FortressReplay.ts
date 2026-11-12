import 'reflect-metadata';
import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * 포트리스 리플레이 — 스키마: migrations/*-CreateFortressReplays.ts (docs/tasks/fortress DESIGN §12)
 *
 * 경기당 1개(replay id = matchId). 경기 목록 조회는 이 테이블을 읽지 않는다(LOB) — 재생할 때 1건 단위로만 읽는다.
 */
@Entity('FORTRESS_REPLAYS')
export class FortressReplay {
  @PrimaryColumn({ name: 'MATCH_ID', type: 'varchar2', length: 16 })
  matchId: string;

  // 리플레이를 만든 엔진 버전 — 재생에는 같은 버전 엔진이 필요
  @Column({ name: 'ENGINE_VERSION', type: 'number' })
  engineVersion: number;

  // JSON { config, actions, slots, stateHash }를 gzip한 바이너리
  @Column({ name: 'REPLAY', type: 'blob' })
  replay: Buffer;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;
}

import 'reflect-metadata';
import { Entity, Column, PrimaryColumn } from 'typeorm';

export const FORTRESS_MATCH_MODES = ['ffa', 'team'] as const;
export type FortressMatchMode = (typeof FORTRESS_MATCH_MODES)[number];

export const FORTRESS_RESULT_KINDS = ['win', 'draw'] as const;
export type FortressResultKind = (typeof FORTRESS_RESULT_KINDS)[number];

/**
 * 포트리스 경기 — 스키마: migrations/*-CreateFortressMatches.ts (docs/tasks/fortress DESIGN §12)
 *
 * 서버 권위 턴 매치라 경기가 끝나면 서버가 바로 1건 저장한다(제출·검증 단계 없음). 조회는 IS_HIDDEN = 0만.
 */
@Entity('FORTRESS_MATCHES')
export class FortressMatch {
  // 서버가 발급한 12바이트 base64url (IDENTITY 아님) — 리플레이 id와 같다
  @PrimaryColumn({ name: 'MATCH_ID', type: 'varchar2', length: 16 })
  matchId: string;

  // 1~20자(코드 포인트), 80바이트 이하. 기능 배포 전에 시작한 경기는 NULL(Oracle은 ''를 NULL로 다룬다)
  @Column({ name: 'ROOM_NAME', type: 'varchar2', length: 80, nullable: true })
  roomName: string | null;

  // DB CHECK: FORTRESS_MATCH_MODES
  @Column({ name: 'MODE', type: 'varchar2', length: 4 })
  mode: FortressMatchMode;

  // 엔진 MAP_IDS — 'random'은 시작 때 실제 맵으로 정해져 오지 않는다
  @Column({ name: 'MAP_ID', type: 'varchar2', length: 16 })
  mapId: string;

  @Column({ name: 'SEED', type: 'number' })
  seed: number;

  @Column({ name: 'ENGINE_VERSION', type: 'number' })
  engineVersion: number;

  // DB CHECK 2~4
  @Column({ name: 'PLAYER_COUNT', type: 'number' })
  playerCount: number;

  // 끝난 턴 수 (최종 state.turn.no)
  @Column({ name: 'TURNS', type: 'number' })
  turns: number;

  // DB CHECK: FORTRESS_RESULT_KINDS
  @Column({ name: 'RESULT_KIND', type: 'varchar2', length: 4 })
  resultKind: FortressResultKind;

  // team 모드 승리면 이긴 팀(0|1), 그 밖(ffa·무승부)은 NULL
  @Column({ name: 'WINNER_TEAM', type: 'number', nullable: true })
  winnerTeam: number | null;

  @Column({ name: 'STARTED_AT', type: 'timestamp with time zone' })
  startedAt: Date;

  @Column({ name: 'ENDED_AT', type: 'timestamp with time zone' })
  endedAt: Date;

  @Column({ name: 'IS_HIDDEN', type: 'number', default: 0 })
  isHidden: 0 | 1;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;
}

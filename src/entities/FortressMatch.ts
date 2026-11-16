import 'reflect-metadata';
import { Entity, Column, PrimaryColumn } from 'typeorm';

export const FORTRESS_MATCH_MODES = ['ffa', 'team'] as const;
export type FortressMatchMode = (typeof FORTRESS_MATCH_MODES)[number];

/** 경기 출처 — online 서버 판정 온라인 대전 · solo 클라이언트가 올린 AI전·같은 기기 대전(서버 재시뮬레이션 검증, D-027) */
export const FORTRESS_MATCH_SOURCES = ['online', 'solo'] as const;
export type FortressMatchSource = (typeof FORTRESS_MATCH_SOURCES)[number];

export const FORTRESS_RESULT_KINDS = ['win', 'draw'] as const;
export type FortressResultKind = (typeof FORTRESS_RESULT_KINDS)[number];

/**
 * 포트리스 경기 — 스키마: migrations/*-CreateFortressMatches.ts (docs/tasks/fortress DESIGN §12)
 *
 * 온라인(online)은 서버 권위 턴 매치라 경기가 끝나면 서버가 바로 1건 저장한다. solo는 클라이언트가 올린 기록을 서버가 엔진으로 다시 돌려 검증한 뒤 저장한다(D-027). 조회는 IS_HIDDEN = 0만.
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

  // DB CHECK: FORTRESS_MATCH_SOURCES. 최근 경기 목록은 online만 (마이그레이션 …803000)
  @Column({ name: 'SOURCE', type: 'varchar2', length: 6, default: 'online' })
  source: FortressMatchSource;

  @Column({ name: 'IS_HIDDEN', type: 'number', default: 0 })
  isHidden: 0 | 1;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;
}

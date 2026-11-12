import 'reflect-metadata';
import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * 포트리스 경기 참가자 결과 — 스키마: migrations/*-CreateFortressPlayers.ts (docs/tasks/fortress DESIGN §12)
 *
 * 값은 경기 종료 때 서버 집계(fortress-match.rules.ts)와 같다 — matchEnded 페이로드의 players와 같은 숫자.
 */
@Entity('FORTRESS_PLAYERS')
export class FortressPlayer {
  @PrimaryColumn({ name: 'MATCH_ID', type: 'varchar2', length: 16 })
  matchId: string;

  // 방 안의 id (p1, p2, …)
  @PrimaryColumn({ name: 'PLAYER_ID', type: 'varchar2', length: 8 })
  playerId: string;

  // 엔진 slot 0..3 (입장 순서)
  @Column({ name: 'SLOT', type: 'number' })
  slot: number;

  // 1~12자, 48바이트 이하 (게임 이름 정책)
  @Column({ name: 'NAME', type: 'varchar2', length: 48 })
  name: string;

  // 로그인 참가자면 USER_ID, 게스트·탈퇴면 NULL. 응답에 싣지 않는다
  @Column({ name: 'USER_ID', type: 'number', nullable: true })
  userId: number | null;

  // team 모드 0|1, ffa NULL
  @Column({ name: 'TEAM', type: 'number', nullable: true })
  team: number | null;

  @Column({ name: 'TANK_ID', type: 'number' })
  tankId: number;

  // 종료 시 남은 HP
  @Column({ name: 'HP', type: 'number' })
  hp: number;

  // 자기 턴 fire로 다른 팀에게 깎은 HP
  @Column({ name: 'DAMAGE', type: 'number' })
  damage: number;

  // 자기 턴 fire로 다른 팀 탱크를 죽인 수
  @Column({ name: 'KOS', type: 'number' })
  kos: number;

  // 같은 값은 같은 순위(1, 1, 3)
  @Column({ name: 'PLACE', type: 'number' })
  place: number;
}

import 'reflect-metadata';
import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * 사용자가 강화한 스킨 레벨 — 스키마: migrations/*-CreateUserSkinLevels.ts (docs/tasks/skin-levels D-002)
 *
 * 사용자 × 슬롯 × 아이템 1행. 행이 없으면 Lv1 — 강화한 아이템만 행이 생긴다(DB CHECK 2~5). 사용자 삭제 시 CASCADE
 */
@Entity('USER_SKIN_LEVELS')
export class UserSkinLevel {
  @PrimaryColumn({ name: 'USER_ID', type: 'number' })
  userId: number;

  // TETRIS_SKIN_SLOT_KEYS 값 (예: TETRIS_BLOCK)
  @PrimaryColumn({ name: 'SLOT', type: 'varchar2', length: 40 })
  slot: string;

  // 카탈로그 아이템 id (예: chocolate)
  @PrimaryColumn({ name: 'SKIN_ID', type: 'varchar2', length: 64 })
  skinId: string;

  @Column({ name: 'SKIN_LEVEL', type: 'number' })
  level: number;

  @Column({ name: 'UPDATED_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}

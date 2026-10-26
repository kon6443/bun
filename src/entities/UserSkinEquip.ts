import 'reflect-metadata';
import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * 사용자가 장착한 스킨 — 스키마: migrations/*-CreateUserSkinEquips.ts (docs/tasks/tetris-skins D-003)
 *
 * 사용자 × 슬롯 1행. 행이 없는 슬롯은 default다. 슬롯·아이템 목록은 코드 카탈로그(modules/users/skin-catalog.ts)가 정한다 —
 * 아이템이 늘어도 DB 변경이 없도록 DB는 형식만 검사한다. 사용자 삭제 시 CASCADE
 */
@Entity('USER_SKIN_EQUIPS')
export class UserSkinEquip {
  @PrimaryColumn({ name: 'USER_ID', type: 'number' })
  userId: number;

  // TETRIS_SKIN_SLOT_KEYS 값 (예: TETRIS_BLOCK)
  @PrimaryColumn({ name: 'SLOT', type: 'varchar2', length: 40 })
  slot: string;

  // 카탈로그 아이템 id (예: gameboy)
  @Column({ name: 'SKIN_ID', type: 'varchar2', length: 64 })
  skinId: string;

  @Column({ name: 'UPDATED_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}

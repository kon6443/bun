import 'reflect-metadata';
import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 사용자 포인트 원장 — 스키마: migrations/*-CreateUserPointLedger.ts (docs/tasks/skin-levels D-002)
 *
 * 포인트의 SSOT(skin-levels D-004) — 적립(로그인 테트리스 기록 = 양수)·소비(강화 = 음수)·이후 보상이 모두 한 줄씩. 잔액 = 합계.
 * (USER_ID, REASON, REF_KEY) 유니크 — 같은 기록 적립·같은 강화는 한 번만. 사용자 삭제 시 CASCADE
 */
@Entity('USER_POINT_LEDGER')
export class UserPointLedger {
  // DB가 GENERATED ALWAYS AS IDENTITY — 값을 넣지 않는다
  @PrimaryGeneratedColumn({ name: 'LEDGER_ID' })
  ledgerId: number;

  @Column({ name: 'USER_ID', type: 'number' })
  userId: number;

  @Column({ name: 'AMOUNT', type: 'number' })
  amount: number;

  // USER_POINT_REASONS 값 (예: SKIN_UPGRADE)
  @Column({ name: 'REASON', type: 'varchar2', length: 40 })
  reason: string;

  // 사유별 대상 (예: TETRIS_BLOCK:neon:3)
  @Column({ name: 'REF_KEY', type: 'varchar2', length: 160 })
  refKey: string;

  // 사람이 읽는 설명 (예: 테트리스 기록 #41 · default 보드 · 12,340점) — 스키마: migrations/*-AddUserPointLedgerMemo.ts
  @Column({ name: 'MEMO', type: 'varchar2', length: 400, nullable: true })
  memo: string | null;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;
}

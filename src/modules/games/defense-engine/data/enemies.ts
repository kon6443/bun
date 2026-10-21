/**
 * 적 데이터 (defense DESIGN §C5) — E1은 졸개만. HP는 웨이브 그룹이 정한다(단위 EHP × hp‰ — 생성기는 S1 슬라이스)
 * 원본·동기화 규칙은 ../constants.ts 머리 주석
 */

export type EnemyKind = {
  id: number;
  air: boolean;
  /** 밀리타일/틱 (33 ≈ 1칸/초) */
  speed: number;
  /** 물리·마법 저항 ‰ */
  resistPhy: number;
  resistMag: number;
  /** 누수 시 깎는 목숨 */
  leakLives: number;
};

export const ENEMY_ID = {
  GRUNT: 0,
} as const;

const GRUNT: EnemyKind = { id: ENEMY_ID.GRUNT, air: false, speed: 33, resistPhy: 0, resistMag: 0, leakLives: 1 };

/** 인덱스 = 적 id */
export const ENEMIES: readonly EnemyKind[] = [GRUNT];

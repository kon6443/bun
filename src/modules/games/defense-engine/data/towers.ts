/**
 * 타워 데이터 (defense DESIGN §C4) — E1은 궁수탑 Lv1~3만. 수치 = 계약(바꾸면 ENGINE_VERSION 상승)
 * 원본·동기화 규칙은 ../constants.ts 머리 주석
 */

import { DAMAGE, ELEMENT } from '../constants';

export type TowerLevel = {
  /** 이 레벨이 되는 데 드는 골드 (Lv1 = 건설비, Lv2~ = 업그레이드비) */
  cost: number;
  damage: number;
  /** 발사 주기 (틱) */
  periodTicks: number;
  /** 사거리 (밀리타일) */
  range: number;
};

export type TowerKind = {
  id: number;
  damageType: number;
  element: number;
  hitsGround: boolean;
  hitsAir: boolean;
  /** 투사체 속도 (밀리타일/틱) — 유도형, 발사 시 거리로 비행 틱을 정한다(§C2) */
  projectileSpeed: number;
  /** 인덱스 0 = Lv1 */
  levels: readonly TowerLevel[];
};

export const TOWER_ID = {
  ARCHER: 0,
} as const;

/** 궁수탑 — 물리·지공 단일 투사체. 8/18 · 13/18 · 19/18, 사거리 3.0 · 3.0 · 3.3칸, 누적 70·120·200 (§C4·§L4) */
const ARCHER: TowerKind = {
  id: TOWER_ID.ARCHER,
  damageType: DAMAGE.PHY,
  element: ELEMENT.NONE,
  hitsGround: true,
  hitsAir: true,
  projectileSpeed: 300,
  levels: [
    { cost: 70, damage: 8, periodTicks: 18, range: 3000 },
    { cost: 50, damage: 13, periodTicks: 18, range: 3000 },
    { cost: 80, damage: 19, periodTicks: 18, range: 3300 },
  ],
};

/** 인덱스 = 타워 id */
export const TOWERS: readonly TowerKind[] = [ARCHER];

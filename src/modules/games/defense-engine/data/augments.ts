/**
 * 증강 카드 24장 (defense DESIGN §C7·§L10) — 효과는 효과 엔진(../effects) 데이터
 * towers = "관련 타워" — 무한 모드 보장 규칙(보유 타워 관련 1장)과 금지 타워 제외에 쓴다
 * 원본·동기화 규칙은 ../constants.ts 머리 주석
 */

import { EFFECT_OP, FLAG, RARITY, SCOPE, STAT } from '../constants';
import type { Effect } from '../effects';
import { TOWER_ID } from './towers';

export type AugmentCard = {
  id: number;
  rarity: number;
  /** 관련 타워 id — 빈 배열이면 공통 카드 */
  towers: readonly number[];
  effects: readonly Effect[];
  /** 고르는 순간 한 번 깎는 목숨 (할인 계약) */
  livesCost: number;
};

const T = TOWER_ID;
const tower = (id: number, stat: number, op: number, value: number): Effect => ({ scope: SCOPE.TOWER, target: id, stat, op, value });
const allTowers = (stat: number, op: number, value: number): Effect => ({ scope: SCOPE.ALL_TOWERS, target: 0, stat, op, value });
const economy = (stat: number, op: number, value: number): Effect => ({ scope: SCOPE.ECONOMY, target: 0, stat, op, value });
const flag = (id: number): Effect => ({ scope: SCOPE.RULES, target: 0, stat: id, op: EFFECT_OP.FLAG, value: 0 });
const { MUL, ADD, SET } = EFFECT_OP;

function card(id: number, rarity: number, towers: readonly number[], effects: readonly Effect[], livesCost = 0): AugmentCard {
  return { id, rarity, towers, effects, livesCost };
}

/** 인덱스 = 카드 id (0부터 — 정본 표의 번호 − 1) */
export const AUGMENTS: readonly AugmentCard[] = [
  // 타워 특화 12
  card(0, RARITY.COMMON, [T.ARCHER], [tower(T.ARCHER, STAT.DAMAGE, MUL, 1250)]), // 날카로운 촉
  card(1, RARITY.RARE, [T.ARCHER], [flag(FLAG.ARCHER_PIERCE_THIRD)]), // 세 번째 화살 — 3발째마다 관통 2
  card(2, RARITY.COMMON, [T.CANNON], [tower(T.CANNON, STAT.SPLASH, MUL, 1300)]), // 큰 화약통
  card(3, RARITY.RARE, [T.CANNON], [flag(FLAG.CANNON_AFTERSHOCK)]), // 여진 — 착탄 지점 30틱 감속 300‰
  card(4, RARITY.COMMON, [T.MAGE], [tower(T.MAGE, STAT.DAMAGE, MUL, 1250)]), // 마력 증폭
  card(5, RARITY.RARE, [T.MAGE], [flag(FLAG.MAGE_RESONANCE)]), // 공명 — 근처 두 번째 대상에 50%
  card(6, RARITY.COMMON, [T.FROST], [allTowers(STAT.SLOW_POWER, ADD, 100)]), // 혹한
  card(7, RARITY.RARE, [T.FROST], [flag(FLAG.SLOW_SHRED)]), // 서리 파쇄 — 감속된 적 물리 저항 −150‰
  card(8, RARITY.COMMON, [T.CROSSBOW], [tower(T.CROSSBOW, STAT.RANGE, MUL, 1200), tower(T.CROSSBOW, STAT.DAMAGE, MUL, 1150)]), // 매의 눈
  card(9, RARITY.LEGENDARY, [T.CROSSBOW], [flag(FLAG.CROSSBOW_GROUND)]), // 대지 겨냥 — 지상도 공격(피해 50%)
  card(10, RARITY.COMMON, [T.TESLA], [tower(T.TESLA, STAT.CHAIN_COUNT, ADD, 1)]), // 고전압
  card(11, RARITY.RARE, [T.TESLA], [tower(T.TESLA, STAT.CHAIN_FALLOFF, SET, 0)]), // 축전
  // 속성·상태 시너지 5
  card(12, RARITY.RARE, [T.CANNON], [allTowers(STAT.BURN_TICKS, MUL, 1500), allTowers(STAT.BURN_STACKS, ADD, 2)]), // 업화
  card(13, RARITY.RARE, [T.TESLA, T.FROST], [flag(FLAG.SUPERCONDUCT)]), // 초전도 — 감속된 적에게 번개 피해 +30%
  card(14, RARITY.COMMON, [T.ARCHER, T.CROSSBOW], [allTowers(STAT.POISON_STACKS, ADD, 4)]), // 맹독
  card(15, RARITY.COMMON, [T.MAGE, T.FROST, T.CANNON, T.CROSSBOW], [
    allTowers(STAT.VULNERABLE_TICKS, MUL, 1500),
    allTowers(STAT.SHRED_TICKS, MUL, 1500),
  ]), // 약점 공략
  card(16, RARITY.LEGENDARY, [], [flag(FLAG.ELEMENT_FUSION)]), // 원소 융합 — 상태효과 2종 이상 적 피해 +20%
  // 경제 3
  card(17, RARITY.COMMON, [], [economy(STAT.KILL_GOLD, MUL, 1200)]), // 현상금
  card(18, RARITY.COMMON, [], [economy(STAT.CLEAR_BONUS, MUL, 1500)]), // 전리품
  card(19, RARITY.RARE, [], [economy(STAT.SELL_REFUND, SET, 1000)]), // 재활용
  // 트레이드오프 3
  card(20, RARITY.RARE, [], [allTowers(STAT.COST, MUL, 800)], 5), // 할인 계약 — 목숨 −5
  card(21, RARITY.RARE, [], [allTowers(STAT.DAMAGE, MUL, 1250), allTowers(STAT.RANGE, MUL, 850)]), // 광전사
  card(22, RARITY.COMMON, [], [economy(STAT.EARLY_CALL_BONUS, MUL, 3000), economy(STAT.COUNTDOWN, MUL, 500)]), // 시간 압박
  // 공간 1
  card(23, RARITY.RARE, [], [{ scope: SCOPE.RULES, target: 0, stat: STAT.SLOTS_UNLOCK, op: ADD, value: 1 }]), // 개척
];

/** 카드 id — 규칙 상충(R8 판매 불가 ↔ 재활용)·잠긴 슬롯 없는 맵(개척) 제외에서 쓴다 */
export const AUGMENT_ID = { RECYCLE: 19, PIONEER: 23 } as const;

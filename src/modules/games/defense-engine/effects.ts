/**
 * 효과 엔진 (defense DESIGN §C6) — 증강 카드·주간 규칙 변형이 같은 정수 데이터를 쓴다
 * 효과 1개 = { scope, target, stat, op, value }. 판 시작(규칙)·카드 선택 때 활성 목록 끝에 붙고,
 * 수치를 읽을 때 목록을 순서대로 적용한다: 곱(‰, 하나씩 내림) → 더하기 → 덮어쓰기(마지막 것)
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import { EFFECT_OP, PERMILLE, SCOPE } from './constants';

export type Effect = {
  scope: number;
  /** 범위별 값 — TOWER: 타워 id · TOWER_TAG: 원소 · ENEMY: 적 id · 그 밖은 0 */
  target: number;
  stat: number;
  op: number;
  value: number;
};

/** 수치를 읽는 대상 — 타워면 종류·원소, 적이면 종류. 경제·규칙은 둘 다 −1 */
export type EffectSubject = { tower: number; element: number; enemy: number };

export const ECONOMY_SUBJECT: EffectSubject = { tower: -1, element: -1, enemy: -1 };
/** "모든 적"에 걸리는 수치를 종류와 무관하게 읽을 때의 적 자리 값 — ALL_ENEMIES 범위만 맞고 특정 적(ENEMY) 범위는 맞지 않는다 */
export const ANY_ENEMY_KIND = -2;

function matches(effect: Effect, subject: EffectSubject): boolean {
  switch (effect.scope) {
    case SCOPE.TOWER:
      return subject.tower === effect.target;
    case SCOPE.TOWER_TAG:
      return subject.tower >= 0 && subject.element === effect.target;
    case SCOPE.ALL_TOWERS:
      return subject.tower >= 0;
    case SCOPE.ENEMY:
      return subject.enemy === effect.target;
    case SCOPE.ALL_ENEMIES:
      return subject.enemy >= 0 || subject.enemy === ANY_ENEMY_KIND;
    default:
      // ECONOMY·RULES — 대상 없는 값
      return subject.tower === -1 && subject.enemy === -1;
  }
}

/** base에 활성 효과를 적용한 값 — 음수가 되지 않게 0으로 자른다 */
export function statValue(effects: readonly Effect[], subject: EffectSubject, stat: number, base: number): number {
  let value = base;
  for (const e of effects) {
    if (e.op === EFFECT_OP.MUL && e.stat === stat && matches(e, subject)) value = Math.floor((value * e.value) / PERMILLE);
  }
  for (const e of effects) {
    if (e.op === EFFECT_OP.ADD && e.stat === stat && matches(e, subject)) value += e.value;
  }
  for (const e of effects) {
    if (e.op === EFFECT_OP.SET && e.stat === stat && matches(e, subject)) value = e.value;
  }
  return Math.max(0, value);
}

/** 규칙 켬 여부 — 켜져 있으면 마지막 효과의 value(규칙 인자), 아니면 −1 */
export function flagValue(effects: readonly Effect[], flag: number): number {
  let value = -1;
  for (const e of effects) if (e.op === EFFECT_OP.FLAG && e.stat === flag) value = e.value;
  return value;
}

export function hasFlag(effects: readonly Effect[], flag: number): boolean {
  return flagValue(effects, flag) >= 0;
}

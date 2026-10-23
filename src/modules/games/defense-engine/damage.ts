/**
 * 피해 계산 (defense DESIGN §C1) — 곱 후 내림, 순서 고정
 *   d1 = base (상성 행렬 1차 항등) → r = clamp(저항 − 파쇄, 0, 800) → d2 = ⌊d1 × (1000 − r) / 1000⌋
 *   → d3 = ⌊d2 × (1000 + 취약) / 1000⌋ → 피해 = max(1, d3)
 * 증강 시너지: 초전도(번개 태그 × 감속된 적 +30%) · 서리 파쇄(감속된 적 물리 저항 −150‰) · 원소 융합(상태효과 2종 이상 +20%)
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import {
  DAMAGE,
  ELEMENT,
  EVENT,
  FLAG,
  PERMILLE,
  RESIST_CAP_PERMILLE,
  SHRED_CAP_PERMILLE,
} from './constants';
import { hasFlag } from './effects';
import { ENEMY_STATUS, type Enemy, type GameState } from './state';

const SUPERCONDUCT_PERMILLE = 1300;
const SLOW_SHRED_PERMILLE = 150;
const FUSION_VULNERABLE_PERMILLE = 200;

/** 걸린 상태효과 종류 수 (원소 융합) */
export function statusKinds(enemy: Enemy): number {
  let kinds = 0;
  if (enemy.slowTicks > 0) kinds++;
  if (enemy.stunTicks > 0) kinds++;
  if (enemy.burnSources.length > 0) kinds++;
  if (enemy.poisonStacks > 0) kinds++;
  if (enemy.shredTicks > 0) kinds++;
  if (enemy.vulnerableTicks > 0) kinds++;
  return kinds;
}

/** 실제로 깎이는 피해 (적용 전 계산만) */
export function computeDamage(state: GameState, enemy: Enemy, base: number, damageType: number, element: number): number {
  const effects = state.effects;
  const slowed = enemy.slowTicks > 0;
  let d1 = base;
  if (element === ELEMENT.LIGHTNING && slowed && hasFlag(effects, FLAG.SUPERCONDUCT)) d1 = Math.floor((d1 * SUPERCONDUCT_PERMILLE) / PERMILLE);
  let resist = 0;
  if (damageType === DAMAGE.PHY) {
    const shred = Math.min(SHRED_CAP_PERMILLE, enemy.shred + (slowed && hasFlag(effects, FLAG.SLOW_SHRED) ? SLOW_SHRED_PERMILLE : 0));
    resist = enemy.resistPhy - shred;
  } else if (damageType === DAMAGE.MAG) {
    resist = enemy.resistMag;
  }
  const r = Math.min(RESIST_CAP_PERMILLE, Math.max(0, resist));
  const d2 = Math.floor((d1 * (PERMILLE - r)) / PERMILLE);
  const vulnerable = enemy.vulnerable + (hasFlag(effects, FLAG.ELEMENT_FUSION) && statusKinds(enemy) >= 2 ? FUSION_VULNERABLE_PERMILLE : 0);
  const d3 = Math.floor((d2 * (PERMILLE + vulnerable)) / PERMILLE);
  return Math.max(1, d3);
}

/**
 * 피해를 주고 죽으면 deaths 끝에 넣는다(피해 적용 순서 = 사망 처리 순서, §E2-8)
 * shatterDamage > 0이면 감속·기절 중 처치 시 파편(산산조각)을 남긴다
 */
export function dealDamage(
  state: GameState,
  enemy: Enemy,
  base: number,
  damageType: number,
  element: number,
  sourceId: number,
  deaths: Enemy[],
  events: number[] | null,
  shatterDamage = 0,
  shatterRadius = 0,
): number {
  if (enemy.status !== ENEMY_STATUS.ALIVE) return 0;
  const damage = computeDamage(state, enemy, base, damageType, element);
  enemy.hp -= damage;
  if (events) events.push(EVENT.HIT, enemy.id, damage, sourceId);
  if (enemy.hp <= 0) {
    enemy.hp = 0;
    enemy.status = ENEMY_STATUS.KILLED;
    if (shatterDamage > 0 && (enemy.slowTicks > 0 || enemy.stunTicks > 0)) {
      enemy.shatterDamage = shatterDamage;
      enemy.shatterRadius = shatterRadius;
    }
    deaths.push(enemy);
  }
  return damage;
}

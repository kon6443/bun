/**
 * 상태효과 (defense DESIGN §C3) — 걸기(중첩 규칙)와 매 틱 갱신(지속 감소·30틱마다 지속 피해)
 *   감속: 가장 강한 1개(더 강하면 값·지속 교체, 같은 세기 재적용은 긴 지속, 약하면 무시) · 기절: 남은 시간 긴 쪽 + 120틱 점감 · 화상: 출처 타워당 1스택, 최대 3스택 가산
 *   중독: 가산(타워별 상한), 재적용 시 지속 갱신, 고정 피해 · 파쇄: 가산(합계 −500‰) · 취약: 감속과 같은 규칙(저주 폭발은 자기 지속)
 *   보스(·공성 거인): 감속·기절·취약 효과 배율(slowScale 등)
 * 원본·동기화 규칙은 constants.ts 머리 주석
 */

import {
  BURN_STACK_LIMIT,
  DAMAGE,
  DOT_INTERVAL_TICKS,
  ELEMENT,
  EVENT,
  PERMILLE,
  SHRED_CAP_PERMILLE,
  STAT,
  STATUS,
  STUN_DIMINISH_PERMILLE,
  STUN_DIMINISH_WINDOW_TICKS,
} from './constants';
import { ENEMIES } from './data/enemies';
import type { StatusApply } from './data/towers';
import { dealDamage } from './damage';
import { type EffectSubject, statValue } from './effects';
import { ENEMY_STATUS, type Enemy, type GameState } from './state';

export type StatusSource = {
  /** 효과 엔진 대상 — 증강(혹한·업화·맹독·약점 공략)이 수치를 바꾼다 */
  subject: EffectSubject;
  /** 출처 키 = 슬롯 + 1 (0 = 타워 아님) — 화상은 출처당 1스택. 판매·재건설해도 같은 슬롯은 같은 출처 */
  sourceKey: number;
  /** 역병 타워의 중독인지 (사망 시 전염) */
  plague: boolean;
  /** 저주 폭발 ‰ (0 = 없음) */
  curseExplode: number;
};

/**
 * "가장 강한 1개" 규칙(감속·취약) — 더 강하면 값·지속을 함께 바꾸고, 같은 세기면 지속만 긴 쪽, 약하면 무시
 * (약한 효과의 재적용이 강한 효과의 지속을 늘리지 않는다). 걸려 있지 않으면 무엇이든 건다
 */
function replaceStrongest(current: number, currentTicks: number, value: number, ticks: number): boolean {
  if (currentTicks === 0) return ticks > 0;
  return value >= current;
}

export function applyStatus(state: GameState, enemy: Enemy, spec: StatusApply, source: StatusSource, events: number[] | null): void {
  if (enemy.status !== ENEMY_STATUS.ALIVE) return;
  const kind = ENEMIES[enemy.kind];
  const effects = state.effects;
  let shown = spec.value;
  switch (spec.status) {
    case STATUS.SLOW: {
      const power = statValue(effects, source.subject, STAT.SLOW_POWER, spec.value);
      const value = Math.floor((power * kind.slowScale) / PERMILLE);
      if (!replaceStrongest(enemy.slowTicks > 0 ? enemy.slow : 0, enemy.slowTicks, value, spec.ticks)) return;
      if (value > enemy.slow || enemy.slowTicks === 0) enemy.slowTicks = spec.ticks;
      else enemy.slowTicks = Math.max(enemy.slowTicks, spec.ticks);
      enemy.slow = value;
      shown = value;
      break;
    }
    case STATUS.STUN: {
      if (enemy.stunCount === 0 || state.tick - enemy.stunWindowStart >= STUN_DIMINISH_WINDOW_TICKS) {
        enemy.stunWindowStart = state.tick;
        enemy.stunCount = 0;
      }
      const factor = STUN_DIMINISH_PERMILLE[Math.min(enemy.stunCount, STUN_DIMINISH_PERMILLE.length - 1)];
      enemy.stunCount += 1;
      const ticks = Math.floor((Math.floor((spec.ticks * factor) / PERMILLE) * kind.stunScale) / PERMILLE);
      enemy.stunTicks = Math.max(enemy.stunTicks, ticks);
      shown = ticks;
      break;
    }
    case STATUS.BURN: {
      const ticks = statValue(effects, source.subject, STAT.BURN_TICKS, spec.ticks);
      const limit = statValue(effects, source.subject, STAT.BURN_STACKS, BURN_STACK_LIMIT);
      const index = enemy.burnSources.indexOf(source.sourceKey);
      if (index >= 0) {
        enemy.burnDps[index] = Math.max(enemy.burnDps[index], spec.value);
        enemy.burnTicks[index] = Math.max(enemy.burnTicks[index], ticks);
      } else if (enemy.burnSources.length < limit) {
        enemy.burnSources.push(source.sourceKey);
        enemy.burnDps.push(spec.value);
        enemy.burnTicks.push(ticks);
      } else {
        // 가득 차면 가장 약한 스택(초당 피해 → 남은 틱 → 앞 순서)을 바꾼다
        let weakest = 0;
        for (let i = 1; i < enemy.burnSources.length; i++) {
          if (
            enemy.burnDps[i] < enemy.burnDps[weakest] ||
            (enemy.burnDps[i] === enemy.burnDps[weakest] && enemy.burnTicks[i] < enemy.burnTicks[weakest])
          ) {
            weakest = i;
          }
        }
        if (spec.value >= enemy.burnDps[weakest]) {
          enemy.burnSources[weakest] = source.sourceKey;
          enemy.burnDps[weakest] = spec.value;
          enemy.burnTicks[weakest] = ticks;
        }
      }
      break;
    }
    case STATUS.POISON: {
      const cap = statValue(effects, source.subject, STAT.POISON_STACKS, spec.cap ?? 1);
      if (enemy.poisonStacks < cap) enemy.poisonStacks += 1;
      enemy.poisonTicks = spec.ticks;
      enemy.poisonDps = Math.max(enemy.poisonDps, spec.value);
      if (source.plague) enemy.plague = true;
      shown = enemy.poisonStacks;
      break;
    }
    case STATUS.SHRED: {
      const ticks = statValue(effects, source.subject, STAT.SHRED_TICKS, spec.ticks);
      enemy.shred = Math.min(SHRED_CAP_PERMILLE, enemy.shred + spec.value);
      enemy.shredTicks = Math.max(enemy.shredTicks, ticks);
      shown = enemy.shred;
      break;
    }
    case STATUS.VULNERABLE: {
      const ticks = statValue(effects, source.subject, STAT.VULNERABLE_TICKS, spec.ticks);
      const value = Math.floor((spec.value * kind.vulnerableScale) / PERMILLE);
      // 저주(폭발)는 취약 강약과 별개로 자기 지속을 갖는다 — 저주가 살아 있는 동안 사망하면 폭발
      if (source.curseExplode > 0) {
        enemy.curseExplode = Math.max(enemy.curseExplode, source.curseExplode);
        enemy.curseTicks = Math.max(enemy.curseTicks, ticks);
        enemy.afflicted = true;
      }
      if (!replaceStrongest(enemy.vulnerableTicks > 0 ? enemy.vulnerable : 0, enemy.vulnerableTicks, value, ticks)) {
        // 취약은 더 강한 것이 이미 있어도 저주는 걸렸다 — 렌더러에 알린다
        if (source.curseExplode > 0 && events) events.push(EVENT.STATUS, enemy.id, spec.status, enemy.vulnerable);
        return;
      }
      if (value > enemy.vulnerable || enemy.vulnerableTicks === 0) enemy.vulnerableTicks = ticks;
      else enemy.vulnerableTicks = Math.max(enemy.vulnerableTicks, ticks);
      enemy.vulnerable = value;
      shown = value;
      break;
    }
    default:
      return;
  }
  enemy.afflicted = true;
  if (events) events.push(EVENT.STATUS, enemy.id, spec.status, shown);
}

/**
 * 1틱 상태효과 갱신 (§E2-3) — 생성 뒤 30틱 주기마다 지속 피해(화상 = 마법 피해·저항 적용, 중독 = 고정 피해) 뒤 지속시간 감소
 * 지속 피해로 죽으면 deaths 끝에 들어간다
 */
export function tickStatuses(state: GameState, enemy: Enemy, deaths: Enemy[], events: number[] | null): void {
  if (!enemy.afflicted) return; // 상태효과가 없으면 할 일이 없다 (적마다 매 틱 부르는 경로)
  // 생성 틱 포함 30번째 갱신마다 (생성 틱에도 3단계를 거친다) — 화상·중독이 없으면 줄 피해가 없어 주기 계산도 건너뛴다
  if ((enemy.burnDps.length > 0 || enemy.poisonStacks > 0) && (state.tick - enemy.spawnTick) % DOT_INTERVAL_TICKS === DOT_INTERVAL_TICKS - 1) {
    let burn = 0;
    for (let i = 0; i < enemy.burnDps.length; i++) burn += enemy.burnDps[i];
    if (burn > 0) dealDamage(state, enemy, burn, DAMAGE.MAG, ELEMENT.FIRE, 0, deaths, events);
    if (enemy.poisonStacks > 0) dealDamage(state, enemy, enemy.poisonStacks * enemy.poisonDps, DAMAGE.PURE, ELEMENT.POISON, 0, deaths, events);
  }
  if (enemy.slowTicks > 0 && --enemy.slowTicks === 0) enemy.slow = 0;
  if (enemy.stunTicks > 0) enemy.stunTicks -= 1;
  const burnTicks = enemy.burnTicks;
  if (burnTicks.length > 0) {
    // 줄이기만 하고, 끝난 출처가 있을 때만 당겨 채운다(대부분 틱은 끝나는 것이 없다)
    let expired = false;
    for (let i = 0; i < burnTicks.length; i++) if (--burnTicks[i] <= 0) expired = true;
    if (expired) {
      let write = 0;
      for (let i = 0; i < burnTicks.length; i++) {
        if (burnTicks[i] > 0) {
          enemy.burnSources[write] = enemy.burnSources[i];
          enemy.burnDps[write] = enemy.burnDps[i];
          burnTicks[write] = burnTicks[i];
          write++;
        }
      }
      enemy.burnSources.length = write;
      enemy.burnDps.length = write;
      burnTicks.length = write;
    }
  }
  if (enemy.poisonTicks > 0 && --enemy.poisonTicks === 0) {
    enemy.poisonStacks = 0;
    enemy.poisonDps = 0;
    enemy.plague = false;
  }
  if (enemy.shredTicks > 0 && --enemy.shredTicks === 0) enemy.shred = 0;
  if (enemy.vulnerableTicks > 0 && --enemy.vulnerableTicks === 0) enemy.vulnerable = 0;
  if (enemy.curseTicks > 0 && --enemy.curseTicks === 0) enemy.curseExplode = 0;
  enemy.afflicted =
    enemy.slowTicks > 0 || enemy.stunTicks > 0 || enemy.burnSources.length > 0 ||
    enemy.poisonTicks > 0 || enemy.shredTicks > 0 || enemy.vulnerableTicks > 0 || enemy.curseTicks > 0;
}

/** 렌더 표시용 상태효과 비트 (EFFECT_BIT와 같은 순서: 감속·기절·화상·중독·파쇄·취약) */
export function statusBits(enemy: Enemy): number {
  let bits = 0;
  if (enemy.slowTicks > 0) bits += 1;
  if (enemy.stunTicks > 0) bits += 2;
  if (enemy.burnSources.length > 0) bits += 4;
  if (enemy.poisonStacks > 0) bits += 8;
  if (enemy.shredTicks > 0) bits += 16;
  if (enemy.vulnerableTicks > 0) bits += 32;
  return bits;
}

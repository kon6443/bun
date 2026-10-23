/**
 * 주간 규칙 변형 15개 (defense DESIGN §C8·§L11) — 주간 seed로 허용 조합(2~3개, 상충 표 적용) 하나를 뽑는다
 * R3(공중 2배)·R4(보스 엘리트 동반)는 웨이브 생성기(../wavegen.ts)가 적용한다
 * 원본·동기화 규칙은 ../constants.ts 머리 주석
 */

import { EFFECT_OP, FLAG, RNG_PURPOSE, SCOPE, STAT } from '../constants';
import type { Effect } from '../effects';
import { nextRandom, streamSeed } from '../random';
import { TOWER_ID, TOWERS } from './towers';
import { WEEKLY_COMBOS } from './weeklyCombos';

export const RULE_ID = {
  GALE: 1,
  STEEL_LEGION: 2,
  SKY_RAID: 3,
  ELITE_ESCORT: 4,
  MULTIPLY: 5,
  BAN: 6,
  CEILING: 7,
  NO_SELL: 8,
  NARROW: 9,
  RICH_START: 10,
  HASTE: 11,
  NO_REWARD: 12,
  GLASS_WALL: 13,
  RELENTLESS: 14,
  CARD_BOUNTY: 15,
} as const;
export const RULE_COUNT = 15;

const { MUL, ADD, SET, FLAG: FLAG_OP } = EFFECT_OP;
const enemies = (stat: number, op: number, value: number): Effect => ({ scope: SCOPE.ALL_ENEMIES, target: 0, stat, op, value });
const economy = (stat: number, op: number, value: number): Effect => ({ scope: SCOPE.ECONOMY, target: 0, stat, op, value });
const rule = (stat: number, op: number, value: number): Effect => ({ scope: SCOPE.RULES, target: 0, stat, op, value });

/** 규칙 → 효과 (bannedTower는 R6의 금지 타워 id) */
export function ruleEffects(id: number, bannedTower: number): Effect[] {
  switch (id) {
    case RULE_ID.GALE:
      return [enemies(STAT.ENEMY_SPEED, MUL, 1200)];
    case RULE_ID.STEEL_LEGION:
      return [enemies(STAT.ENEMY_HP, MUL, 1300), enemies(STAT.ENEMY_COUNT, MUL, 800)];
    case RULE_ID.SKY_RAID:
      return [rule(FLAG.AIR_DOUBLE, FLAG_OP, 0)];
    case RULE_ID.ELITE_ESCORT:
      return [rule(FLAG.BOSS_ESCORT, FLAG_OP, 0)];
    case RULE_ID.MULTIPLY:
      return [rule(FLAG.SPLIT_ON_DEATH, FLAG_OP, 100)]; // 100‰ 확률로 졸개 1 분열
    case RULE_ID.BAN:
      return [rule(FLAG.BANNED_TOWER, FLAG_OP, bannedTower)];
    case RULE_ID.CEILING:
      return [rule(STAT.MAX_LEVEL, SET, 4)];
    case RULE_ID.NO_SELL:
      return [rule(FLAG.NO_SELL, FLAG_OP, 0)];
    case RULE_ID.NARROW:
      return [rule(STAT.SLOTS_REMOVE, ADD, 2)];
    case RULE_ID.RICH_START:
      return [economy(STAT.START_GOLD, MUL, 2000), economy(STAT.KILL_GOLD, MUL, 500)];
    case RULE_ID.HASTE:
      return [economy(STAT.EARLY_CALL_BONUS, MUL, 2000)];
    case RULE_ID.NO_REWARD:
      return [economy(STAT.CLEAR_BONUS, MUL, 0), economy(STAT.KILL_GOLD, MUL, 1300)];
    case RULE_ID.GLASS_WALL:
      return [economy(STAT.LIVES, SET, 5)];
    case RULE_ID.RELENTLESS:
      return [economy(STAT.COUNTDOWN, MUL, 500)];
    case RULE_ID.CARD_BOUNTY:
      return [rule(STAT.AUGMENT_EVERY, SET, 4)];
    default:
      return [];
  }
}

/** 같이 뽑지 않는 쌍 (§C8 표) — R3·R6은 금지 타워가 대공 석궁·테슬라일 때만. 허용 목록 생성(시뮬레이터)·검사에 쓴다 */
export function conflicts(a: number, b: number, bannedTower: number): boolean {
  const pair = (x: number, y: number) => (a === x && b === y) || (a === y && b === x);
  if (pair(RULE_ID.GALE, RULE_ID.RELENTLESS)) return true;
  if (pair(RULE_ID.RICH_START, RULE_ID.NO_REWARD)) return true;
  if (pair(RULE_ID.SKY_RAID, RULE_ID.BAN)) return bannedTower === TOWER_ID.CROSSBOW || bannedTower === TOWER_ID.TESLA;
  return false;
}

export type WeeklyRules = { rules: number[]; bannedTower: number; mapIndex: number };

/** 규칙 조합 → 정수 키 (규칙 id ≤ 15 = RULE_COUNT < 16, 오름차순 2~3개 — 16진 자리) — 같은 조합끼리 묶는다 */
function rulesKey(entry: readonly number[]): number {
  let key = entry.length - 2;
  for (let i = 2; i < entry.length; i++) key = key * 16 + entry[i];
  return key;
}

/** filter를 통과한 항목들의 서로 다른 key(목록 순서) 중 하나를 고르게 */
function pickDistinct(draw: (n: number) => number, key: (entry: readonly number[]) => number, filter: (entry: readonly number[]) => boolean): number {
  const keys: number[] = [];
  for (const entry of WEEKLY_COMBOS) {
    if (!filter(entry)) continue;
    const k = key(entry);
    if (keys.indexOf(k) < 0) keys.push(k);
  }
  if (keys.length === 0) throw new Error('주간 허용 목록이 비었다');
  return keys[draw(keys.length)];
}

/** 조합 무게 단위 — 합법 금지 타워 수(4·6)로 나눠떨어지게 12 */
export const WEIGHT_UNIT = 12;

/** R6 조합의 상충 없는 금지 타워 수 */
export function legalBans(entry: readonly number[]): number {
  let count = 0;
  for (let banned = 0; banned < TOWERS.length; banned++) {
    let ok = true;
    for (let i = 2; i < entry.length; i++) for (let j = i + 1; j < entry.length; j++) if (conflicts(entry[i], entry[j], banned)) ok = false;
    if (ok) count++;
  }
  return Math.max(1, count);
}

/**
 * 주간 seed → 맵 → 규칙 수 → 규칙 조합 → 금지 타워를 차례로 고르게 뽑는다(아래). 같은 seed면 누구나 같은 결과(서버·클라이언트 같은 함수)
 * 항목은 시뮬레이터가 (맵, 조합)마다 걸러 둔 허용 목록(weeklyCombos.ts — 그 맵에서 기준 봇 붕괴 웨이브가 무규칙 대비 대역 안)에서만 고른다(§S5)
 */
export function pickWeekly(seed: number): WeeklyRules {
  let rng = streamSeed(seed, RNG_PURPOSE.WEEKLY);
  const draw = (n: number) => {
    const [next, value] = nextRandom(rng);
    rng = next;
    return value % n;
  };
  // 단계마다 고르게 — 허용 항목 수에 끌리지 않게
  // 1) 맵(허용 항목이 있는 맵 중) 2) 규칙 수 2·3(그 맵에 있는 것 중)
  // 3) 규칙 조합 — R6 조합은 상충 없는 금지 타워 변형 중 통과한 비율만큼의 무게(아무 변형 하나만 통과해도 남아 R6이 부풀지 않게)
  // 4) 금지 타워(R6이면 통과한 것 중)
  const mapIndex = pickDistinct(draw, (entry) => entry[0], () => true);
  const size = pickDistinct(draw, (entry) => entry.length - 2, (entry) => entry[0] === mapIndex);
  const keys: number[] = [];
  const weights: number[] = [];
  let total = 0;
  for (const entry of WEEKLY_COMBOS) {
    if (entry[0] !== mapIndex || entry.length - 2 !== size) continue;
    const key = rulesKey(entry);
    let i = keys.indexOf(key);
    if (i < 0) {
      keys.push(key);
      weights.push(0);
      i = keys.length - 1;
    }
    // 통과 비율만큼의 무게 — R6 없는 조합 = WEIGHT_UNIT, R6 변형 하나 = WEIGHT_UNIT / (상충 없는 금지 타워 수)
    // (R3+R6은 금지 타워가 석궁·테슬라면 상충이라 합법 변형이 4개 — 6으로 나누면 구조적으로 덜 뽑힌다)
    const weight = entry[1] > 0 ? Math.floor(WEIGHT_UNIT / legalBans(entry)) : WEIGHT_UNIT;
    weights[i] += weight;
    total += weight;
  }
  let roll = draw(total);
  let chosen = 0;
  for (; chosen < keys.length - 1; chosen++) {
    if (roll < weights[chosen]) break;
    roll -= weights[chosen];
  }
  const inCombo = (entry: readonly number[]) => entry[0] === mapIndex && rulesKey(entry) === keys[chosen];
  const bannedPlusOne = pickDistinct(draw, (entry) => entry[1], inCombo);
  let combo: readonly number[] = WEEKLY_COMBOS[0];
  for (const entry of WEEKLY_COMBOS) {
    if (inCombo(entry)) {
      combo = entry;
      break;
    }
  }
  const rules: number[] = [];
  for (let i = 2; i < combo.length; i++) rules.push(combo[i]);
  return { rules, bannedTower: bannedPlusOne - 1, mapIndex };
}

/** 주간 보드 키 형식 — weekly-YYYY-wNN (ISO 주차, 01~53) */
export function isWeeklyBoardKey(key: string): boolean {
  if (key.length !== 15 || key.slice(0, 7) !== 'weekly-' || key.charAt(11) !== '-' || key.charAt(12) !== 'w') return false;
  const digits = key.slice(7, 11) + key.slice(13, 15);
  for (let i = 0; i < digits.length; i++) if (digits.charCodeAt(i) < 48 || digits.charCodeAt(i) > 57) return false;
  const week = (digits.charCodeAt(4) - 48) * 10 + (digits.charCodeAt(5) - 48);
  return week >= 1 && week <= 53;
}

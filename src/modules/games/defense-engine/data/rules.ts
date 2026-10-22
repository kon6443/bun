/**
 * 주간 규칙 변형 15개 (defense DESIGN §C8·§L11) — 주간 seed로 2~3개를 뽑는다(상충 표 적용)
 * R3(공중 비율 2배)·R4(보스 웨이브 정예 동반)는 웨이브 생성 단계 규칙이라 엔진은 플래그만 단다(적용은 S1 생성기)
 * 조합별 기준 봇 붕괴 웨이브 ±30% 밖 조합을 거르는 허용 목록(weeklyCombos)도 S1
 * 원본·동기화 규칙은 ../constants.ts 머리 주석
 */

import { EFFECT_OP, FLAG, RNG_PURPOSE, SCOPE, STAT } from '../constants';
import type { Effect } from '../effects';
import { nextRandom, streamSeed } from '../random';
import { TOWER_ID, TOWERS } from './towers';

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

/** 같이 뽑지 않는 쌍 (§C8 표) — R3·R6은 금지 타워가 대공 석궁·테슬라일 때만 */
function conflicts(a: number, b: number, bannedTower: number): boolean {
  const pair = (x: number, y: number) => (a === x && b === y) || (a === y && b === x);
  if (pair(RULE_ID.GALE, RULE_ID.RELENTLESS)) return true;
  if (pair(RULE_ID.RICH_START, RULE_ID.NO_REWARD)) return true;
  if (pair(RULE_ID.SKY_RAID, RULE_ID.BAN)) return bannedTower === TOWER_ID.CROSSBOW || bannedTower === TOWER_ID.TESLA;
  return false;
}

export type WeeklyRules = { rules: number[]; bannedTower: number };

/**
 * 주간 seed → 규칙 2~3개(뽑은 순서) + R6 금지 타워. 같은 seed면 누구나 같은 결과(서버·클라이언트 같은 함수)
 * 상충하면 그 후보를 버리고 다음 후보 — 15개를 다 봐도 못 채우면 채운 만큼
 */
export function pickWeeklyRules(seed: number): WeeklyRules {
  let rng = streamSeed(seed, RNG_PURPOSE.WEEKLY);
  const draw = (n: number) => {
    const [next, value] = nextRandom(rng);
    rng = next;
    return value % n;
  };
  const want = 2 + draw(2);
  const bannedTower = draw(TOWERS.length);
  const remaining: number[] = [];
  for (let id = 1; id <= RULE_COUNT; id++) remaining.push(id);
  const rules: number[] = [];
  while (rules.length < want && remaining.length > 0) {
    const index = draw(remaining.length);
    const candidate = remaining[index];
    remaining.splice(index, 1);
    let ok = true;
    for (const chosen of rules) if (conflicts(candidate, chosen, bannedTower)) ok = false;
    if (ok) rules.push(candidate);
  }
  return { rules, bannedTower: rules.indexOf(RULE_ID.BAN) >= 0 ? bannedTower : -1 };
}

/** 주간 보드 키 형식 — weekly-YYYY-wNN (ISO 주차, 01~53) */
export function isWeeklyBoardKey(key: string): boolean {
  if (key.length !== 15 || key.slice(0, 7) !== 'weekly-' || key.charAt(11) !== '-' || key.charAt(12) !== 'w') return false;
  const digits = key.slice(7, 11) + key.slice(13, 15);
  for (let i = 0; i < digits.length; i++) if (digits.charCodeAt(i) < 48 || digits.charCodeAt(i) > 57) return false;
  const week = (digits.charCodeAt(4) - 48) * 10 + (digits.charCodeAt(5) - 48);
  return week >= 1 && week <= 53;
}

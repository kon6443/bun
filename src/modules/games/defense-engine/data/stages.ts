/**
 * 스테이지·보드 데이터 — 캠페인 8스테이지(§L2, 난이도 3모드 §L5) · 무한 보드(§L6) · 주간 보드(§L11)
 *   + 시험 스테이지 E1(궁수탑·졸개)·E2 아레나(타워 6·적 11·증강·다중 경로)
 * 캠페인 웨이브는 시뮬레이터가 만든 정수 데이터(waves.ts) · 무한·주간 웨이브는 판 시작 때 seed로 생성(../wavegen.ts)
 * 원본·동기화 규칙은 ../constants.ts 머리 주석
 */

import {
  AUGMENT_EVERY_DEFAULT,
  EFFECT_OP,
  ENDLESS_START_GOLD,
  KILL_REWARD_G_CAMPAIGN,
  KILL_REWARD_G_ENDLESS,
  RNG_PURPOSE,
  SCOPE,
  STAT,
} from '../constants';
import type { Effect } from '../effects';
import { streamSeed } from '../random';
import { DESIGNED_WAVES, generateEndlessWaves } from '../wavegen';
import { ENEMY_ID } from './enemies';
import { type GameMap, MAP_E1, MAP_E2, MAP_ENDLESS, MAP_S1, MAP_S2, MAP_S3, MAP_S4, MAP_S5, MAP_S6, MAP_S7, MAP_S8 } from './maps';
import { RULE_ID, isWeeklyBoardKey, pickWeekly } from './rules';
import { TOWER_ID } from './towers';
import { CAMPAIGN_WAVES, ENDLESS_DESIGNED_PRESSURE, ENDLESS_RAMP_PERMILLE } from './waves';

export type WaveGroup = {
  enemyId: number;
  /** 스폰 횟수 (박쥐 떼는 한 번에 swarm마리) */
  count: number;
  /** 같은 그룹 안 스폰 간격 (틱) */
  intervalTicks: number;
  /** 웨이브 시작부터 첫 스폰까지 (틱) */
  delayTicks: number;
  /** 한 마리 HP (정수) */
  hp: number;
  /** 경로 인덱스 — 지상 적은 지상 경로, 공중 적은 공중 경로(없으면 지상) */
  path: number;
};

export type Wave = { groups: readonly WaveGroup[] };

export type Stage = {
  id: string;
  map: GameMap;
  startGold: number;
  lives: number;
  /** 쓸 수 있는 타워 id */
  towers: readonly number[];
  /** 업그레이드 상한 레벨 (3 = 분기 전, 5 = 궁극까지) */
  maxLevel: number;
  /** 킬 보상 G (골드 per 1000 EHP) */
  rewardG: number;
  /** 증강 제시 주기(웨이브) — 0이면 증강 없음(캠페인) */
  augmentEvery: number;
  /** 무한 모드 보장 규칙(보유 타워 관련 1장) — 주간은 끈다(§E1) */
  augmentGuarantee: boolean;
  /** 주간 규칙 변형 (시험 스테이지는 고정, 주간 보드는 seed로 뽑는다) */
  rules: readonly number[];
  /** R6 금지 타워 (없으면 −1) */
  bannedTower: number;
  /** 판 시작 효과 — 캠페인 난이도(적 HP‰·타워 비용‰, §L5). 규칙 변형 효과 뒤에 붙는다 */
  effects: readonly Effect[];
  /** 이 웨이브 이후는 램프 — 킬 보상 감쇠 300‰ (0 = 없음, 무한·주간 30) */
  rampFrom: number;
  /** 난이도 적 HP ‰ (보통 1000) — 웨이브 스폰 HP에 곱한다(효과가 아니다). 킬 보상 기준 HP에는 넣지 않는다 */
  difficultyHp: number;
  waves: readonly Wave[];
};

const ALL_TOWERS = [TOWER_ID.ARCHER, TOWER_ID.CANNON, TOWER_ID.MAGE, TOWER_ID.FROST, TOWER_ID.CROSSBOW, TOWER_ID.TESLA];
const g = (enemyId: number, count: number, intervalTicks: number, delayTicks: number, hp: number, path = 0): WaveGroup => ({
  enemyId, count, intervalTicks, delayTicks, hp, path,
});

/** §L3 S1-1(단위 EHP 14 · 15마리 · 24틱) 근처 값으로 손작성 — 기본 · 기본+ · 러시 · 기본+ */
export const STAGE_E1: Stage = {
  id: 'e1',
  map: MAP_E1,
  startGold: 220,
  lives: 20,
  towers: [TOWER_ID.ARCHER],
  maxLevel: 3,
  rewardG: KILL_REWARD_G_CAMPAIGN,
  augmentEvery: 0,
  augmentGuarantee: false,
  rules: [],
  bannedTower: -1,
  effects: [],
  rampFrom: 0,
  difficultyHp: 1000,
  waves: [
    { groups: [g(ENEMY_ID.GRUNT, 15, 24, 0, 14)] },
    { groups: [g(ENEMY_ID.GRUNT, 18, 21, 0, 18)] },
    { groups: [g(ENEMY_ID.GRUNT, 30, 10, 0, 10)] },
    { groups: [g(ENEMY_ID.GRUNT, 12, 24, 0, 24), g(ENEMY_ID.GRUNT, 8, 30, 120, 32)] },
  ],
};

const E2_WAVES: readonly Wave[] = [
  { groups: [g(ENEMY_ID.GRUNT, 6, 24, 0, 30, 0), g(ENEMY_ID.RUNNER, 4, 30, 30, 25, 1)] },
  { groups: [g(ENEMY_ID.SHIELD, 4, 30, 0, 60, 0), g(ENEMY_ID.SPLITTER, 3, 40, 20, 50, 1)] },
  { groups: [g(ENEMY_ID.BATS, 3, 45, 0, 12, 0), g(ENEMY_ID.GHOST, 3, 30, 30, 50, 0)] },
  { groups: [g(ENEMY_ID.PRIEST, 2, 60, 0, 60, 1), g(ENEMY_ID.GRUNT, 6, 20, 10, 40, 1), g(ENEMY_ID.WYVERN, 2, 60, 60, 80, 0)] },
  { groups: [g(ENEMY_ID.GIANT, 1, 1, 0, 900, 0), g(ENEMY_ID.SUMMONER, 1, 1, 60, 1500, 1)] },
  { groups: [g(ENEMY_ID.DRAGON, 1, 1, 0, 3000, 0), g(ENEMY_ID.BATS, 2, 90, 120, 20, 0)] },
];

/** E2 시험 아레나 — 6웨이브로 적 11종 전부, 타워 6종·Lv5, 증강 2웨이브마다(보장 규칙 켬) */
export const STAGE_E2: Stage = {
  id: 'e2',
  map: MAP_E2,
  startGold: 1500,
  lives: 20,
  towers: ALL_TOWERS,
  maxLevel: 5,
  rewardG: KILL_REWARD_G_CAMPAIGN,
  augmentEvery: 2,
  augmentGuarantee: true,
  rules: [],
  bannedTower: -1,
  effects: [],
  rampFrom: 0,
  difficultyHp: 1000,
  waves: E2_WAVES,
};

/** E2 규칙 시험 아레나 — 주간 규칙 변형을 고정으로 건다(증식·금지(테슬라)·천장·부자 출발·쉼 없음·카드 풍년), 보장 규칙 끔 */
export const STAGE_E2_RULES: Stage = {
  ...STAGE_E2,
  id: 'e2-rules',
  augmentEvery: AUGMENT_EVERY_DEFAULT,
  augmentGuarantee: false,
  rules: [RULE_ID.MULTIPLY, RULE_ID.BAN, RULE_ID.CEILING, RULE_ID.RICH_START, RULE_ID.RELENTLESS, RULE_ID.CARD_BOUNTY],
  bannedTower: TOWER_ID.TESLA,
};

// ==================== 캠페인 8스테이지 (§L2) ====================

type CampaignDef = { map: GameMap; startGold: number; towers: readonly number[]; maxLevel: number };

const T = TOWER_ID;
/** 스테이지마다 새 타워 1종 — 해금 순서(§L2). 업그레이드 상한 S1 Lv3 · S2~S4 Lv4 · S5~ Lv5 */
const CAMPAIGN_DEFS: readonly CampaignDef[] = [
  { map: MAP_S1, startGold: 220, towers: [T.ARCHER, T.CANNON], maxLevel: 3 },
  { map: MAP_S2, startGold: 260, towers: [T.ARCHER, T.CANNON, T.MAGE], maxLevel: 4 },
  { map: MAP_S3, startGold: 300, towers: [T.ARCHER, T.CANNON, T.MAGE, T.FROST], maxLevel: 4 },
  { map: MAP_S4, startGold: 340, towers: [T.ARCHER, T.CANNON, T.MAGE, T.FROST, T.CROSSBOW], maxLevel: 4 },
  { map: MAP_S5, startGold: 380, towers: [T.ARCHER, T.CANNON, T.MAGE, T.FROST, T.CROSSBOW], maxLevel: 5 },
  { map: MAP_S6, startGold: 420, towers: ALL_TOWERS, maxLevel: 5 },
  { map: MAP_S7, startGold: 460, towers: ALL_TOWERS, maxLevel: 5 },
  { map: MAP_S8, startGold: 500, towers: ALL_TOWERS, maxLevel: 5 },
];

/** 캠페인 스테이지 (보통 난이도) — id 's1' ~ 's8' */
export const CAMPAIGN_STAGES: readonly Stage[] = CAMPAIGN_DEFS.map((def, i) => ({
  id: `s${i + 1}`,
  map: def.map,
  startGold: def.startGold,
  lives: 20,
  towers: def.towers,
  maxLevel: def.maxLevel,
  rewardG: KILL_REWARD_G_CAMPAIGN,
  augmentEvery: 0,
  augmentGuarantee: false,
  rules: [],
  bannedTower: -1,
  effects: [],
  rampFrom: 0,
  difficultyHp: 1000,
  waves: CAMPAIGN_WAVES[i],
}));

/** 난이도 모드 (§L5) — 적 HP‰ · 타워 비용‰. 보드 키 접미사 '-easy'·'-hard' (보통은 접미사 없음) */
export const DIFFICULTY = { EASY: 'easy', NORMAL: 'normal', HARD: 'hard' } as const;
/** 적 HP 배율은 스폰 때 따로 곱하고(game.ts) 킬 보상 기준 HP에서는 뺀다 — 모드가 보상을 바꾸지 않는다 */
const DIFFICULTY_PERMILLE: readonly { suffix: string; hp: number; cost: number }[] = [
  { suffix: '-easy', hp: 800, cost: 850 },
  { suffix: '-hard', hp: 1200, cost: 1080 },
];

function difficultyEffects(cost: number): Effect[] {
  return [{ scope: SCOPE.ALL_TOWERS, target: 0, stat: STAT.COST, op: EFFECT_OP.MUL, value: cost }];
}

/** 캠페인 boardKey(스테이지 id) → 스테이지. 목록 순서 = 검색 순서 */
export const STAGES: readonly Stage[] = [STAGE_E1, STAGE_E2, STAGE_E2_RULES, ...CAMPAIGN_STAGES];

/** 스테이지 id → 스테이지 — 캠페인은 난이도 접미사('s3-hard')도 받는다 */
export function findStage(id: string): Stage | null {
  for (let i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return STAGES[i];
  for (const mode of DIFFICULTY_PERMILLE) {
    if (id.length <= mode.suffix.length || id.slice(id.length - mode.suffix.length) !== mode.suffix) continue;
    const base = id.slice(0, id.length - mode.suffix.length);
    for (const stage of CAMPAIGN_STAGES) {
      if (stage.id === base) return { ...stage, id, effects: difficultyEffects(mode.cost), difficultyHp: mode.hp };
    }
  }
  return null;
}

// ==================== 무한·주간 (§L6·§L11) ====================

/** 무한 보드 키 (시즌, D-014) */
export const ENDLESS_BOARD_KEYS: readonly string[] = ['endless-s1'];

/** 주간 맵 풀 — 캠페인 8 + 무한 (§L11) */
export const WEEKLY_MAPS: readonly GameMap[] = [MAP_S1, MAP_S2, MAP_S3, MAP_S4, MAP_S5, MAP_S6, MAP_S7, MAP_S8, MAP_ENDLESS];

/** 무한 규칙 보드 — 맵·규칙 변형·보장 규칙을 지정해 만든다(무한·주간 공통, 시뮬레이터 주간 조합 평가도 이것으로) */
export function endlessBoard(id: string, map: GameMap, seed: number, rules: readonly number[], bannedTower: number, guarantee: boolean): Stage {
  const options = {
    groundPaths: map.groundPaths.length,
    hasAirPath: map.airPaths.length > 0,
    airDouble: rules.indexOf(RULE_ID.SKY_RAID) >= 0,
    bossEscort: rules.indexOf(RULE_ID.ELITE_ESCORT) >= 0,
  };
  return {
    id,
    map,
    startGold: ENDLESS_START_GOLD,
    lives: 20,
    towers: ALL_TOWERS,
    maxLevel: 5,
    rewardG: KILL_REWARD_G_ENDLESS,
    augmentEvery: AUGMENT_EVERY_DEFAULT,
    augmentGuarantee: guarantee,
    rules,
    bannedTower,
    effects: [],
    rampFrom: DESIGNED_WAVES,
    difficultyHp: 1000,
    waves: generateEndlessWaves(ENDLESS_DESIGNED_PRESSURE, ENDLESS_RAMP_PERMILLE, options, { state: streamSeed(seed, RNG_PURPOSE.WAVE) }),
  };
}

/** 무한 보드 — 전용 맵·보장 규칙 켬, 웨이브 구성은 seed */
export function endlessStage(boardKey: string, seed: number): Stage {
  return endlessBoard(boardKey, MAP_ENDLESS, seed, [], -1, true);
}

/** 주간 보드 — 주간 seed로 허용 조합(규칙 2~3개·금지 타워)과 맵을 뽑는다. 보장 규칙 끔(전원 같은 후보, §E1) */
export function weeklyStage(boardKey: string, seed: number): Stage {
  const weekly = pickWeekly(seed);
  return endlessBoard(boardKey, WEEKLY_MAPS[weekly.mapIndex], seed, weekly.rules, weekly.bannedTower, false);
}

/**
 * 헤더(mode·boardKey·seed) → 스테이지 — 해석할 수 없으면 null(INVALID_HEADER)
 * 캠페인: boardKey = 스테이지 id(+ 난이도 접미사) · 무한: 'endless-s1' · 주간: 'weekly-YYYY-wNN'
 */
export function resolveBoard(mode: string, boardKey: string, seed: number): Stage | null {
  if (mode === 'campaign') return findStage(boardKey);
  if (mode === 'endless') return ENDLESS_BOARD_KEYS.indexOf(boardKey) >= 0 ? endlessStage(boardKey, seed) : null;
  if (mode === 'weekly') return isWeeklyBoardKey(boardKey) ? weeklyStage(boardKey, seed) : null;
  return null;
}

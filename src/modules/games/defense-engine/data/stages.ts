/**
 * 스테이지·보드 데이터 — E1 시험 스테이지(궁수탑·졸개) + E2 시험 아레나(타워 6·적 11·증강·다중 경로)
 * 캠페인 8스테이지·무한 맵·주간 맵 풀·웨이브 생성기는 S1 — 그 전까지 무한·주간 보드는 해석되지 않는다(INVALID_HEADER)
 * 원본·동기화 규칙은 ../constants.ts 머리 주석
 */

import { AUGMENT_EVERY_DEFAULT, KILL_REWARD_G_CAMPAIGN } from '../constants';
import { ENEMY_ID } from './enemies';
import { type GameMap, MAP_E1, MAP_E2 } from './maps';
import { RULE_ID } from './rules';
import { TOWER_ID } from './towers';

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

/** 캠페인 boardKey(스테이지 id) → 스테이지. 목록 순서 = 검색 순서 */
export const STAGES: readonly Stage[] = [STAGE_E1, STAGE_E2, STAGE_E2_RULES];

export function findStage(id: string): Stage | null {
  for (let i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return STAGES[i];
  return null;
}

/** 무한 보드 키 (시즌, D-014) */
export const ENDLESS_BOARD_KEYS: readonly string[] = ['endless-s1'];

/**
 * 헤더(mode·boardKey·seed) → 스테이지 — 해석할 수 없으면 null(INVALID_HEADER)
 * 캠페인: boardKey = 스테이지 id · 무한·주간: 키 형식은 검사하지만 맵·웨이브 데이터(S1) 전까지 null
 */
export function resolveBoard(mode: string, boardKey: string): Stage | null {
  if (mode === 'campaign') return findStage(boardKey);
  // 무한(ENDLESS_BOARD_KEYS)·주간(isWeeklyBoardKey, 맵 = seed로 풀에서, 규칙 = pickWeeklyRules)은 S1에서 맵·웨이브를 붙인다
  return null;
}

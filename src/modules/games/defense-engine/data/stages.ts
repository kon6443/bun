/**
 * 스테이지 데이터 — E1은 S1 축소판 시험 스테이지 1개(손작성 4웨이브). 웨이브 생성기·캠페인 8스테이지는 S1 슬라이스
 * 원본·동기화 규칙은 ../constants.ts 머리 주석
 */

import { KILL_REWARD_G_CAMPAIGN } from '../constants';
import { ENEMY_ID } from './enemies';
import { type GameMap, MAP_E1 } from './maps';
import { TOWER_ID } from './towers';

export type WaveGroup = {
  enemyId: number;
  count: number;
  /** 같은 그룹 안 스폰 간격 (틱) */
  intervalTicks: number;
  /** 웨이브 시작부터 첫 스폰까지 (틱) */
  delayTicks: number;
  /** 한 마리 HP (정수) */
  hp: number;
  /** 지상 경로 인덱스 */
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
  /** 업그레이드 상한 레벨 */
  maxLevel: number;
  /** 킬 보상 G (골드 per 1000 EHP) */
  rewardG: number;
  waves: readonly Wave[];
};

/** §L3 S1-1(단위 EHP 14 · 15마리 · 24틱) 근처 값으로 손작성 — 기본 · 기본+ · 러시 · 기본+ */
export const STAGE_E1: Stage = {
  id: 'e1',
  map: MAP_E1,
  startGold: 220,
  lives: 20,
  towers: [TOWER_ID.ARCHER],
  maxLevel: 3,
  rewardG: KILL_REWARD_G_CAMPAIGN,
  waves: [
    { groups: [{ enemyId: ENEMY_ID.GRUNT, count: 15, intervalTicks: 24, delayTicks: 0, hp: 14, path: 0 }] },
    { groups: [{ enemyId: ENEMY_ID.GRUNT, count: 18, intervalTicks: 21, delayTicks: 0, hp: 18, path: 0 }] },
    { groups: [{ enemyId: ENEMY_ID.GRUNT, count: 30, intervalTicks: 10, delayTicks: 0, hp: 10, path: 0 }] },
    {
      groups: [
        { enemyId: ENEMY_ID.GRUNT, count: 12, intervalTicks: 24, delayTicks: 0, hp: 24, path: 0 },
        { enemyId: ENEMY_ID.GRUNT, count: 8, intervalTicks: 30, delayTicks: 120, hp: 32, path: 0 },
      ],
    },
  ],
};

/** boardKey(캠페인은 스테이지 id) → 스테이지. 목록 순서 = 검색 순서 */
export const STAGES: readonly Stage[] = [STAGE_E1];

export function findStage(id: string): Stage | null {
  for (let i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return STAGES[i];
  return null;
}

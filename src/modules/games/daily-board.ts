import { createHmac } from 'node:crypto';
import { rankingPeriodStart } from './ranking-period';

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 데일리 보드 키 — `daily-YYYY-MM-DD`(KST 날짜). 0 채움 고정 폭이라 문자열 비교 = 시간 순서 */
export const DAILY_BOARD_PATTERN = /^daily-\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** 데일리 보드 — 오늘(KST 00:00 ~ 다음 날 00:00)의 보드 키와 기간 (docs/tasks/games-growth D-004) */
export interface DailyBoard {
  boardKey: string;
  startsAt: Date;
  endsAt: Date;
}

/** 시각이 속한 KST 날짜 `YYYY-MM-DD` — 데일리 보드 키·조회 집계 날짜(GAME_REPLAY_VIEW_STATS.STAT_DATE)에 쓴다 */
export function kstDateOf(instant: Date): string {
  return new Date(instant.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** now가 속한 KST 날짜의 데일리 보드. 하루 경계는 일간 랭킹(ranking-period.ts)과 같다 */
export function dailyBoardAt(now: Date): DailyBoard {
  const startsAt = rankingPeriodStart('daily', now)!;
  return { boardKey: `daily-${kstDateOf(startsAt)}`, startsAt, endsAt: new Date(startsAt.getTime() + DAY_MS) };
}

/**
 * 데일리 보드의 seed — 같은 날에는 누구에게나 같은 값(전원 동일 판).
 * 서버 비밀값을 섞어 내일 seed를 미리 계산하지 못하게 한다. 디펜스 주간과 비밀값을 함께 쓰므로 접두로 용도를 나눈다
 */
export function dailySeed(secret: string, boardKey: string): number {
  return createHmac('sha256', secret).update(`tetris-daily:${boardKey}`).digest().readUInt32BE(0);
}

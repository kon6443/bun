import { createHmac } from 'node:crypto';
import { rankingPeriodStart } from './ranking-period';

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 주간 보드 — 이번 주(KST 월요일 00:00 ~ 다음 월요일 00:00)의 보드 키와 기간 (docs/tasks/defense DESIGN §L11·§B3) */
export interface WeeklyBoard {
  /** `weekly-{ISO 주 연도}-w{주차 2자리}` — 예: weekly-2026-w43 */
  boardKey: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * now가 속한 KST 주의 주간 보드.
 * 주 경계는 일간·주간 랭킹(ranking-period.ts)과 같은 KST 월요일 00:00이고, 주차 번호는 ISO 8601(목요일이 속한 해) 규칙이다.
 */
export function weeklyBoardAt(now: Date): WeeklyBoard {
  const startsAt = rankingPeriodStart('weekly', now)!;
  // ISO 주차: 그 주 목요일(월요일 + 3일)의 KST 날짜가 속한 해·그 해 첫 목요일부터의 주 수
  const thursdayKst = new Date(startsAt.getTime() + KST_OFFSET_MS + 3 * DAY_MS);
  const isoYear = thursdayKst.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((thursdayKst.getTime() - jan1) / DAY_MS / 7) + 1;
  return {
    boardKey: `weekly-${isoYear}-w${String(week).padStart(2, '0')}`,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7 * DAY_MS),
  };
}

/**
 * 주간 보드의 seed — 같은 주에는 누구에게나 같은 값(전원 동일 판, DESIGN §L11).
 * 서버 비밀값을 섞어 다음 주 seed를 미리 계산하지 못하게 한다. HMAC-SHA256 앞 4바이트 = 0 ~ 2^32−1
 */
export function weeklySeed(secret: string, boardKey: string): number {
  return createHmac('sha256', secret).update(`defense-weekly:${boardKey}`).digest().readUInt32BE(0);
}

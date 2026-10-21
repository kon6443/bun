import type { RankingPeriod } from './games.dto';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 랭킹 기간 시작 시각(UTC Date) — 일간은 KST 오늘 00:00, 주간은 KST 이번 주 월요일 00:00, 전체는 null (D-004).
 *
 * 저장은 UTC이고 경계 계산에서만 KST로 본다(datetime.md). KST는 서머타임이 없어 고정 오프셋으로 충분하다.
 */
export function rankingPeriodStart(period: RankingPeriod, now: Date = new Date()): Date | null {
  if (period === 'all') {
    return null;
  }
  // KST 벽시계를 UTC 축 위에 옮겨 놓고 자정으로 내린다
  const kstDayStart = Math.floor((now.getTime() + KST_OFFSET_MS) / DAY_MS) * DAY_MS;
  if (period === 'daily') {
    return new Date(kstDayStart - KST_OFFSET_MS);
  }
  // getUTCDay: 0 = 일요일 → 월요일부터 지난 일수
  const daysSinceMonday = (new Date(kstDayStart).getUTCDay() + 6) % 7;
  return new Date(kstDayStart - daysSinceMonday * DAY_MS - KST_OFFSET_MS);
}

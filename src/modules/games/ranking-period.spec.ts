import { rankingPeriodStart } from './ranking-period';

/**
 * 랭킹 기간 경계 (D-004) — 저장은 UTC, 경계는 KST 자정·월요일 자정.
 * 경계 바로 앞뒤(UTC 15:00 = KST 다음날 00:00)와 요일 넘어가는 지점을 고정한다.
 */
describe('rankingPeriodStart', () => {
  it('all이면 null', () => {
    expect(rankingPeriodStart('all', new Date('2026-10-21T05:00:00.000Z'))).toBeNull();
  });

  it.each([
    ['KST 수요일 14:00', '2026-10-21T05:00:00.000Z', '2026-10-20T15:00:00.000Z'],
    ['KST 수요일 00:00 정각', '2026-10-20T15:00:00.000Z', '2026-10-20T15:00:00.000Z'],
    ['KST 화요일 23:59:59.999 (UTC로는 같은 날)', '2026-10-20T14:59:59.999Z', '2026-10-19T15:00:00.000Z'],
  ])('daily: %s → KST 그날 00:00', (_name, now, expected) => {
    expect(rankingPeriodStart('daily', new Date(now))?.toISOString()).toBe(expected);
  });

  it.each([
    ['KST 수요일', '2026-10-21T05:00:00.000Z', '2026-10-18T15:00:00.000Z'],
    ['KST 월요일 00:00 정각', '2026-10-18T15:00:00.000Z', '2026-10-18T15:00:00.000Z'],
    ['KST 일요일 23:59 (지난주)', '2026-10-18T14:59:00.000Z', '2026-10-11T15:00:00.000Z'],
    ['KST 월요일 08:00 (UTC로는 일요일)', '2026-10-18T23:00:00.000Z', '2026-10-18T15:00:00.000Z'],
  ])('weekly: %s → KST 그 주 월요일 00:00', (_name, now, expected) => {
    expect(rankingPeriodStart('weekly', new Date(now))?.toISOString()).toBe(expected);
  });
});

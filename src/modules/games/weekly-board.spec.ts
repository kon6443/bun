import { createHmac } from 'node:crypto';
import { weeklyBoardAt, weeklySeed } from './weekly-board';

/**
 * 주간 보드 키·기간·seed (docs/tasks/defense DESIGN §L11·§B3).
 * 주 경계는 KST 월요일 00:00(주간 랭킹과 같음), 주차 번호는 ISO 8601 — 연말·연초 경계를 고정한다.
 */
describe('weeklyBoardAt', () => {
  it.each([
    ['수요일 낮', '2026-10-21T03:00:00.000Z', 'weekly-2026-w43'],
    ['일요일 23:59 KST (주의 마지막)', '2026-10-25T14:59:59.999Z', 'weekly-2026-w43'],
    ['월요일 00:00 KST (다음 주 시작)', '2026-10-25T15:00:00.000Z', 'weekly-2026-w44'],
    ['UTC로는 일요일이지만 KST 월요일 오전', '2026-10-25T23:00:00.000Z', 'weekly-2026-w44'],
    ['12월 31일(목) — 53주가 있는 해', '2026-12-31T03:00:00.000Z', 'weekly-2026-w53'],
    ['1월 1일(금) — 전년도 53주에 속함', '2027-01-01T03:00:00.000Z', 'weekly-2026-w53'],
    ['1월 4일(월) — 새해 1주', '2027-01-04T03:00:00.000Z', 'weekly-2027-w01'],
    ['12월 29일(월) — 다음 해 1주에 속함', '2025-12-29T03:00:00.000Z', 'weekly-2026-w01'],
    ['윤년 12월 31일(목) — 53주', '2020-12-31T03:00:00.000Z', 'weekly-2020-w53'],
    ['윤년 12월 30일(월) — 다음 해 1주', '2024-12-30T03:00:00.000Z', 'weekly-2025-w01'],
  ])('%s → %s', (_name, iso, expected) => {
    expect(weeklyBoardAt(new Date(iso)).boardKey).toBe(expected);
  });

  it('기간은 KST 월요일 00:00부터 7일 — UTC로 일요일 15:00', () => {
    const board = weeklyBoardAt(new Date('2026-10-21T03:00:00.000Z'));

    expect(board.startsAt).toEqual(new Date('2026-10-18T15:00:00.000Z'));
    expect(board.endsAt).toEqual(new Date('2026-10-25T15:00:00.000Z'));
  });

  it('보드 키는 DB CHECK 형식(소문자·숫자·하이픈 1~40자)을 지켜야 함', () => {
    expect(weeklyBoardAt(new Date('2026-10-21T03:00:00.000Z')).boardKey).toMatch(/^[a-z0-9-]{1,40}$/);
  });
});

describe('weeklySeed', () => {
  it('같은 비밀값·주에는 같은 seed, 주가 다르면 다른 seed — 0 ~ 2^32−1 정수', () => {
    const a = weeklySeed('secret', 'weekly-2026-w43');

    expect(weeklySeed('secret', 'weekly-2026-w43')).toBe(a);
    expect(weeklySeed('secret', 'weekly-2026-w44')).not.toBe(a);
    expect(weeklySeed('other', 'weekly-2026-w43')).not.toBe(a);
    expect(Number.isInteger(a) && a >= 0 && a < 2 ** 32).toBe(true);
  });

  it('HMAC-SHA256(비밀값, "defense-weekly:" + 보드 키)의 앞 4바이트(빅엔디언)', () => {
    const expected = createHmac('sha256', 'secret').update('defense-weekly:weekly-2026-w43').digest().readUInt32BE(0);

    expect(weeklySeed('secret', 'weekly-2026-w43')).toBe(expected);
  });
});

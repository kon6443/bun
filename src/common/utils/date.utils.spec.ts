import { formatDateRange, formatDateTime } from './date.utils';

describe('formatDateTime', () => {
  it('UTC 저장값을 KST로 변환해 표시해야 함', () => {
    expect(formatDateTime(new Date('2026-03-27T05:00:00Z'))).toBe('2026. 03. 27. 14:00');
  });

  // 구버전 엔진(Node 20 이하)에서만 "24:xx"가 재현된다 — Node 22 이상에서는 수정 전 코드로도 통과하므로
  // 회귀 확인은 구버전 Node로 돌린다: PATH=<node18 bin>:$PATH node node_modules/jest/bin/jest.js --testPathPatterns date.utils
  it('KST 00시대는 "24:xx"가 아니라 "00:xx"로 표시해야 함 — 웹의 기본 시작 시각(00:00)과 일치', () => {
    // 웹에서 시작 시각 기본값 00:00(KST)으로 만든 태스크는 전날 15:00Z로 저장된다
    expect(formatDateTime(new Date('2026-10-12T15:00:00Z'))).toBe('2026. 10. 13. 00:00');
    expect(formatDateTime(new Date('2026-10-12T15:30:00Z'))).toBe('2026. 10. 13. 00:30');
  });

  it('null·undefined는 빈 문자열을 반환해야 함', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
  });
});

describe('formatDateRange', () => {
  // 연도 생략 판정 기준 시각 — KST 2026년
  const NOW = new Date('2026-10-14T03:00:00Z');

  it('같은 날(KST)이면 종료 쪽 날짜를 생략해야 함 — 웹 기본값(00:00~23:59) 태스크', () => {
    // KST 10/14 00:00 ~ 10/14 23:59 = UTC 10/13 15:00 ~ 10/14 14:59
    expect(
      formatDateRange(new Date('2026-10-13T15:00:00Z'), new Date('2026-10-14T14:59:59Z'), NOW),
    ).toBe('10/14(수) 00:00 ~ 23:59');
  });

  it('다른 날이면 양쪽 날짜를 모두 표시해야 함', () => {
    expect(
      formatDateRange(new Date('2026-10-14T00:00:00Z'), new Date('2026-10-16T09:00:00Z'), NOW),
    ).toBe('10/14(수) 09:00 ~ 10/16(금) 18:00');
  });

  it('한쪽만 있으면 열린 범위로 표시해야 함', () => {
    expect(formatDateRange(new Date('2026-10-14T00:00:00Z'), null, NOW)).toBe('10/14(수) 09:00 ~');
    expect(formatDateRange(undefined, new Date('2026-10-16T09:00:00Z'), NOW)).toBe('~ 10/16(금) 18:00');
  });

  it('올해가 아닌 날짜가 끼면 양쪽 모두 연도를 붙여야 함', () => {
    expect(
      formatDateRange(new Date('2026-12-31T00:00:00Z'), new Date('2027-01-04T09:00:00Z'), NOW),
    ).toBe('2026/12/31(목) 09:00 ~ 2027/1/4(월) 18:00');
  });

  it('일(day)만 같고 달이 다르면 다른 날로 표시해야 함', () => {
    expect(
      formatDateRange(new Date('2026-10-14T00:00:00Z'), new Date('2026-11-14T00:00:00Z'), NOW),
    ).toBe('10/14(수) 09:00 ~ 11/14(토) 09:00');
  });

  it('시작만 있어도 올해가 아니면 연도를 붙여야 함', () => {
    expect(formatDateRange(new Date('2027-01-04T00:00:00Z'), null, NOW)).toBe('2027/1/4(월) 09:00 ~');
  });

  it('올해 판정은 UTC가 아니라 KST 기준이어야 함 — UTC 12/31 15:30은 KST로 이미 새해', () => {
    const kstNewYear = new Date('2026-12-31T15:30:00Z'); // KST 2027-01-01 00:30
    expect(formatDateRange(new Date('2027-01-01T00:00:00Z'), null, kstNewYear)).toBe('1/1(금) 09:00 ~');
  });

  it('유효하지 않은 Date는 없는 것으로 취급해야 함 (알림 생성에서 throw하면 저장된 요청이 500)', () => {
    expect(formatDateRange(new Date('invalid'), null, NOW)).toBe('');
    expect(formatDateRange(new Date('invalid'), new Date('2026-10-16T09:00:00Z'), NOW)).toBe('~ 10/16(금) 18:00');
  });

  it('KST 00시대를 "24:xx"가 아니라 "00:xx"로 표시해야 함', () => {
    expect(formatDateRange(new Date('2026-10-13T15:30:00Z'), null, NOW)).toBe('10/14(수) 00:30 ~');
  });

  it('둘 다 없으면 빈 문자열을 반환해야 함', () => {
    expect(formatDateRange(null, undefined, NOW)).toBe('');
  });
});

import { formatDateTime } from './date.utils';

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

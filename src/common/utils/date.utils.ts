/**
 * 날짜를 포맷 (예: "2026. 03. 27. 14:00")
 * UTC 저장값을 KST(Asia/Seoul)로 변환하여 표시
 * 용도: 텔레그램 알림 등 사용자 대상 한국어 메시지
 *
 * `hour12: false` 대신 `hourCycle: 'h23'`을 쓴다 — 구버전 ECMA-402 규칙(Node 20 이하)은
 * 기본 시간제가 h12인 ko-KR에서 `hour12: false`를 h24로 해석해 00시대(00:00~00:59)를 "24:xx"로 출력한다.
 */
export function formatDateTime(date: Date | null | undefined): string {
  if (!date) return '';
  return date.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

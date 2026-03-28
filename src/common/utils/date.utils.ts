/**
 * 날짜를 포맷 (예: "2026. 03. 27. 14:00")
 * 투과 방식: 저장된 UTC+0 값을 변환 없이 그대로 표시
 * (프론트엔드와 동일 — 사용자 입력값 = 저장값 = 표시값)
 * 용도: 텔레그램 알림 등 사용자 대상 한국어 메시지
 */
export function formatDateTime(date: Date | null | undefined): string {
  if (!date) return '';
  return date.toLocaleString('ko-KR', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

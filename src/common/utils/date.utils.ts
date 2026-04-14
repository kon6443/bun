/**
 * 날짜를 포맷 (예: "2026. 03. 27. 14:00")
 * UTC 저장값을 KST(Asia/Seoul)로 변환하여 표시
 * 용도: 텔레그램 알림 등 사용자 대상 한국어 메시지
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
    hour12: false,
  });
}

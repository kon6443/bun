import { APP_TIMEZONE } from '../constants/timezone.constants';

/** 날짜 + 시:분 포맷 (예: "2026. 03. 27. 09:00") */
export function formatDateTime(date: Date | null | undefined): string {
  if (!date) return '';
  return date.toLocaleString('ko-KR', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

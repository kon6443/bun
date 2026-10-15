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

const KST_PARTS_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23', // formatDateTime과 같은 이유 — 00시대를 "24:xx"로 내지 않게
});

/** KST 기준 날짜 구성요소 (예: { year: '2026', month: '10', day: '14', weekday: '수', time: '00:00' }) */
function toKstParts(date: Date) {
  const parts = Object.fromEntries(KST_PARTS_FORMAT.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    weekday: parts.weekday,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * 기간을 알림용으로 짧게 포맷 (KST)
 * - 같은 날: "10/14(수) 00:00 ~ 23:59"
 * - 다른 날: "10/14(수) 09:00 ~ 10/16(금) 18:00"
 * - 한쪽만: "10/14(수) 09:00 ~" / "~ 10/16(금) 18:00"
 * - 올해(KST)가 아닌 날짜가 끼면 양쪽 모두 연도를 붙인다: "2027/1/5(화) …"
 * 용도: 텔레그램·디스코드 알림. 둘 다 없으면 빈 문자열
 * 유효하지 않은 Date는 없는 것으로 취급한다 — 알림은 저장 직후 동기로 만들어지므로 여기서 throw하면 저장된 요청이 500이 된다
 */
export function formatDateRange(
  startAt: Date | null | undefined,
  endAt: Date | null | undefined,
  now: Date = new Date(),
): string {
  const isValid = (d: Date | null | undefined): d is Date => !!d && !Number.isNaN(d.getTime());
  const start = isValid(startAt) ? toKstParts(startAt) : null;
  const end = isValid(endAt) ? toKstParts(endAt) : null;
  if (!start && !end) return '';
  const currentYear = toKstParts(now).year;
  const showYear = [start, end].some((p) => p && p.year !== currentYear);
  const day = (p: ReturnType<typeof toKstParts>) =>
    `${showYear ? `${p.year}/` : ''}${p.month}/${p.day}(${p.weekday})`;

  if (start && end) {
    const sameDay = start.year === end.year && start.month === end.month && start.day === end.day;
    return sameDay
      ? `${day(start)} ${start.time} ~ ${end.time}`
      : `${day(start)} ${start.time} ~ ${day(end)} ${end.time}`;
  }
  if (start) return `${day(start)} ${start.time} ~`;
  if (end) return `~ ${day(end)} ${end.time}`;
  return '';
}

import type {
  NotificationTeamInfo,
  TeamNotificationContent,
} from '../../common/port/notification.port';

/**
 * 인용 본문 최대 글자 수 — 넘으면 잘라서 '…'을 붙인다.
 * 텔레그램 메시지 한도(4096자)를 이스케이프로 늘어난 길이까지 포함해 넉넉히 밑돌게 둔다
 */
export const NOTIFICATION_QUOTE_MAX_LENGTH = 300;

const truncate = (text: string, max: number): string => {
  const chars = Array.from(text); // 이모지·서로게이트 쌍을 반으로 자르지 않게 코드포인트 단위
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
};

/** 텔레그램 HTML parse_mode가 요구하는 이스케이프 — 미처리 시 `<`·`&` 한 글자로 400(can't parse entities)이 나 알림이 유실된다 */
export const escapeTelegramHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 디스코드 Markdown 특수문자 이스케이프 — 사용자 입력이 서식으로 해석되지 않게 */
export const escapeDiscordMarkdown = (text: string): string =>
  text.replace(/([\\*_~`|>#[\]])/g, '\\$1');

/**
 * 텔레그램용 렌더 (parse_mode: 'HTML')
 *
 * 🆕 새 태스크 · 팀명
 * <b>태스크명</b>
 * 📅 10/14(수) 00:00 ~ 23:59
 * <blockquote>댓글</blockquote>
 */
export function renderTelegramHtml(team: NotificationTeamInfo, content: TeamNotificationContent): string {
  return renderTelegramBody(`${escapeTelegramHtml(content.title)} · ${escapeTelegramHtml(team.teamName)}`, content);
}

/** 운영자 피드백 채널용 텔레그램 렌더 — 팀명 없이 제목만 머리줄로 쓴다 */
export function renderFeedbackTelegramHtml(content: TeamNotificationContent): string {
  return renderTelegramBody(escapeTelegramHtml(content.title), content);
}

/** 머리줄(이미 이스케이프됨) 뒤의 subject·lines·quote 줄 구성 — 팀·운영자 알림 공통 */
function renderTelegramBody(header: string, { subject, lines = [], quote }: TeamNotificationContent): string {
  return [
    header,
    subject ? `<b>${escapeTelegramHtml(subject)}</b>` : null,
    ...lines.map(escapeTelegramHtml),
    quote ? `<blockquote>${escapeTelegramHtml(truncate(quote, NOTIFICATION_QUOTE_MAX_LENGTH))}</blockquote>` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 디스코드용 렌더 (Markdown) — 텔레그램과 같은 줄 구성 */
export function renderDiscordMarkdown(team: NotificationTeamInfo, content: TeamNotificationContent): string {
  return renderDiscordBody(`${content.title} · ${escapeDiscordMarkdown(team.teamName)}`, content);
}

/** 운영자 피드백 채널용 디스코드 렌더 — 팀명 없이 제목만 머리줄로 쓴다 */
export function renderFeedbackDiscordMarkdown(content: TeamNotificationContent): string {
  return renderDiscordBody(content.title, content);
}

/** 머리줄(이미 이스케이프됨) 뒤의 subject·lines·quote 줄 구성 — 팀·운영자 알림 공통 */
function renderDiscordBody(header: string, { subject, lines = [], quote }: TeamNotificationContent): string {
  const quoteLines = quote
    ? truncate(quote, NOTIFICATION_QUOTE_MAX_LENGTH)
        .split('\n')
        .map((line) => `> ${escapeDiscordMarkdown(line)}`)
    : [];
  return [
    header,
    subject ? `**${escapeDiscordMarkdown(subject)}**` : null,
    ...lines.map(escapeDiscordMarkdown),
    ...quoteLines,
  ]
    .filter(Boolean)
    .join('\n');
}

import type { NotificationTeamInfo } from '../../common/port/notification.port';
import {
  NOTIFICATION_QUOTE_MAX_LENGTH,
  renderDiscordMarkdown,
  renderFeedbackDiscordMarkdown,
  renderFeedbackTelegramHtml,
  renderTelegramHtml,
} from './notification.format';

const TEAM: NotificationTeamInfo = {
  teamId: 1,
  teamName: '개발팀',
  telegramChatId: 1,
  discordWebhookUrl: null,
};

/**
 * 알림 본문은 사용자 입력(팀명·태스크명·댓글)을 그대로 싣는다.
 * 텔레그램은 HTML parse_mode라 `<`·`&` 한 글자만 섞여도 API가 400을 내고 알림이 통째로 사라진다 —
 * 실패는 로그에만 남아 사용자는 "알림이 안 온다"로만 겪는다. 그래서 이스케이프를 채널별로 고정한다.
 */
describe('renderTelegramHtml', () => {
  it('제목·팀명, 굵은 대상, 부가 줄, 인용 블록 순으로 렌더해야 함', () => {
    const html = renderTelegramHtml(TEAM, {
      title: '💬 새 댓글',
      subject: '회의 준비',
      lines: ['📅 10/14(수) 00:00 ~ 23:59'],
      quote: '안건 정리했습니다',
    });

    expect(html).toBe(
      [
        '💬 새 댓글 · 개발팀',
        '<b>회의 준비</b>',
        '📅 10/14(수) 00:00 ~ 23:59',
        '<blockquote>안건 정리했습니다</blockquote>',
      ].join('\n'),
    );
  });

  it('사용자 입력의 HTML 특수문자를 이스케이프해야 함 (미처리 시 텔레그램 400으로 알림 유실)', () => {
    const html = renderTelegramHtml(
      { ...TEAM, teamName: 'R&D' },
      { title: '🆕 새 태스크', subject: 'a<b> 검토', lines: ['x > y'], quote: '<script>&' },
    );

    expect(html).toBe(
      [
        '🆕 새 태스크 · R&amp;D',
        '<b>a&lt;b&gt; 검토</b>',
        'x &gt; y',
        '<blockquote>&lt;script&gt;&amp;</blockquote>',
      ].join('\n'),
    );
  });

  it('긴 인용 본문은 잘라서 …을 붙여야 함 (텔레그램 4096자 한도 초과 방지)', () => {
    const html = renderTelegramHtml(TEAM, { title: '💬 새 댓글', quote: '가'.repeat(5000) });

    expect(html).toContain(`<blockquote>${'가'.repeat(NOTIFICATION_QUOTE_MAX_LENGTH)}…</blockquote>`);
    expect(html.length).toBeLessThan(4096);
  });

  it('이모지를 반으로 자르지 않아야 함 (깨진 서로게이트는 텔레그램이 거부)', () => {
    const html = renderTelegramHtml(TEAM, { title: 't', quote: '😀'.repeat(NOTIFICATION_QUOTE_MAX_LENGTH + 1) });

    expect(html).toContain(`${'😀'.repeat(NOTIFICATION_QUOTE_MAX_LENGTH)}…`);
  });

  it('비어 있는 항목은 줄 자체를 생략해야 함', () => {
    expect(renderTelegramHtml(TEAM, { title: '👥 역할 변경' })).toBe('👥 역할 변경 · 개발팀');
  });
});

describe('renderDiscordMarkdown', () => {
  it('텔레그램과 같은 줄 구성을 Markdown으로 렌더해야 함 — 여러 줄 인용은 줄마다 > 를 붙인다', () => {
    const md = renderDiscordMarkdown(TEAM, {
      title: '💬 새 댓글',
      subject: '회의 준비',
      lines: ['📅 10/14(수) 00:00 ~ 23:59'],
      quote: '첫 줄\n둘째 줄',
    });

    expect(md).toBe(
      // 부가 줄도 이스케이프한다 — \~ 는 디스코드에서 ~ 로 보인다
      ['💬 새 댓글 · 개발팀', '**회의 준비**', '📅 10/14(수) 00:00 \\~ 23:59', '> 첫 줄', '> 둘째 줄'].join('\n'),
    );
  });

  it('사용자 입력의 Markdown 서식 문자를 이스케이프해야 함', () => {
    const md = renderDiscordMarkdown(TEAM, { title: '🆕 새 태스크', subject: '**긴급** _중요_' });

    expect(md).toContain('**\\*\\*긴급\\*\\* \\_중요\\_**');
  });

  it('팀명·인용 본문의 서식 문자도 이스케이프해야 함', () => {
    const md = renderDiscordMarkdown({ ...TEAM, teamName: 'A_*B' }, { title: 't', quote: '**굵게** `코드`' });

    expect(md).toBe(['t · A\\_\\*B', '> \\*\\*굵게\\*\\* \\`코드\\`'].join('\n'));
  });

  it('긴 인용 본문은 텔레그램과 같은 길이로 잘라야 함 (디스코드 2000자 한도)', () => {
    const md = renderDiscordMarkdown(TEAM, { title: 't', quote: '가'.repeat(5000) });

    expect(md).toContain(`> ${'가'.repeat(NOTIFICATION_QUOTE_MAX_LENGTH)}…`);
    expect(md.length).toBeLessThan(2000);
  });

  it('HTML 태그를 넣지 않아야 함 (디스코드에선 글자 그대로 보인다)', () => {
    const md = renderDiscordMarkdown(TEAM, { title: 't', subject: 's', quote: 'q' });

    expect(md).not.toMatch(/<\/?(b|blockquote)>/);
  });
});

describe('renderFeedback* — 운영자 피드백 채널 (팀명 없음)', () => {
  const content = { title: '📮 새 피드백 · 문의', subject: 'a < b & *c*', lines: ['#1 · 홍길동 (userId 1)'], quote: '본문' };

  it('텔레그램: 팀명 없이 제목 머리줄 + 같은 줄 구성, 사용자 입력은 이스케이프해야 함', () => {
    expect(renderFeedbackTelegramHtml(content)).toBe(
      '📮 새 피드백 · 문의\n<b>a &lt; b &amp; *c*</b>\n#1 · 홍길동 (userId 1)\n<blockquote>본문</blockquote>',
    );
  });

  it('디스코드: 팀명 없이 제목 머리줄 + 같은 줄 구성, 서식 문자는 이스케이프해야 함', () => {
    expect(renderFeedbackDiscordMarkdown(content)).toBe('📮 새 피드백 · 문의\n**a < b & \\*c\\***\n\\#1 · 홍길동 (userId 1)\n> 본문');
  });
});

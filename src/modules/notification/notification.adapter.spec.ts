import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { NotificationAdapter } from './notification.adapter';
import { TelegramService } from './telegram.service';
import { DiscordService } from './discord.service';
import type { NotificationTeamInfo, TeamNotificationContent } from '../../common/port/notification.port';

const TEAM: NotificationTeamInfo = {
  teamId: 1,
  teamName: '테스트팀',
  telegramChatId: 12345,
  discordWebhookUrl: 'https://discord.test/hook',
};

/**
 * 팀 알림이 어느 채널로 나가는지 결정하는 유일한 분기점이다.
 *
 * 여기가 조용히 깨지면 증상이 "알림이 안 온다"뿐이라 원인 추적이 어렵다 —
 * 서비스 호출부는 `notifyTeam` 하나만 부르고 결과를 확인하지 않기 때문에(fire-and-forget)
 * 한 채널이 빠져도 예외도, 로그도 남지 않는다. 그래서 **두 채널이 모두 호출된다**는 것을
 * 채널별로 각각 고정한다.
 */
const CONTENT: TeamNotificationContent = { title: '🆕 새 태스크', subject: '알림 내용' };

describe('NotificationAdapter', () => {
  let adapter: NotificationAdapter;
  let telegramService: { sendTeamNotification: jest.Mock; sendMessageAsync: jest.Mock };
  let discordService: { sendTeamNotification: jest.Mock; sendWebhookMessage: jest.Mock };
  /** 운영자 피드백 채널 env — 테스트마다 바꾼다 */
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    telegramService = {
      sendTeamNotification: jest.fn().mockResolvedValue(undefined),
      sendMessageAsync: jest.fn().mockResolvedValue(undefined),
    };
    discordService = {
      sendTeamNotification: jest.fn().mockResolvedValue(undefined),
      sendWebhookMessage: jest.fn().mockResolvedValue(undefined),
    };
    env = {
      FEEDBACK_TELEGRAM_CHAT_ID: '-100777',
      FEEDBACK_DISCORD_WEBHOOK_URL: 'https://discord.test/feedback-hook',
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationAdapter,
        { provide: TelegramService, useValue: telegramService },
        { provide: DiscordService, useValue: discordService },
        { provide: ConfigService, useValue: { get: jest.fn((key: string) => env[key]) } },
      ],
    }).compile();

    adapter = module.get(NotificationAdapter);
  });

  afterEach(() => jest.restoreAllMocks());

  it('한 번의 호출로 텔레그램과 디스코드 양쪽에 보내야 함', () => {
    adapter.notifyTeam({ team: TEAM, content: CONTENT });

    expect(telegramService.sendTeamNotification).toHaveBeenCalledTimes(1);
    expect(discordService.sendTeamNotification).toHaveBeenCalledTimes(1);
  });

  it('채널마다 다른 파라미터 이름으로 변환해 전달해야 함', () => {
    adapter.notifyTeam({ team: TEAM, content: CONTENT });

    // 텔레그램은 message(HTML), 디스코드는 content(Markdown) — 이름이 어긋나면 빈 알림이 나간다
    expect(telegramService.sendTeamNotification).toHaveBeenCalledWith({
      team: TEAM,
      message: '🆕 새 태스크 · 테스트팀\n<b>알림 내용</b>',
    });
    expect(discordService.sendTeamNotification).toHaveBeenCalledWith({
      team: TEAM,
      content: '🆕 새 태스크 · 테스트팀\n**알림 내용**',
      url: undefined,
    });
  });

  it('url이 있으면 텔레그램에는 버튼으로, 디스코드에는 url로 전달해야 함', () => {
    adapter.notifyTeam({ team: TEAM, content: CONTENT, url: 'https://app.test/tasks/1' });

    expect(telegramService.sendTeamNotification).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: [{ text: '바로가기', url: 'https://app.test/tasks/1' }] }),
    );
    expect(discordService.sendTeamNotification).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://app.test/tasks/1' }),
    );
  });

  it.each([
    ['url 미지정', undefined],
    ['빈 문자열', ''],
  ])('%s이면 텔레그램에 buttons 키 자체를 넣지 않아야 함', (_desc, url) => {
    adapter.notifyTeam({ team: TEAM, content: CONTENT, url });

    const [payload] = telegramService.sendTeamNotification.mock.calls[0];
    // buttons: undefined를 넘기는 것과 다르다 — 빈 버튼 배열이 붙으면 텔레그램 API가 거부한다
    expect(payload).not.toHaveProperty('buttons');
  });

  it('전송 완료를 기다리지 않고 즉시 반환해야 함 (fire-and-forget)', () => {
    // 응답이 오지 않는 채널이 있어도 호출부가 멈추면 안 된다
    telegramService.sendTeamNotification.mockReturnValue(new Promise(() => {}));
    discordService.sendTeamNotification.mockReturnValue(new Promise(() => {}));

    expect(adapter.notifyTeam({ team: TEAM, content: CONTENT })).toBeUndefined();
    expect(discordService.sendTeamNotification).toHaveBeenCalled();
  });

  it('연동 정보가 없는 팀이어도 두 채널을 그대로 호출해야 함 (판단은 각 서비스 책임)', () => {
    const emptyTeam: NotificationTeamInfo = {
      teamId: 2,
      teamName: '미연동팀',
      telegramChatId: null,
      discordWebhookUrl: null,
    };

    adapter.notifyTeam({ team: emptyTeam, content: CONTENT });

    // Adapter가 미리 걸러내면 "연동 안 됨" 경고 로그가 사라져 원인 추적이 어려워진다
    expect(telegramService.sendTeamNotification).toHaveBeenCalledWith(
      expect.objectContaining({ team: emptyTeam }),
    );
    expect(discordService.sendTeamNotification).toHaveBeenCalledWith(
      expect.objectContaining({ team: emptyTeam }),
    );
  });

  describe('notifyFeedbackChannel — 운영자 피드백 채널 (docs/tasks/feedback D-008)', () => {
    const FEEDBACK: TeamNotificationContent = { title: '📮 새 피드백 · 버그 리포트', subject: '<저장> 안 됨', quote: '본문' };

    it('env의 텔레그램 chatId·디스코드 웹훅으로 각각 보내고, 팀 알림 경로는 쓰지 않아야 함', () => {
      adapter.notifyFeedbackChannel(FEEDBACK);

      expect(telegramService.sendMessageAsync).toHaveBeenCalledWith(
        '-100777',
        '📮 새 피드백 · 버그 리포트\n<b>&lt;저장&gt; 안 됨</b>\n<blockquote>본문</blockquote>',
      );
      expect(discordService.sendWebhookMessage).toHaveBeenCalledWith(
        'https://discord.test/feedback-hook',
        '📮 새 피드백 · 버그 리포트\n**<저장\\> 안 됨**\n> 본문',
      );
      expect(telegramService.sendTeamNotification).not.toHaveBeenCalled();
      expect(discordService.sendTeamNotification).not.toHaveBeenCalled();
    });

    it.each([
      ['텔레그램', 'FEEDBACK_TELEGRAM_CHAT_ID', () => telegramService.sendMessageAsync, () => discordService.sendWebhookMessage],
      ['디스코드', 'FEEDBACK_DISCORD_WEBHOOK_URL', () => discordService.sendWebhookMessage, () => telegramService.sendMessageAsync],
    ])('%s env가 없으면 그 채널만 건너뛰어야 함 (safe default)', (_name, key, skipped, other) => {
      env[key] = undefined;

      adapter.notifyFeedbackChannel(FEEDBACK);

      expect(skipped()).not.toHaveBeenCalled();
      expect(other()).toHaveBeenCalledTimes(1);
    });

    it('발송이 실패해도 예외를 던지지 않고 로그만 남겨야 함 (작성 결과에 영향 없음)', async () => {
      const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      telegramService.sendMessageAsync.mockRejectedValue(new Error('Telegram API 오류: 400'));
      discordService.sendWebhookMessage.mockRejectedValue(new Error('Discord Webhook 오류: 404'));

      expect(() => adapter.notifyFeedbackChannel(FEEDBACK)).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));

      expect(loggerError).toHaveBeenCalledTimes(2);
    });
  });
});

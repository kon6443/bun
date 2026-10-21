import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';
import { DiscordService } from './discord.service';
import {
  renderDiscordMarkdown,
  renderFeedbackDiscordMarkdown,
  renderFeedbackTelegramHtml,
  renderTelegramHtml,
} from './notification.format';
import {
  INotificationPort,
  TeamNotificationContent,
  TeamNotificationParams,
} from '../../common/port/notification.port';
import { toErrorDetail } from '../../common/utils/error.utils';

/**
 * 알림 서비스 Adapter (INotificationPort 구현체)
 * Telegram + Discord로 팀 알림 전송
 * 새 메신저 추가 시 이 서비스의 notifyTeam 내부에만 추가하면 됨
 */
@Injectable()
export class NotificationAdapter implements INotificationPort {
  private readonly logger = new Logger(NotificationAdapter.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly discordService: DiscordService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 팀 단위 알림 전송 (fire-and-forget)
   * 등록된 모든 메신저 서비스로 병렬 전송 — 본문은 채널 문법에 맞춰 각각 렌더한다
   */
  notifyTeam({ team, content, url }: TeamNotificationParams): void {
    // 텔레그램
    void this.telegramService.sendTeamNotification({
      team,
      message: renderTelegramHtml(team, content),
      ...(url && { buttons: [{ text: '바로가기', url }] }),
    });

    // 디스코드
    void this.discordService.sendTeamNotification({
      team,
      content: renderDiscordMarkdown(team, content),
      url,
    });

    // 슬랙 등 새 메신저 추가 시 여기에 추가
  }

  /**
   * 운영자 피드백 채널 알림 (fire-and-forget, docs/tasks/feedback D-008)
   * env가 없는 채널은 건너뛴다. 발송 실패는 로그만 남긴다 — 피드백 작성 결과에 영향을 주지 않는다
   */
  notifyFeedbackChannel(content: TeamNotificationContent): void {
    const telegramChatId = this.configService.get<string>('FEEDBACK_TELEGRAM_CHAT_ID');
    if (telegramChatId) {
      this.telegramService
        .sendMessageAsync(telegramChatId, renderFeedbackTelegramHtml(content))
        .catch((error: unknown) => this.logger.error('notifyFeedbackChannel() 텔레그램 오류:', toErrorDetail(error)));
    }

    const discordWebhookUrl = this.configService.get<string>('FEEDBACK_DISCORD_WEBHOOK_URL');
    if (discordWebhookUrl) {
      this.discordService
        .sendWebhookMessage(discordWebhookUrl, renderFeedbackDiscordMarkdown(content))
        .catch((error: unknown) => this.logger.error('notifyFeedbackChannel() 디스코드 오류:', toErrorDetail(error)));
    }
  }
}

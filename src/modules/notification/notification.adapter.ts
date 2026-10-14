import { Injectable } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { DiscordService } from './discord.service';
import { renderDiscordMarkdown, renderTelegramHtml } from './notification.format';
import {
  INotificationPort,
  TeamNotificationParams,
} from '../../common/port/notification.port';

/**
 * 알림 서비스 Adapter (INotificationPort 구현체)
 * Telegram + Discord로 팀 알림 전송
 * 새 메신저 추가 시 이 서비스의 notifyTeam 내부에만 추가하면 됨
 */
@Injectable()
export class NotificationAdapter implements INotificationPort {
  constructor(
    private readonly telegramService: TelegramService,
    private readonly discordService: DiscordService,
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
}

import { Injectable } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { DiscordService } from './discord.service';
import { Team } from '../../entities/Team';
import { TeamMemberType } from '../team/team.service';

/**
 * 팀 알림 전송 파라미터
 */
export interface TeamNotificationParams {
  team: Team | TeamMemberType;
  message: string;
  url?: string;
}

/**
 * 통합 알림 서비스
 * 모든 메신저 서비스를 하나의 인터페이스로 관리
 * 새 메신저 추가 시 이 서비스의 notifyTeam 내부에만 추가하면 됨
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly telegramService: TelegramService,
    private readonly discordService: DiscordService,
  ) {}

  /**
   * 팀 단위 알림 전송 (fire-and-forget)
   * 등록된 모든 메신저 서비스로 병렬 전송
   */
  notifyTeam({ team, message, url }: TeamNotificationParams): void {
    // 텔레그램
    this.telegramService.sendTeamNotification({
      team,
      message,
      ...(url && { buttons: [{ text: '바로가기', url }] }),
    });

    // 디스코드
    this.discordService.sendTeamNotification({
      team,
      content: message,
      url,
    });

    // 슬랙 등 새 메신저 추가 시 여기에 추가
  }
}

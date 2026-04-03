import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Team } from '../../entities/Team';
import { ActStatus } from '../../common/enums/task-status.enum';
import { NotificationTeamInfo } from '../../common/port/notification.port';

/**
 * 디스코드 Embed 필드 타입
 */
export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * 디스코드 Embed 타입 (Webhook 메시지용)
 */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  url?: string;
  timestamp?: string;
}

@Injectable()
export class DiscordService {
  private readonly logger = new Logger(DiscordService.name);

  constructor(
    @InjectRepository(Team)
    private readonly teamRepository: Repository<Team>,
  ) {}

  /**
   * Webhook URL로 메시지 전송 (fire-and-forget)
   * @param webhookUrl 디스코드 채널 Webhook URL
   * @param content 텍스트 메시지
   * @param embeds Embed 배열 (선택)
   */
  async sendWebhookMessage(
    webhookUrl: string,
    content: string,
    embeds?: DiscordEmbed[],
  ): Promise<void> {
    if (!webhookUrl || !content) {
      this.logger.warn('sendWebhookMessage(): webhookUrl 또는 content가 없습니다.');
      return;
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        ...(embeds?.length && { embeds }),
      }),
    });

    if (!response.ok) {
      const errorData = await response.text().catch(() => '');
      throw new Error(`Discord Webhook 오류: ${response.status} - ${errorData}`);
    }
  }

  /**
   * 팀 단위 메시지 전송
   * @param team 팀 정보 (discordWebhookUrl 포함)
   * @param content 전송할 메시지
   * @param url 바로가기 링크 (선택)
   * @param embeds Embed 배열 (선택)
   */
  async sendTeamNotification({
    team,
    content,
    url,
    embeds,
  }: {
    team: NotificationTeamInfo;
    content: string;
    url?: string;
    embeds?: DiscordEmbed[];
  }): Promise<void> {
    const { teamId, discordWebhookUrl } = team;

    try {
      if (!discordWebhookUrl) {
        this.logger.warn(
          `[teamId: ${teamId}] sendTeamNotification(): 팀에 discordWebhookUrl이 설정되지 않았습니다`,
        );
        return;
      }

      const messageWithLink = url ? `${content}\n\n[바로가기](${url})` : content;
      await this.sendWebhookMessage(discordWebhookUrl, messageWithLink, embeds);
    } catch (error) {
      this.logger.error(`sendTeamNotification() 오류:`, error);
    }
  }

  /**
   * Webhook URL 유효성 검증
   * Discord Webhook URL 형식 확인 및 실제 요청 테스트
   * @param webhookUrl 검증할 Webhook URL
   */
  async validateWebhookUrl(webhookUrl: string): Promise<{ valid: boolean; name?: string }> {
    // Discord Webhook URL 형식 검증
    if (!webhookUrl.startsWith('https://discord.com/api/webhooks/') &&
        !webhookUrl.startsWith('https://discordapp.com/api/webhooks/')) {
      return { valid: false };
    }

    try {
      const response = await fetch(webhookUrl, { method: 'GET' });
      if (!response.ok) return { valid: false };

      const data = (await response.json()) as { name?: string };
      return { valid: true, name: data.name };
    } catch {
      return { valid: false };
    }
  }

  /**
   * 팀에 Webhook URL 저장
   * @param teamId 팀 ID
   * @param webhookUrl Webhook URL
   */
  async saveWebhookUrl(teamId: number, webhookUrl: string): Promise<void> {
    const team = await this.teamRepository.findOne({
      where: { teamId, actStatus: ActStatus.ACTIVE },
    });

    if (!team) {
      throw new Error('팀을 찾을 수 없습니다.');
    }

    await this.teamRepository.update({ teamId }, { discordWebhookUrl: webhookUrl });
    this.logger.log(`Webhook URL 저장 완료. teamId: ${teamId}`);
  }

  /**
   * 팀의 디스코드 연동 상태 조회
   * @param teamId 팀 ID
   */
  async getLinkStatus(teamId: number): Promise<{
    isLinked: boolean;
    webhookUrl: string | null;
  }> {
    const team = await this.teamRepository.findOne({
      where: { teamId, actStatus: ActStatus.ACTIVE },
    });

    if (!team) {
      throw new Error('팀을 찾을 수 없습니다.');
    }

    return {
      isLinked: !!team.discordWebhookUrl,
      webhookUrl: team.discordWebhookUrl,
    };
  }

  /**
   * 팀의 디스코드 연동 해제
   * @param teamId 팀 ID
   */
  async unlinkTeam(teamId: number): Promise<void> {
    const team = await this.teamRepository.findOne({
      where: { teamId, actStatus: ActStatus.ACTIVE },
    });

    if (!team) {
      throw new Error('팀을 찾을 수 없습니다.');
    }

    await this.teamRepository.update({ teamId }, { discordWebhookUrl: null });
    this.logger.log(`팀 연동 해제. teamId: ${teamId}`);
  }
}

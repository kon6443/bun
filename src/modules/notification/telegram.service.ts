import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Team } from '../../entities/Team';
import { ActStatus } from '@/common/enums/task-status.enum';
import { TeamMember } from '@/entities/TeamMember';
import { TeamMemberType } from '../team/team.service';

@Injectable()
export class TelegramService {
  private readonly baseUrl = 'https://api.telegram.org';
  private readonly botToken: string;

  constructor() {
    this.botToken = process.env.BOT_TOKEN_TELEGRAM || '';
    if (!this.botToken) {
      console.warn('[TELEGRAM] BOT_TOKEN_TELEGRAM 환경변수가 설정되지 않았습니다.');
    }
  }

  /**
   * 비동기 메시지 전송 (fire-and-forget)
   * 에러 발생 시 로깅만 하고 예외를 전파하지 않음
   */
  async sendMessageAsync(chatId: number | string, message: string): Promise<void> {
    if (!this.botToken) {
      console.warn('[TELEGRAM] sendMessageAsync(): REQUIRES: BOT_TOKEN_TELEGRAM');
      return;
    }

    if (!chatId || !message) {
      console.warn('[TELEGRAM] sendMessageAsync(): chatId 또는 message가 없습니다.');
      return;
    }

    const url = `${this.baseUrl}/bot${this.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML', // HTML 포맷 지원 (선택적)
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Telegram API 오류: ${response.status} - ${JSON.stringify(errorData)}`);
    }
    // console.log(`[TELEGRAM] 메시지 전송 성공. chatId: ${chatId}`);
  }

  /**
   * 팀 단위 메시지 전송
   * teamId로 chatId를 조회한 후 메시지 전송
   */
  // async sendTeamNotification(teamId: number, message: string): Promise<void> {
  async sendTeamNotification({team, message}: {team: Team|TeamMemberType, message: string;}): Promise<void> {
    const { teamId, telegramChatId } = team as Team;

    try {
      if (!telegramChatId) {
        console.warn(`[teamId: ${teamId} - TELEGRAM] sendTeamNotification(): 팀에 telegramChatId가 설정되지 않았습니다`);
        return;
      }

      await this.sendMessageAsync(telegramChatId, message);
    } catch (error) {
      console.error(`[TELEGRAM] sendTeamNotification() 오류:`, error);
    }
  }
}

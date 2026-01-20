import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Team } from '../../entities/Team';
import { ActStatus } from '@/common/enums/task-status.enum';
import { TeamMember } from '@/entities/TeamMember';
import { TeamMemberType } from '../team/team.service';

/**
 * 텔레그램 인라인 키보드 버튼 타입
 */
export interface TelegramInlineButton {
  text: string;  // 버튼에 표시될 텍스트
  url: string;   // 클릭 시 이동할 URL
}

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
   * @param chatId 텔레그램 채팅 ID
   * @param message 전송할 메시지
   * @param buttons 선택적 인라인 키보드 버튼 배열
   */
  async sendMessageAsync(
    chatId: number | string,
    message: string,
    buttons?: TelegramInlineButton[],
  ): Promise<void> {
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
        parse_mode: 'HTML',
        ...(buttons?.length && {
          reply_markup: {
            inline_keyboard: [buttons.map(btn => ({ text: btn.text, url: btn.url }))],
            // inline_keyboard: [buttons.map(btn => ({ text: btn.text, url: btn.url.replace('http://localhost:3000', 'https://fivesouth.duckdns.org') }))],
          },
        }),
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
   * @param team 팀 정보 (telegramChatId 포함)
   * @param message 전송할 메시지
   * @param buttons 선택적 인라인 키보드 버튼 배열
   */
  async sendTeamNotification({
    team,
    message,
    buttons,
  }: {
    team: Team | TeamMemberType;
    message: string;
    buttons?: TelegramInlineButton[];
  }): Promise<void> {
    const { teamId, telegramChatId } = team as Team;

    try {
      if (!telegramChatId) {
        console.warn(`[teamId: ${teamId} - TELEGRAM] sendTeamNotification(): 팀에 telegramChatId가 설정되지 않았습니다`);
        return;
      }

      await this.sendMessageAsync(telegramChatId, message, buttons);
    } catch (error) {
      console.error(`[TELEGRAM] sendTeamNotification() 오류:`, error);
    }
  }
}

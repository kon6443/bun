import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, EntityManager, DataSource } from 'typeorm';
import { Team } from '../../entities/Team';
import { TelegramLink } from '../../entities/TelegramLink';
import { ActStatus } from '@/common/enums/task-status.enum';
import { TeamMemberType } from '../team/team.service';
import { randomBytes } from 'crypto';

/**
 * 텔레그램 인라인 키보드 버튼 타입
 */
export interface TelegramInlineButton {
  text: string;  // 버튼에 표시될 텍스트
  url: string;   // 클릭 시 이동할 URL
}

/**
 * 텔레그램 Webhook Update 타입 (my_chat_member 이벤트)
 */
export interface TelegramUpdate {
  update_id: number;
  my_chat_member?: {
    chat: {
      id: number;
      title?: string;
      type: string;
    };
    from: {
      id: number;
      first_name: string;
      username?: string;
    };
    date: number;
    old_chat_member: {
      user: { id: number };
      status: string;
    };
    new_chat_member: {
      user: { id: number };
      status: string;
    };
  };
  message?: {
    chat: {
      id: number;
      title?: string;
      type: string;
    };
    text?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
  };
}

/**
 * 연동 토큰 생성 결과 타입
 */
export interface LinkTokenResult {
  token: string;
  deepLink: string;
  endAt: Date;
}

@Injectable()
export class TelegramService {
  private readonly baseUrl = 'https://api.telegram.org';
  private readonly botToken: string;
  private readonly botUsername: string;
  private readonly tokenExpirationHours = 24;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(TelegramLink)
    private readonly telegramLinkRepository: Repository<TelegramLink>,
    @InjectRepository(Team)
    private readonly teamRepository: Repository<Team>,
  ) {
    this.botToken = process.env.BOT_TOKEN_TELEGRAM || '';
    this.botUsername = process.env.BOT_USERNAME_TELEGRAM || '';
    if (!this.botToken) {
      console.warn('[TELEGRAM] BOT_TOKEN_TELEGRAM 환경변수가 설정되지 않았습니다.');
    }
    if (!this.botUsername) {
      console.warn('[TELEGRAM] BOT_USERNAME_TELEGRAM 환경변수가 설정되지 않았습니다.');
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

  /**
   * 팀별 연동 토큰 생성 및 딥링크 반환
   * @param teamId 팀 ID
   * @returns 토큰, 딥링크, 만료일시
   */
  async generateLinkToken(teamId: number): Promise<LinkTokenResult> {
    // 기존 미사용 토큰 비활성화
    await this.telegramLinkRepository.update(
      // { teamId, actStatus: ActStatus.ACTIVE, usedAt: null },
      { teamId, actStatus: ActStatus.ACTIVE },
      { actStatus: ActStatus.INACTIVE },
    );

    // 새 토큰 생성
    const token = randomBytes(32).toString('hex');
    const endAt = new Date();
    endAt.setHours(endAt.getHours() + this.tokenExpirationHours);

    const telegramLink = this.telegramLinkRepository.create({
      teamId,
      token,
      endAt,
      actStatus: ActStatus.ACTIVE,
    });
    await this.telegramLinkRepository.save(telegramLink);

    const deepLink = this.getDeepLink(token);

    return {
      token,
      deepLink,
      endAt,
    };
  }

  /**
   * 토큰으로 그룹 추가용 딥링크 생성
   * @param token 연동 토큰
   * @returns 딥링크 URL
   */
  getDeepLink(token: string): string {
    if (!this.botUsername) {
      throw new Error('BOT_USERNAME_TELEGRAM 환경변수가 설정되지 않았습니다.');
    }
    return `https://t.me/${this.botUsername}?startgroup=${token}`;
  }

  /**
   * Webhook 이벤트 처리
   * @param update 텔레그램 Update 객체
   * @returns 처리 결과
   */
  async handleWebhook(update: TelegramUpdate): Promise<{ success: boolean; message: string }> {
    console.log('[TELEGRAM] Webhook received:', JSON.stringify(update, null, 2));

    // my_chat_member 이벤트: 봇이 그룹에 추가/제거될 때
    if (update.my_chat_member) {
      const { chat, new_chat_member } = update.my_chat_member;

      // 봇이 그룹에 추가된 경우 (member 또는 administrator)
      if (['member', 'administrator'].includes(new_chat_member.status)) {
        console.log(`[TELEGRAM] 봇이 그룹에 추가됨. chatId: ${chat.id}, title: ${chat.title}`);
        // 그룹에 추가된 후 /start 명령을 기다림
        return { success: true, message: '봇이 그룹에 추가되었습니다. /start 명령을 기다리는 중입니다.' };
      }

      // 봇이 그룹에서 제거된 경우
      if (['left', 'kicked'].includes(new_chat_member.status)) {
        console.log(`[TELEGRAM] 봇이 그룹에서 제거됨. chatId: ${chat.id}`);
        // 해당 chatId를 사용하는 팀의 연동 해제
        await this.unlinkTeamByChatId(chat.id);
        return { success: true, message: '봇이 그룹에서 제거되었습니다.' };
      }
    }

    // message 이벤트: /start 명령 처리
    if (update.message?.text) {
      const { chat, text, entities } = update.message;

      // bot_command 엔티티 확인
      const isBotCommand = entities?.some(e => e.type === 'bot_command');

      if (isBotCommand && text.startsWith('/start')) {
        // /start token 형식에서 token 추출
        const parts = text.split(' ');
        const token = parts.length > 1 ? parts[1] : null;

        if (token) {
          const result = await this.verifyAndLinkTeam(token, chat.id);
          
          if (result.success) {
            await this.sendMessageAsync(
              chat.id,
              `✅ 연동이 완료되었습니다!\n\n팀: <b>${result.teamName}</b>\n\n이제 이 그룹으로 팀 알림을 받을 수 있습니다.`,
            );
          } else {
            await this.sendMessageAsync(
              chat.id,
              `❌ 연동에 실패했습니다.\n\n사유: ${result.message}`,
            );
          }

          return result;
        } else {
          await this.sendMessageAsync(
            chat.id,
            '안녕하세요! 팀 알림 봇입니다.\n\n웹에서 제공받은 연동 링크를 통해 그룹에 추가해주세요.',
          );
          return { success: true, message: '토큰 없는 /start 명령' };
        }
      }
    }

    return { success: true, message: '처리할 이벤트 없음' };
  }

  /**
   * 토큰 검증 후 팀에 chat_id 연결
   * @param token 연동 토큰
   * @param chatId 텔레그램 그룹 채팅 ID
   * @returns 연동 결과
   */
  async verifyAndLinkTeam(
    token: string,
    chatId: number,
  ): Promise<{ success: boolean; message: string; teamName?: string }> {
    // 유효한 토큰 조회
    const telegramLink = await this.telegramLinkRepository.findOne({
      where: {
        token,
        actStatus: ActStatus.ACTIVE,
        // usedAt: null,
        endAt: MoreThan(new Date()),
      },
    });

    if (!telegramLink) {
      return { success: false, message: '유효하지 않거나 만료된 토큰입니다.' };
    }

    // 팀 조회
    const team = await this.teamRepository.findOne({
      where: { teamId: telegramLink.teamId, actStatus: ActStatus.ACTIVE },
    });

    if (!team) {
      return { success: false, message: '팀을 찾을 수 없습니다.' };
    }

    // 이미 다른 그룹과 연동된 경우
    if (team.telegramChatId && team.telegramChatId !== chatId) {
      return { success: false, message: '이 팀은 이미 다른 텔레그램 그룹과 연동되어 있습니다.' };
    }

    // // 팀에 chatId 저장
    // await this.teamRepository.update(
    //   { teamId: team.teamId },
    //   { telegramChatId: chatId },
    // );

    // // 토큰 사용 처리
    // await this.telegramLinkRepository.update(
    //   { linkId: telegramLink.linkId },
    //   { usedAt: new Date(), actStatus: ActStatus.INACTIVE },
    // );

    try {
      await this.dataSource.transaction(async (manager: EntityManager) => {
        await Promise.all([
          manager.update(Team, { teamId: team.teamId }, { telegramChatId: chatId }),
          manager.update(TelegramLink, { linkId: telegramLink.linkId }, { usedAt: new Date(), actStatus: ActStatus.INACTIVE }),
        ]);
      });
    } catch(err) {
      return { success: false, message: '연동 처리 중 오류가 발생했습니다.' };
    }
    
    console.log(`[TELEGRAM] 팀 연동 완료. teamId: ${team.teamId}, chatId: ${chatId}`);
    return { success: true, message: '연동이 완료되었습니다.', teamName: team.teamName };
  }

  /**
   * 팀의 텔레그램 연동 상태 조회
   * @param teamId 팀 ID
   * @returns 연동 상태
   */
  async getLinkStatus(teamId: number): Promise<{
    isLinked: boolean;
    chatId: number | null;
    pendingLink?: { token: string; deepLink: string; endAt: Date };
  }> {
    const team = await this.teamRepository.findOne({
      where: { teamId, actStatus: ActStatus.ACTIVE },
    });

    if (!team) {
      throw new Error('팀을 찾을 수 없습니다.');
    }

    // 이미 연동된 경우
    if (team.telegramChatId) {
      return {
        isLinked: true,
        chatId: team.telegramChatId,
      };
    }

    // 대기 중인 연동 토큰 조회
    const pendingLink = await this.telegramLinkRepository.findOne({
      where: {
        teamId,
        actStatus: ActStatus.ACTIVE,
        // usedAt: null,
        endAt: MoreThan(new Date()),
      },
      order: { crtdAt: 'DESC' },
    });

    if (pendingLink) {
      return {
        isLinked: false,
        chatId: null,
        pendingLink: {
          token: pendingLink.token,
          deepLink: this.getDeepLink(pendingLink.token),
          endAt: pendingLink.endAt,
        },
      };
    }

    return {
      isLinked: false,
      chatId: null,
    };
  }

  /**
   * 팀의 텔레그램 연동 해제
   * @param teamId 팀 ID
   */
  async unlinkTeam(teamId: number): Promise<void> {
    const team = await this.teamRepository.findOne({
      where: { teamId, actStatus: ActStatus.ACTIVE },
    });

    if (!team) {
      throw new Error('팀을 찾을 수 없습니다.');
    }

    // // chatId 제거
    // await this.teamRepository.update(
    //   { teamId },
    //   { telegramChatId: null },
    // );

    // // 관련 토큰 비활성화
    // await this.telegramLinkRepository.update(
    //   { teamId },
    //   { actStatus: ActStatus.INACTIVE },
    // );

    try {
      await this.dataSource.transaction(async (manager: EntityManager) => {
        await Promise.all([
          manager.update(Team, { teamId }, { telegramChatId: null }),
          manager.update(TelegramLink, { teamId }, { actStatus: ActStatus.INACTIVE }),
        ]);
      });
    } catch(err) {
      throw new Error('연동 해제 처리 중 오류가 발생했습니다.');
    }
    console.log(`[TELEGRAM] 팀 연동 해제. teamId: ${teamId}`);
  }

  /**
   * chatId로 팀 연동 해제 (봇이 그룹에서 제거될 때)
   * @param chatId 텔레그램 그룹 채팅 ID
   */
  private async unlinkTeamByChatId(chatId: number): Promise<void> {
    const team = await this.teamRepository.findOne({
      where: { telegramChatId: chatId, actStatus: ActStatus.ACTIVE },
    });

    if (team) {
      await this.teamRepository.update(
        { teamId: team.teamId },
        { telegramChatId: null },
      );
      console.log(`[TELEGRAM] chatId로 팀 연동 해제. teamId: ${team.teamId}, chatId: ${chatId}`);
    }
  }
}

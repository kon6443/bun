import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, MoreThan } from 'typeorm';
import { TelegramService, TelegramUpdate } from './telegram.service';
import { Team } from '../../entities/Team';
import { TelegramLink } from '../../entities/TelegramLink';
import { ActStatus } from '../../common/enums/task-status.enum';
import { createTeam, createTelegramLink } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { TeamNotFoundErrorResponseDto } from '../../common/dto/api-error.dto';
import {
  NotificationTelegramConfigErrorResponseDto,
  NotificationTelegramUnlinkErrorResponseDto,
} from './notification-error.dto';

const BOT_TOKEN = 'test-bot-token';
const BOT_USERNAME = 'test_bot';
const TEAM_ID = 7;
const CHAT_ID = -1001234567890;
const SEND_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

/**
 * 팀 ↔ 텔레그램 그룹 연동과 알림 전송을 담당한다.
 *
 * 두 축을 고정한다:
 *  1. **연동 무결성** — 한 팀이 여러 그룹에 물리거나, 남의 팀 토큰으로 그룹을 가로채지 못해야 한다.
 *     연동이 잘못 걸리면 팀 내부 알림(태스크·댓글 내용)이 엉뚱한 그룹으로 새어나간다.
 *  2. **전송 실패의 격리** — 알림 전송은 fire-and-forget이라 예외가 호출부로 올라가면
 *     텔레그램 장애가 태스크 생성 API 실패로 번진다.
 *
 * `botToken`·`botUsername`은 **생성자에서 읽으므로** 조합마다 인스턴스를 새로 만들어야 검증된다.
 */
describe('TelegramService', () => {
  let service: TelegramService;
  let telegramLinkRepository: MockRepository<TelegramLink>;
  let teamRepository: MockRepository<Team>;
  let manager: { update: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let fetchMock: jest.SpyInstance;

  /**
   * 옵션 객체로 받는다 — 기본값 파라미터로 만들면 `buildService(undefined)`가
   * "미설정"이 아니라 기본값으로 해석되어 테스트가 조용히 무력해진다.
   */
  const buildService = async (
    overrides: { botToken?: string; botUsername?: string } = {},
  ): Promise<TelegramService> => {
    const config: Record<string, string | undefined> = {
      BOT_TOKEN_TELEGRAM: 'botToken' in overrides ? overrides.botToken : BOT_TOKEN,
      BOT_USERNAME_TELEGRAM: 'botUsername' in overrides ? overrides.botUsername : BOT_USERNAME,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramService,
        { provide: getDataSourceToken(), useValue: dataSource as unknown as DataSource },
        { provide: getRepositoryToken(TelegramLink), useValue: telegramLinkRepository },
        { provide: getRepositoryToken(Team), useValue: teamRepository },
        { provide: ConfigService, useValue: { get: jest.fn((k: string) => config[k]) } },
      ],
    }).compile();

    const built = module.get(TelegramService);
    // 생성자의 "환경변수 미설정" 경고가 spy에 잡히므로 케이스 검증 전에 비운다
    (Logger.prototype.warn as jest.Mock).mockClear();
    return built;
  };

  /** 텔레그램 API 응답 고정 */
  const mockFetch = (ok = true, status = 200, body: unknown = { ok: true }) =>
    (fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok,
      status,
      json: jest.fn().mockResolvedValue(body),
    } as unknown as Response));

  /** sendMessageAsync가 보낸 body를 파싱해서 돌려준다 */
  const sentBody = (call = 0) =>
    JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;

  beforeEach(async () => {
    telegramLinkRepository = createMockRepository<TelegramLink>();
    teamRepository = createMockRepository<Team>();
    manager = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    dataSource = {
      transaction: jest.fn((cb: (m: EntityManager) => Promise<void>) =>
        cb(manager as unknown as EntityManager),
      ),
    };

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    mockFetch();
    service = await buildService();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('sendMessageAsync', () => {
    it.each([
      ['봇 토큰이 미설정이면', () => buildService({ botToken: undefined })],
      ['봇 토큰이 빈 문자열이면', () => buildService({ botToken: '' })],
    ])('%s 전송을 시도하지 않아야 함', async (_desc, build) => {
      const noToken = await build();

      await noToken.sendMessageAsync(CHAT_ID, '메시지');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['chatId가 없으면', 0, '메시지'],
      ['message가 비었으면', CHAT_ID, ''],
    ])('%s 전송을 시도하지 않아야 함', async (_desc, chatId, message) => {
      await service.sendMessageAsync(chatId, message);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('봇 토큰이 담긴 sendMessage 엔드포인트로 POST해야 함', async () => {
      await service.sendMessageAsync(CHAT_ID, '메시지');

      expect(fetchMock).toHaveBeenCalledWith(
        SEND_URL,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('HTML 파싱 모드로 본문을 구성해야 함', async () => {
      await service.sendMessageAsync(CHAT_ID, '<b>강조</b>');

      expect(sentBody()).toEqual({
        chat_id: CHAT_ID,
        text: '<b>강조</b>',
        parse_mode: 'HTML',
      });
    });

    it('버튼이 있으면 인라인 키보드 한 줄로 넣어야 함', async () => {
      await service.sendMessageAsync(CHAT_ID, '메시지', [
        { text: '바로가기', url: 'https://app.test/1' },
        { text: '목록', url: 'https://app.test' },
      ]);

      expect(sentBody().reply_markup).toEqual({
        inline_keyboard: [
          [
            { text: '바로가기', url: 'https://app.test/1' },
            { text: '목록', url: 'https://app.test' },
          ],
        ],
      });
    });

    it.each([
      ['버튼 미지정', undefined],
      ['빈 배열', []],
    ])('%s이면 reply_markup 키를 넣지 않아야 함', async (_desc, buttons) => {
      await service.sendMessageAsync(CHAT_ID, '메시지', buttons);

      // 빈 inline_keyboard를 보내면 텔레그램 API가 400으로 거부한다
      expect(sentBody()).not.toHaveProperty('reply_markup');
    });

    it('API가 실패 응답을 주면 상태 코드를 담아 예외를 던져야 함', async () => {
      mockFetch(false, 403, { description: 'bot was kicked' });

      await expect(service.sendMessageAsync(CHAT_ID, '메시지')).rejects.toThrow(/403/);
    });

    it('실패 응답의 본문이 JSON이 아니어도 예외를 던져야 함', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 502,
        json: jest.fn().mockRejectedValue(new Error('invalid json')),
      } as unknown as Response);

      await expect(service.sendMessageAsync(CHAT_ID, '메시지')).rejects.toThrow(/502/);
    });
  });

  describe('sendTeamNotification — 장애 격리', () => {
    const team = {
      teamId: TEAM_ID,
      teamName: '테스트팀',
      telegramChatId: CHAT_ID,
      discordWebhookUrl: null,
    };

    it('연동된 팀이면 채팅방으로 전송해야 함', async () => {
      await service.sendTeamNotification({ team, message: '알림' });

      expect(sentBody()).toMatchObject({ chat_id: CHAT_ID, text: '알림' });
    });

    it('연동되지 않은 팀이면 전송을 건너뛰어야 함', async () => {
      await service.sendTeamNotification({
        team: { ...team, telegramChatId: null },
        message: '알림',
      });

      expect(fetchMock).not.toHaveBeenCalled();
      // 조용히 넘어가면 "왜 알림이 안 오지"를 추적할 수 없다
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });

    it('전송이 실패해도 예외를 전파하지 않아야 함', async () => {
      mockFetch(false, 403, { description: 'bot was kicked' });

      // 예외가 올라가면 텔레그램 장애가 태스크 생성 API 실패로 번진다
      await expect(service.sendTeamNotification({ team, message: '알림' })).resolves.toBeUndefined();
      expect(Logger.prototype.error).toHaveBeenCalled();
    });

    it('네트워크 자체가 끊겨도 예외를 전파하지 않아야 함', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.sendTeamNotification({ team, message: '알림' })).resolves.toBeUndefined();
    });
  });

  describe('generateLinkToken', () => {
    beforeEach(() => {
      telegramLinkRepository.create.mockImplementation((data) => data as TelegramLink);
      telegramLinkRepository.save.mockImplementation((entity) =>
        Promise.resolve(entity as TelegramLink),
      );
    });

    it('기존 활성 토큰을 모두 무효화한 뒤 발급해야 함', async () => {
      await service.generateLinkToken(TEAM_ID);

      // 남겨두면 옛 딥링크로도 연동이 가능해 회수가 안 된다
      expect(telegramLinkRepository.update).toHaveBeenCalledWith(
        { teamId: TEAM_ID, actStatus: ActStatus.ACTIVE },
        { actStatus: ActStatus.INACTIVE },
      );
      expect(telegramLinkRepository.update.mock.invocationCallOrder[0]).toBeLessThan(
        telegramLinkRepository.save.mock.invocationCallOrder[0],
      );
    });

    it('64자 hex 토큰을 활성 상태로 저장해야 함', async () => {
      const result = await service.generateLinkToken(TEAM_ID);

      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(telegramLinkRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: TEAM_ID, actStatus: ActStatus.ACTIVE }),
      );
    });

    it('호출할 때마다 다른 토큰이어야 함', async () => {
      const first = await service.generateLinkToken(TEAM_ID);
      const second = await service.generateLinkToken(TEAM_ID);

      expect(first.token).not.toBe(second.token);
    });

    it('만료를 24시간 뒤로 잡아야 함', async () => {
      const before = Date.now();

      const result = await service.generateLinkToken(TEAM_ID);

      const expected = before + 24 * 60 * 60 * 1000;
      // 실행 시간 오차를 감안해 ±5초 이내인지 확인
      expect(Math.abs(result.endAt.getTime() - expected)).toBeLessThan(5_000);
    });

    it('그룹 추가용 딥링크를 함께 반환해야 함', async () => {
      const result = await service.generateLinkToken(TEAM_ID);

      expect(result.deepLink).toBe(`https://t.me/${BOT_USERNAME}?startgroup=${result.token}`);
    });
  });

  describe('getDeepLink', () => {
    it('봇 사용자명이 없으면 설정 오류를 던져야 함', async () => {
      const noUsername = await buildService({ botUsername: '' });

      expect(() => noUsername.getDeepLink('tok')).toThrow(
        NotificationTelegramConfigErrorResponseDto,
      );
      // 구체 원인은 서버 로그에만 남긴다
      expect(Logger.prototype.error).toHaveBeenCalled();
    });

    it('startgroup 파라미터로 토큰을 실어야 함', () => {
      expect(service.getDeepLink('tok123')).toBe(
        `https://t.me/${BOT_USERNAME}?startgroup=tok123`,
      );
    });
  });

  describe('verifyAndLinkTeam — 연동 무결성', () => {
    const link = createTelegramLink({ linkId: 5, teamId: TEAM_ID, token: 'tok' });

    it('유효한 토큰만 조회해야 함 (활성 + 미만료)', async () => {
      telegramLinkRepository.findOne.mockResolvedValue(null);

      await service.verifyAndLinkTeam('tok', CHAT_ID);

      expect(telegramLinkRepository.findOne).toHaveBeenCalledWith({
        where: { token: 'tok', actStatus: ActStatus.ACTIVE, endAt: MoreThan(expect.any(Date)) },
      });
    });

    it('토큰이 없거나 만료면 실패를 반환해야 함', async () => {
      telegramLinkRepository.findOne.mockResolvedValue(null);

      await expect(service.verifyAndLinkTeam('tok', CHAT_ID)).resolves.toEqual({
        success: false,
        message: '유효하지 않거나 만료된 토큰입니다.',
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('팀이 없거나 비활성이면 실패를 반환해야 함', async () => {
      telegramLinkRepository.findOne.mockResolvedValue(link);
      teamRepository.findOne.mockResolvedValue(null);

      await expect(service.verifyAndLinkTeam('tok', CHAT_ID)).resolves.toMatchObject({
        success: false,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('이미 다른 그룹과 연동된 팀이면 거부해야 함', async () => {
      telegramLinkRepository.findOne.mockResolvedValue(link);
      teamRepository.findOne.mockResolvedValue(
        createTeam({ teamId: TEAM_ID, telegramChatId: -999 }),
      );

      // 덮어쓰면 기존 그룹이 조용히 알림을 잃고, 새 그룹이 팀 내부 내용을 보게 된다
      await expect(service.verifyAndLinkTeam('tok', CHAT_ID)).resolves.toEqual({
        success: false,
        message: '이 팀은 이미 다른 텔레그램 그룹과 연동되어 있습니다.',
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('같은 그룹이면 재연동을 허용해야 함', async () => {
      telegramLinkRepository.findOne.mockResolvedValue(link);
      teamRepository.findOne.mockResolvedValue(
        createTeam({ teamId: TEAM_ID, telegramChatId: CHAT_ID, teamName: '테스트팀' }),
      );

      await expect(service.verifyAndLinkTeam('tok', CHAT_ID)).resolves.toEqual({
        success: true,
        message: '연동이 완료되었습니다.',
        teamName: '테스트팀',
      });
    });

    it('팀의 chatId 저장과 토큰 소진을 한 트랜잭션에서 처리해야 함', async () => {
      telegramLinkRepository.findOne.mockResolvedValue(link);
      teamRepository.findOne.mockResolvedValue(createTeam({ teamId: TEAM_ID }));

      await service.verifyAndLinkTeam('tok', CHAT_ID);

      // 둘이 갈라지면 "연동됐는데 토큰이 살아있는" 상태가 생겨 재사용이 가능해진다
      expect(manager.update).toHaveBeenCalledWith(
        Team,
        { teamId: TEAM_ID },
        { telegramChatId: CHAT_ID },
      );
      expect(manager.update).toHaveBeenCalledWith(
        TelegramLink,
        { linkId: 5 },
        expect.objectContaining({ usedAt: expect.any(Date), actStatus: ActStatus.INACTIVE }),
      );
    });

    it('트랜잭션이 실패하면 예외 대신 실패 결과를 반환해야 함', async () => {
      telegramLinkRepository.findOne.mockResolvedValue(link);
      teamRepository.findOne.mockResolvedValue(createTeam({ teamId: TEAM_ID }));
      dataSource.transaction.mockRejectedValue(new Error('ORA-00001'));

      // 이 결과는 webhook 응답으로 사용자에게 그대로 전달된다
      await expect(service.verifyAndLinkTeam('tok', CHAT_ID)).resolves.toEqual({
        success: false,
        message: '연동 처리 중 오류가 발생했습니다.',
      });
    });
  });

  describe('handleWebhook', () => {
    const chatMemberUpdate = (status: string): TelegramUpdate => ({
      update_id: 1,
      my_chat_member: {
        chat: { id: CHAT_ID, title: '팀 그룹', type: 'group' },
        from: { id: 1, first_name: '사용자' },
        date: 0,
        old_chat_member: { user: { id: 2 }, status: 'left' },
        new_chat_member: { user: { id: 2 }, status },
      },
    });

    const startCommand = (text: string): TelegramUpdate => ({
      update_id: 1,
      message: {
        chat: { id: CHAT_ID, type: 'group' },
        text,
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    });

    it.each([['member'], ['administrator']])(
      '봇이 %s로 그룹에 추가되면 /start를 기다려야 함',
      async (status) => {
        await expect(service.handleWebhook(chatMemberUpdate(status))).resolves.toMatchObject({
          success: true,
        });
        expect(teamRepository.update).not.toHaveBeenCalled();
      },
    );

    it.each([['left'], ['kicked']])(
      '봇이 %s 상태가 되면 해당 그룹의 연동을 해제해야 함',
      async (status) => {
        teamRepository.findOne.mockResolvedValue(createTeam({ teamId: TEAM_ID }));

        await service.handleWebhook(chatMemberUpdate(status));

        // 해제하지 않으면 죽은 그룹으로 계속 전송을 시도한다
        expect(teamRepository.findOne).toHaveBeenCalledWith({
          where: { telegramChatId: CHAT_ID, actStatus: ActStatus.ACTIVE },
        });
        expect(teamRepository.update).toHaveBeenCalledWith(
          { teamId: TEAM_ID },
          { telegramChatId: null },
        );
      },
    );

    it('연동된 팀이 없으면 해제를 시도하지 않아야 함', async () => {
      teamRepository.findOne.mockResolvedValue(null);

      await expect(service.handleWebhook(chatMemberUpdate('kicked'))).resolves.toMatchObject({
        success: true,
      });
      expect(teamRepository.update).not.toHaveBeenCalled();
    });

    it('/start 토큰이 유효하면 연동하고 팀 이름을 안내해야 함', async () => {
      jest
        .spyOn(service, 'verifyAndLinkTeam')
        .mockResolvedValue({ success: true, message: 'ok', teamName: '테스트팀' });

      const result = await service.handleWebhook(startCommand('/start tok123'));

      expect(service.verifyAndLinkTeam).toHaveBeenCalledWith('tok123', CHAT_ID);
      expect(result).toMatchObject({ success: true });
      expect(sentBody().text).toContain('테스트팀');
    });

    it('/start 토큰이 무효하면 실패 사유를 알려야 함', async () => {
      jest
        .spyOn(service, 'verifyAndLinkTeam')
        .mockResolvedValue({ success: false, message: '만료된 토큰입니다.' });

      await service.handleWebhook(startCommand('/start tok123'));

      // 침묵하면 사용자가 왜 연동이 안 되는지 알 수 없다
      expect(sentBody().text).toContain('만료된 토큰입니다.');
    });

    it('토큰 없는 /start면 안내만 하고 연동을 시도하지 않아야 함', async () => {
      const spy = jest.spyOn(service, 'verifyAndLinkTeam');

      await expect(service.handleWebhook(startCommand('/start'))).resolves.toMatchObject({
        success: true,
        message: '토큰 없는 /start 명령',
      });
      expect(spy).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalled();
    });

    it('bot_command 엔티티가 없으면 일반 메시지로 무시해야 함', async () => {
      const update: TelegramUpdate = {
        update_id: 1,
        message: { chat: { id: CHAT_ID, type: 'group' }, text: '/start tok123' },
      };

      await expect(service.handleWebhook(update)).resolves.toEqual({
        success: true,
        message: '처리할 이벤트 없음',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('다루지 않는 이벤트는 성공으로 무시해야 함', async () => {
      await expect(service.handleWebhook({ update_id: 1 })).resolves.toEqual({
        success: true,
        message: '처리할 이벤트 없음',
      });
    });
  });

  describe('getLinkStatus', () => {
    it('팀이 없으면 404를 던져야 함', async () => {
      teamRepository.findOne.mockResolvedValue(null);

      await expect(service.getLinkStatus(TEAM_ID)).rejects.toThrow(TeamNotFoundErrorResponseDto);
    });

    it('이미 연동됐으면 대기 토큰을 조회하지 않아야 함', async () => {
      teamRepository.findOne.mockResolvedValue(createTeam({ telegramChatId: CHAT_ID }));

      await expect(service.getLinkStatus(TEAM_ID)).resolves.toEqual({
        isLinked: true,
        chatId: CHAT_ID,
      });
      expect(telegramLinkRepository.findOne).not.toHaveBeenCalled();
    });

    it('대기 중인 토큰이 있으면 딥링크와 함께 반환해야 함', async () => {
      teamRepository.findOne.mockResolvedValue(createTeam({ telegramChatId: null }));
      const pending = createTelegramLink({ token: 'pending-tok' });
      telegramLinkRepository.findOne.mockResolvedValue(pending);

      await expect(service.getLinkStatus(TEAM_ID)).resolves.toEqual({
        isLinked: false,
        chatId: null,
        pendingLink: {
          token: 'pending-tok',
          deepLink: `https://t.me/${BOT_USERNAME}?startgroup=pending-tok`,
          endAt: pending.endAt,
        },
      });
    });

    it('대기 토큰은 최신 것을 활성·미만료 조건으로 찾아야 함', async () => {
      teamRepository.findOne.mockResolvedValue(createTeam({ telegramChatId: null }));
      telegramLinkRepository.findOne.mockResolvedValue(null);

      await service.getLinkStatus(TEAM_ID);

      expect(telegramLinkRepository.findOne).toHaveBeenCalledWith({
        where: {
          teamId: TEAM_ID,
          actStatus: ActStatus.ACTIVE,
          endAt: MoreThan(expect.any(Date)),
        },
        order: { crtdAt: 'DESC' },
      });
    });

    it('연동도 대기 토큰도 없으면 미연동 상태를 반환해야 함', async () => {
      teamRepository.findOne.mockResolvedValue(createTeam({ telegramChatId: null }));
      telegramLinkRepository.findOne.mockResolvedValue(null);

      await expect(service.getLinkStatus(TEAM_ID)).resolves.toEqual({
        isLinked: false,
        chatId: null,
      });
    });
  });

  describe('unlinkTeam', () => {
    it('팀이 없으면 404를 던져야 함', async () => {
      teamRepository.findOne.mockResolvedValue(null);

      await expect(service.unlinkTeam(TEAM_ID)).rejects.toThrow(TeamNotFoundErrorResponseDto);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('chatId 제거와 토큰 무효화를 한 트랜잭션에서 처리해야 함', async () => {
      teamRepository.findOne.mockResolvedValue(createTeam({ teamId: TEAM_ID }));

      await service.unlinkTeam(TEAM_ID);

      expect(manager.update).toHaveBeenCalledWith(Team, { teamId: TEAM_ID }, { telegramChatId: null });
      // 토큰을 남기면 해제 직후 옛 딥링크로 재연동될 수 있다
      expect(manager.update).toHaveBeenCalledWith(
        TelegramLink,
        { teamId: TEAM_ID },
        { actStatus: ActStatus.INACTIVE },
      );
    });

    it('트랜잭션이 실패하면 해제 오류를 던져야 함', async () => {
      teamRepository.findOne.mockResolvedValue(createTeam({ teamId: TEAM_ID }));
      dataSource.transaction.mockRejectedValue(new Error('ORA-00060'));

      // 연동(verifyAndLinkTeam)은 결과를 반환하지만 해제는 throw한다 —
      // 해제는 사용자가 명시적으로 요청한 HTTP 액션이라 실패를 알려야 한다
      await expect(service.unlinkTeam(TEAM_ID)).rejects.toThrow(
        NotificationTelegramUnlinkErrorResponseDto,
      );
    });
  });
});

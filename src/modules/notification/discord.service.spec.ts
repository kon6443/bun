import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DiscordService } from './discord.service';
import { Team } from '../../entities/Team';
import { ActStatus } from '../../common/enums/task-status.enum';
import { createTeam } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { TeamNotFoundErrorResponseDto } from '../../common/dto/api-error.dto';

const TEAM_ID = 7;
const WEBHOOK = 'https://discord.com/api/webhooks/123/abc';

/**
 * 디스코드 알림 채널. 텔레그램과 달리 **팀이 직접 입력한 URL로 서버가 요청을 보낸다** —
 * 그래서 이 서비스의 핵심은 전송이 아니라 `validateWebhookUrl`의 도메인 검증이다.
 *
 * 검증이 뚫리면 저장된 URL이 그대로 알림 전송 대상이 되므로, 서버가 임의 주소로
 * POST를 보내는 통로(SSRF)가 된다. 내부망 주소를 넣으면 팀 알림 내용이 그쪽으로 나간다.
 * 컨트롤러가 `validateWebhookUrl` → 실패 시 400 → `saveWebhookUrl` 순으로 호출하므로
 * (team.controller.ts:708-713) 이 함수가 유일한 관문이다.
 */
describe('DiscordService', () => {
  let service: DiscordService;
  let teamRepository: MockRepository<Team>;
  let fetchMock: jest.SpyInstance;

  /** 디스코드 API 응답 고정 */
  const mockFetch = (ok = true, status = 200, body: unknown = { name: '알림채널' }) =>
    (fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok,
      status,
      json: jest.fn().mockResolvedValue(body),
      text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response));

  /** sendWebhookMessage가 보낸 body를 파싱해서 돌려준다 */
  const sentBody = () =>
    JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;

  beforeEach(async () => {
    teamRepository = createMockRepository<Team>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscordService,
        { provide: getRepositoryToken(Team), useValue: teamRepository },
      ],
    }).compile();

    service = module.get(DiscordService);

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    mockFetch();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('validateWebhookUrl — 도메인 검증 (SSRF 관문)', () => {
    it.each([
      ['discord.com', 'https://discord.com/api/webhooks/123/abc'],
      ['discordapp.com (구 도메인)', 'https://discordapp.com/api/webhooks/123/abc'],
    ])('%s의 webhook URL은 허용해야 함', async (_desc, url) => {
      await expect(service.validateWebhookUrl(url)).resolves.toEqual({
        valid: true,
        name: '알림채널',
      });
    });

    it.each([
      ['임의 외부 도메인', 'https://evil.test/api/webhooks/123/abc'],
      ['서브도메인 위장', 'https://discord.com.evil.test/api/webhooks/123/abc'],
      ['인증정보 위장', 'https://discord.com@evil.test/api/webhooks/123/abc'],
      ['평문 http', 'http://discord.com/api/webhooks/123/abc'],
      ['경로가 다름', 'https://discord.com/api/oauth2/authorize'],
      ['내부망 주소', 'http://169.254.169.254/latest/meta-data/'],
      ['로컬호스트', 'http://localhost:3500/api/v1/teams'],
      ['빈 문자열', ''],
    ])('%s은 거부하고 요청조차 보내지 않아야 함', async (_desc, url) => {
      await expect(service.validateWebhookUrl(url)).resolves.toEqual({ valid: false });
      // 검증 전에 fetch하면 그 자체가 SSRF다 — 응답을 안 써도 요청은 이미 나간 것
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('도메인이 맞으면 GET으로 존재를 확인해야 함', async () => {
      await service.validateWebhookUrl(WEBHOOK);

      expect(fetchMock).toHaveBeenCalledWith(WEBHOOK, { method: 'GET' });
    });

    it('디스코드가 404를 주면 무효로 판정해야 함 (삭제된 webhook)', async () => {
      mockFetch(false, 404);

      await expect(service.validateWebhookUrl(WEBHOOK)).resolves.toEqual({ valid: false });
    });

    it('채널 이름이 없어도 유효로 판정해야 함', async () => {
      mockFetch(true, 200, {});

      await expect(service.validateWebhookUrl(WEBHOOK)).resolves.toEqual({
        valid: true,
        name: undefined,
      });
    });

    it('네트워크 오류는 무효로 처리해야 함', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.validateWebhookUrl(WEBHOOK)).resolves.toEqual({ valid: false });
    });
  });

  describe('sendWebhookMessage', () => {
    it.each([
      ['webhookUrl이 없으면', '', '메시지'],
      ['content가 비었으면', WEBHOOK, ''],
    ])('%s 전송하지 않아야 함', async (_desc, url, content) => {
      await service.sendWebhookMessage(url, content);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });

    it('JSON 본문으로 POST해야 함', async () => {
      await service.sendWebhookMessage(WEBHOOK, '알림 내용');

      expect(fetchMock).toHaveBeenCalledWith(
        WEBHOOK,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(sentBody()).toEqual({ content: '알림 내용' });
    });

    it('embed가 있으면 함께 보내야 함', async () => {
      const embeds = [{ title: '태스크', description: '설명' }];

      await service.sendWebhookMessage(WEBHOOK, '알림 내용', embeds);

      expect(sentBody()).toEqual({ content: '알림 내용', embeds });
    });

    it.each([
      ['embed 미지정', undefined],
      ['빈 배열', []],
    ])('%s이면 embeds 키를 넣지 않아야 함', async (_desc, embeds) => {
      await service.sendWebhookMessage(WEBHOOK, '알림 내용', embeds);

      // 빈 embeds 배열은 디스코드가 400으로 거부한다
      expect(sentBody()).not.toHaveProperty('embeds');
    });

    it('실패 응답은 상태 코드를 담아 예외를 던져야 함', async () => {
      mockFetch(false, 401, 'Unauthorized');

      await expect(service.sendWebhookMessage(WEBHOOK, '알림')).rejects.toThrow(/401/);
    });

    it('실패 응답의 본문을 읽지 못해도 예외를 던져야 함', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        text: jest.fn().mockRejectedValue(new Error('stream error')),
      } as unknown as Response);

      await expect(service.sendWebhookMessage(WEBHOOK, '알림')).rejects.toThrow(/500/);
    });
  });

  describe('sendTeamNotification — 장애 격리', () => {
    const team = {
      teamId: TEAM_ID,
      teamName: '테스트팀',
      telegramChatId: null,
      discordWebhookUrl: WEBHOOK,
    };

    it('연동되지 않은 팀이면 전송을 건너뛰어야 함', async () => {
      await service.sendTeamNotification({
        team: { ...team, discordWebhookUrl: null },
        content: '알림',
      });

      expect(fetchMock).not.toHaveBeenCalled();
      // 조용히 넘어가면 "왜 알림이 안 오지"를 추적할 수 없다
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });

    it('url이 있으면 마크다운 링크를 덧붙여야 함', async () => {
      await service.sendTeamNotification({
        team,
        content: '태스크가 생성되었습니다',
        url: 'https://app.test/tasks/1',
      });

      // 디스코드는 인라인 버튼이 없어 본문에 링크를 넣는다 (텔레그램과의 차이)
      expect(sentBody().content).toBe(
        '태스크가 생성되었습니다\n\n[바로가기](https://app.test/tasks/1)',
      );
    });

    it('url이 없으면 본문을 그대로 보내야 함', async () => {
      await service.sendTeamNotification({ team, content: '태스크가 생성되었습니다' });

      expect(sentBody().content).toBe('태스크가 생성되었습니다');
    });

    it('embed를 그대로 전달해야 함', async () => {
      const embeds = [{ title: '태스크' }];

      await service.sendTeamNotification({ team, content: '알림', embeds });

      expect(sentBody().embeds).toEqual(embeds);
    });

    it.each([
      ['Webhook 오류 응답', () => mockFetch(false, 404, 'Not Found')],
      ['네트워크 단절', () => jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNRESET'))],
    ])('%s이어도 예외를 전파하지 않아야 함', async (_desc, arrange) => {
      arrange();

      // 예외가 올라가면 디스코드 장애가 태스크 생성 API 실패로 번진다
      await expect(
        service.sendTeamNotification({ team, content: '알림' }),
      ).resolves.toBeUndefined();
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });

  describe('연동 관리', () => {
    it.each([
      ['saveWebhookUrl', () => service.saveWebhookUrl(TEAM_ID, WEBHOOK)],
      ['getLinkStatus', () => service.getLinkStatus(TEAM_ID)],
      ['unlinkTeam', () => service.unlinkTeam(TEAM_ID)],
    ])('%s는 팀이 없거나 비활성이면 404를 던져야 함', async (_name, run) => {
      teamRepository.findOne.mockResolvedValue(null);

      await expect(run()).rejects.toThrow(TeamNotFoundErrorResponseDto);
      expect(teamRepository.update).not.toHaveBeenCalled();
    });

    it('활성 팀만 조회 대상이어야 함', async () => {
      teamRepository.findOne.mockResolvedValue(createTeam({ teamId: TEAM_ID }));

      await service.getLinkStatus(TEAM_ID);

      expect(teamRepository.findOne).toHaveBeenCalledWith({
        where: { teamId: TEAM_ID, actStatus: ActStatus.ACTIVE },
      });
    });

    it('Webhook URL을 해당 팀에만 저장해야 함', async () => {
      teamRepository.findOne.mockResolvedValue(createTeam({ teamId: TEAM_ID }));

      await service.saveWebhookUrl(TEAM_ID, WEBHOOK);

      expect(teamRepository.update).toHaveBeenCalledWith(
        { teamId: TEAM_ID },
        { discordWebhookUrl: WEBHOOK },
      );
    });

    it('이미 연동된 팀도 새 URL로 덮어쓸 수 있어야 함 (채널 이전)', async () => {
      teamRepository.findOne.mockResolvedValue(
        createTeam({ teamId: TEAM_ID, discordWebhookUrl: 'https://discord.com/api/webhooks/old' }),
      );

      await expect(service.saveWebhookUrl(TEAM_ID, WEBHOOK)).resolves.toBeUndefined();
      expect(teamRepository.update).toHaveBeenCalledWith(
        { teamId: TEAM_ID },
        { discordWebhookUrl: WEBHOOK },
      );
    });

    it.each([
      ['연동됨', WEBHOOK, true],
      ['미연동', null, false],
    ])('연동 상태가 %s이면 isLinked=%s여야 함', async (_desc, webhookUrl, isLinked) => {
      teamRepository.findOne.mockResolvedValue(
        createTeam({ teamId: TEAM_ID, discordWebhookUrl: webhookUrl }),
      );

      await expect(service.getLinkStatus(TEAM_ID)).resolves.toEqual({
        isLinked,
        webhookUrl,
      });
    });

    it('해제하면 URL을 null로 비워야 함', async () => {
      teamRepository.findOne.mockResolvedValue(
        createTeam({ teamId: TEAM_ID, discordWebhookUrl: WEBHOOK }),
      );

      await service.unlinkTeam(TEAM_ID);

      expect(teamRepository.update).toHaveBeenCalledWith(
        { teamId: TEAM_ID },
        { discordWebhookUrl: null },
      );
    });
  });
});

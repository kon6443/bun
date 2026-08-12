import { Test, TestingModule } from '@nestjs/testing';
import { NotificationAdapter } from './notification.adapter';
import { TelegramService } from './telegram.service';
import { DiscordService } from './discord.service';
import type { NotificationTeamInfo } from '../../common/port/notification.port';

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
describe('NotificationAdapter', () => {
  let adapter: NotificationAdapter;
  let telegramService: { sendTeamNotification: jest.Mock };
  let discordService: { sendTeamNotification: jest.Mock };

  beforeEach(async () => {
    telegramService = { sendTeamNotification: jest.fn().mockResolvedValue(undefined) };
    discordService = { sendTeamNotification: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationAdapter,
        { provide: TelegramService, useValue: telegramService },
        { provide: DiscordService, useValue: discordService },
      ],
    }).compile();

    adapter = module.get(NotificationAdapter);
  });

  afterEach(() => jest.restoreAllMocks());

  it('한 번의 호출로 텔레그램과 디스코드 양쪽에 보내야 함', () => {
    adapter.notifyTeam({ team: TEAM, message: '알림 내용' });

    expect(telegramService.sendTeamNotification).toHaveBeenCalledTimes(1);
    expect(discordService.sendTeamNotification).toHaveBeenCalledTimes(1);
  });

  it('채널마다 다른 파라미터 이름으로 변환해 전달해야 함', () => {
    adapter.notifyTeam({ team: TEAM, message: '알림 내용' });

    // 텔레그램은 message, 디스코드는 content — 이름이 어긋나면 빈 알림이 나간다
    expect(telegramService.sendTeamNotification).toHaveBeenCalledWith({
      team: TEAM,
      message: '알림 내용',
    });
    expect(discordService.sendTeamNotification).toHaveBeenCalledWith({
      team: TEAM,
      content: '알림 내용',
      url: undefined,
    });
  });

  it('url이 있으면 텔레그램에는 버튼으로, 디스코드에는 url로 전달해야 함', () => {
    adapter.notifyTeam({ team: TEAM, message: '알림 내용', url: 'https://app.test/tasks/1' });

    expect(telegramService.sendTeamNotification).toHaveBeenCalledWith({
      team: TEAM,
      message: '알림 내용',
      buttons: [{ text: '바로가기', url: 'https://app.test/tasks/1' }],
    });
    expect(discordService.sendTeamNotification).toHaveBeenCalledWith({
      team: TEAM,
      content: '알림 내용',
      url: 'https://app.test/tasks/1',
    });
  });

  it.each([
    ['url 미지정', undefined],
    ['빈 문자열', ''],
  ])('%s이면 텔레그램에 buttons 키 자체를 넣지 않아야 함', (_desc, url) => {
    adapter.notifyTeam({ team: TEAM, message: '알림 내용', url });

    const [payload] = telegramService.sendTeamNotification.mock.calls[0];
    // buttons: undefined를 넘기는 것과 다르다 — 빈 버튼 배열이 붙으면 텔레그램 API가 거부한다
    expect(payload).not.toHaveProperty('buttons');
  });

  it('전송 완료를 기다리지 않고 즉시 반환해야 함 (fire-and-forget)', () => {
    // 응답이 오지 않는 채널이 있어도 호출부가 멈추면 안 된다
    telegramService.sendTeamNotification.mockReturnValue(new Promise(() => {}));
    discordService.sendTeamNotification.mockReturnValue(new Promise(() => {}));

    expect(adapter.notifyTeam({ team: TEAM, message: '알림 내용' })).toBeUndefined();
    expect(discordService.sendTeamNotification).toHaveBeenCalled();
  });

  it('연동 정보가 없는 팀이어도 두 채널을 그대로 호출해야 함 (판단은 각 서비스 책임)', () => {
    const emptyTeam: NotificationTeamInfo = {
      teamId: 2,
      teamName: '미연동팀',
      telegramChatId: null,
      discordWebhookUrl: null,
    };

    adapter.notifyTeam({ team: emptyTeam, message: '알림 내용' });

    // Adapter가 미리 걸러내면 "연동 안 됨" 경고 로그가 사라져 원인 추적이 어려워진다
    expect(telegramService.sendTeamNotification).toHaveBeenCalledWith(
      expect.objectContaining({ team: emptyTeam }),
    );
    expect(discordService.sendTeamNotification).toHaveBeenCalledWith(
      expect.objectContaining({ team: emptyTeam }),
    );
  });
});

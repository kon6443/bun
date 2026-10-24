import { GameViewService } from './game-view.service';

/**
 * GameViewService — 리플레이 조회수·시청시간의 시청자(IP 해시)별 하루 상한 (docs/tasks/replay-views D-002·D-004).
 *
 * INCRBY + 첫 기록 때만 24시간 TTL(EXPIRE NX). 조회수는 부가 기능이라 Redis를 못 쓰면 상한 없이 반영한다(fail-open).
 */
describe('GameViewService', () => {
  let service: GameViewService;
  let redis: { status: string; multi: jest.Mock };
  let multi: { incrby: jest.Mock; expire: jest.Mock; exec: jest.Mock };
  const total = (value: number) => multi.exec.mockResolvedValueOnce([[null, value], [null, 1]]);

  beforeEach(() => {
    service = new GameViewService();
    multi = { incrby: jest.fn(), expire: jest.fn(), exec: jest.fn() };
    multi.incrby.mockReturnValue(multi);
    multi.expire.mockReturnValue(multi);
    redis = { status: 'ready', multi: jest.fn(() => multi) };
    service.setRedisClient(redis as never);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('claimView', () => {
    it('기록·시청자별 키에 1을 더하고 TTL은 첫 기록 때만 24시간 — 상한(5) 이하면 true', async () => {
      total(5);

      await expect(service.claimView(41, 'hash')).resolves.toBe(true);
      expect(multi.incrby).toHaveBeenCalledWith('game:view:41:hash', 1);
      expect(multi.expire).toHaveBeenCalledWith('game:view:41:hash', 86_400, 'NX');
    });

    it('상한을 넘으면 false', async () => {
      total(6);

      await expect(service.claimView(41, 'hash')).resolves.toBe(false);
    });
  });

  describe('claimWatchMs', () => {
    it.each([
      ['상한 안', 30_000, 30_000, 30_000],
      ['이번 보고로 상한을 넘으면 남은 몫만', 70_000, 30_000, 20_000],
      ['이미 상한을 넘었으면 0', 120_000, 30_000, 0],
    ])('%s', async (_name, after, watchedMs, expected) => {
      total(after);

      await expect(service.claimWatchMs(41, 'hash', watchedMs, 60_000)).resolves.toBe(expected);
      expect(multi.incrby).toHaveBeenCalledWith('game:watch:41:hash', watchedMs);
    });
  });

  describe('Redis를 못 쓰면 상한 없이 반영한다', () => {
    it('연결 전·끊김', async () => {
      redis.status = 'reconnecting';

      await expect(service.claimView(41, 'hash')).resolves.toBe(true);
      await expect(service.claimWatchMs(41, 'hash', 30_000, 60_000)).resolves.toBe(30_000);
      expect(redis.multi).not.toHaveBeenCalled();
    });

    it('명령 오류', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      multi.exec.mockRejectedValue(new Error('down'));

      await expect(service.claimView(41, 'hash')).resolves.toBe(true);
      await expect(service.claimWatchMs(41, 'hash', 30_000, 60_000)).resolves.toBe(30_000);
    });
  });
});

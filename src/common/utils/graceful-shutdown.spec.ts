import { closeAppThenRedis } from './graceful-shutdown';

describe('closeAppThenRedis', () => {
  afterEach(() => jest.useRealTimers());

  it('앱(소켓 서버)을 먼저 닫고, 정리 대기 뒤 Redis를 닫는다', async () => {
    jest.useFakeTimers();
    const order: string[] = [];
    const app = { close: jest.fn(async () => void order.push('app.close')) };
    const redis = { disconnect: jest.fn(async () => void order.push('redis.disconnect')) };

    const done = closeAppThenRedis(app, redis, 1_000);
    await jest.advanceTimersByTimeAsync(999);
    expect(order).toEqual(['app.close']); // 정리 대기 중엔 Redis를 닫지 않는다

    await jest.advanceTimersByTimeAsync(1);
    await done;
    expect(order).toEqual(['app.close', 'redis.disconnect']);
  });

  it('앱 닫기가 실패하면 그 에러를 올린다(호출한 쪽이 실패 종료)', async () => {
    const redis = { disconnect: jest.fn() };
    await expect(closeAppThenRedis({ close: () => Promise.reject(new Error('boom')) }, redis, 0)).rejects.toThrow('boom');
  });
});

import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisIoAdapter } from './redis-io.adapter';

describe('RedisIoAdapter.disconnect', () => {
  const createAdapter = () => {
    const app = { get: () => ({ get: () => undefined }) as unknown as ConfigService } as unknown as INestApplication;
    const adapter = new RedisIoAdapter(app);
    const clients = adapter as unknown as Record<'pubClient' | 'subClient', { status: string; quit: jest.Mock; disconnect: jest.Mock }>;
    for (const key of ['pubClient', 'subClient'] as const) {
      Object.assign(clients[key], { quit: jest.fn().mockResolvedValue('OK'), disconnect: jest.fn() });
    }
    return { adapter, pub: clients.pubClient, sub: clients.subClient };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('연결돼 있으면 quit으로 닫는다 (보낸 명령을 마저 처리)', async () => {
    const { adapter, pub, sub } = createAdapter();
    pub.status = 'ready';
    sub.status = 'ready';

    await adapter.disconnect();

    expect(pub.quit).toHaveBeenCalled();
    expect(sub.quit).toHaveBeenCalled();
    expect(pub.disconnect).not.toHaveBeenCalled();
  });

  it('재연결 중이면 바로 끊는다 — quit은 오프라인 큐에서 재연결을 기다려 종료가 멈춘다', async () => {
    const { adapter, pub, sub } = createAdapter();
    pub.status = 'reconnecting';
    sub.status = 'reconnecting';

    await adapter.disconnect();

    expect(pub.disconnect).toHaveBeenCalled();
    expect(sub.disconnect).toHaveBeenCalled();
    expect(pub.quit).not.toHaveBeenCalled();
  });
});

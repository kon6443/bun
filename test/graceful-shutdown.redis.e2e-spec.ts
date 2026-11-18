import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { Redis } from 'ioredis';
import { AddressInfo } from 'net';
import { io, Socket } from 'socket.io-client';
import { RedisIoAdapter } from '../src/common/adapters/redis-io.adapter';
import { closeAppThenRedis } from '../src/common/utils/graceful-shutdown';

/**
 * 종료 순서(main.ts shutdown → closeAppThenRedis)를 실제 Redis로 검증한다 — **opt-in**.
 *
 * CI·기본 E2E에는 Redis가 없으므로 `SHUTDOWN_REDIS_TEST_PORT`가 있을 때만 돈다.
 * 로컬: `SHUTDOWN_REDIS_TEST_PORT=6380 pnpm test:e2e -- --testPathPatterns graceful-shutdown`
 * (`shutdown-probe:*` 키만 쓰고 끝에서 지운다. 운영 Redis를 가리키지 말 것.)
 *
 * 실제 RedisIoAdapter(@socket.io/redis-adapter)와 Nest 소켓 서버로 본다 — 어댑터의 구독 해제가 await되지 않는 것,
 * 연결 해제 핸들러가 비동기라 소켓 서버 종료가 기다려 주지 않는 것은 mock으로 재현되지 않는다.
 */
const port = Number(process.env.SHUTDOWN_REDIS_TEST_PORT);
const describeIfRedis = port ? describe : describe.skip;

/** 연결 해제 정리를 흉내 낸다 — 팀 removeSocket처럼 조회 뒤 제거(2왕복) */
let probeRedis: Redis | null = null;
const cleanupKey = (socketId: string) => `shutdown-probe:${socketId}`;

@WebSocketGateway({ namespace: '/shutdown-probe' })
class ProbeGateway implements OnGatewayDisconnect {
  async handleDisconnect(client: { id: string }): Promise<void> {
    if (!probeRedis) return;
    try {
      const key = cleanupKey(client.id);
      if ((await probeRedis.get(key)) === null) return;
      await probeRedis.del(key);
    } catch {
      // 실제 서비스(removeSocket)도 잡아서 로그만 남긴다 — 여기선 키가 남는지로 판정한다
    }
  }
}

describeIfRedis('종료 순서 — 실제 Redis', () => {
  let checker: Redis;

  beforeAll(async () => {
    checker = new Redis({ host: '127.0.0.1', port, lazyConnect: true });
    await checker.connect();
  });

  afterAll(async () => {
    const keys = await checker.keys('shutdown-probe:*');
    if (keys.length > 0) await checker.del(...keys);
    await checker.quit();
  });

  afterEach(() => {
    probeRedis = null;
    jest.restoreAllMocks();
  });

  /**
   * 어댑터가 닫힐 때 보내는 구독 해제(punsubscribe·unsubscribe — 라이브러리가 await하지 않는다)의 결과를 기록한다.
   * Jest는 테스트 안의 process.on('unhandledRejection')에 실제 이벤트를 넘기지 않으므로(테스트 실패로 잡는다) 거부를 여기서 삼키고
   * 결과로 판정한다. status는 보지 않는다 — quit()은 +OK에서 끝나고 status는 소켓 close 이벤트 때 바뀌어, 직후 호출에도 'ready'로 보인다.
   * socket.io는 루트 네임스페이스('/')를 항상 만들어 그것도 구독 해제한다 — 프로브 네임스페이스 채널만 센다
   */
  const recordUnsubscribeOutcome = (adapter: RedisIoAdapter): string[] => {
    const sub = (adapter as unknown as { subClient: Redis }).subClient;
    const outcomes: string[] = [];
    const original = sub.punsubscribe.bind(sub) as (...args: unknown[]) => Promise<unknown>;
    jest.spyOn(sub, 'punsubscribe').mockImplementation(((...args: unknown[]) => {
      const isProbe = String(args[0]).endsWith('/shutdown-probe#*');
      const result = original(...args);
      result.then(
        () => isProbe && outcomes.push('resolved'),
        (error: Error) => isProbe && outcomes.push(`rejected:${error.message}`),
      );
      return result;
    }) as typeof sub.punsubscribe);
    const originalUnsubscribe = sub.unsubscribe.bind(sub) as (...args: unknown[]) => Promise<unknown>;
    jest.spyOn(sub, 'unsubscribe').mockImplementation(((...args: unknown[]) => {
      const result = originalUnsubscribe(...args);
      result.catch(() => undefined);
      return result;
    }) as typeof sub.unsubscribe);
    return outcomes;
  };

  /** RedisIoAdapter를 쓰는 Nest 앱 + 접속한 소켓 1개(정리할 키를 미리 심어 둔다) */
  const start = async (): Promise<{ app: INestApplication; adapter: RedisIoAdapter; socketId: string; client: Socket }> => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ REDIS_HOST: '127.0.0.1', REDIS_PORT: port })] }),
      ],
      providers: [ProbeGateway],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    const adapter = new RedisIoAdapter(app);
    await adapter.connectToRedis();
    app.useWebSocketAdapter(adapter);
    await app.listen(0, '127.0.0.1');
    probeRedis = adapter.getPubClient();

    const { port: appPort } = app.getHttpServer().address() as AddressInfo;
    const client = io(`http://127.0.0.1:${appPort}/shutdown-probe`, { transports: ['websocket'], forceNew: true, reconnection: false });
    const socketId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('소켓 연결 타임아웃')), 3000);
      client.on('connect', () => {
        clearTimeout(timer);
        resolve(client.id as string);
      });
    });
    await checker.set(cleanupKey(socketId), '1');
    return { app, adapter, socketId, client };
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  it('앱을 먼저 닫고 Redis를 닫으면 — 구독 해제가 성공하고 연결 해제 정리가 끝난다', async () => {
    const { app, adapter, socketId, client } = await start();
    const outcomes = recordUnsubscribeOutcome(adapter);

    try {
      await closeAppThenRedis(app, adapter);
      await settle();
    } finally {
      client.close();
    }

    expect(outcomes).toEqual(['resolved']);
    await expect(checker.exists(cleanupKey(socketId))).resolves.toBe(0);
  });

  it('(예전 순서) Redis를 먼저 닫으면 — 구독 해제가 "Connection is closed"로 거부되고(운영에선 Unhandled Rejection) 정리 키가 남는다', async () => {
    const { app, adapter, socketId, client } = await start();
    const outcomes = recordUnsubscribeOutcome(adapter);

    try {
      await adapter.disconnect();
      await app.close();
      await settle();
    } finally {
      client.close();
    }

    expect(outcomes).toEqual(['rejected:Connection is closed.']);
    await expect(checker.exists(cleanupKey(socketId))).resolves.toBe(1);
  });
});

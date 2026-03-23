import { INestApplication, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ConfigService } from '@nestjs/config';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { ServerOptions } from 'socket.io';

/**
 * Redis 기반 Socket.IO 어댑터
 *
 * Redis Pub/Sub을 통해 여러 레플리카 간 Socket.IO 이벤트를 중계.
 * - pub 클라이언트: 이벤트 발행 + OnlineUserService에서 일반 Redis 명령용
 * - sub 클라이언트: 이벤트 구독 전용 (Redis 구독 모드는 전용 연결 필요)
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private pubClient: Redis;
  private subClient: Redis;

  constructor(app: INestApplication) {
    super(app);

    const configService = app.get(ConfigService);
    const host = configService.get<string>('REDIS_HOST') || 'localhost';
    const port = configService.get<number>('REDIS_PORT') || 6379;

    const redisOptions = {
      host,
      port,
      maxRetriesPerRequest: null as null, // redis-adapter 필수 옵션
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
      lazyConnect: true,
    };

    this.pubClient = new Redis(redisOptions);
    this.subClient = new Redis(redisOptions);

    this.pubClient.on('error', (err) => this.logger.error('Redis pub 클라이언트 에러', err.message));
    this.subClient.on('error', (err) => this.logger.error('Redis sub 클라이언트 에러', err.message));
    this.pubClient.on('connect', () => this.logger.log('Redis pub 클라이언트 연결'));
    this.subClient.on('connect', () => this.logger.log('Redis sub 클라이언트 연결'));
  }

  /**
   * Redis 연결 초기화
   * main.ts에서 adapter 사용 전 호출
   */
  async connectToRedis(): Promise<void> {
    try {
      await Promise.all([this.pubClient.connect(), this.subClient.connect()]);
      await this.pubClient.ping();
      this.logger.log('Redis 연결 확인 완료 (PING → PONG)');
    } catch (error) {
      this.logger.warn(`Redis 연결 실패 - HTTP는 정상 작동, 멀티 레플리카 비활성: ${(error as Error).message}`);
    }
  }

  createIOServer(port: number, options?: Partial<ServerOptions>) {
    const server = super.createIOServer(port, options);
    server.adapter(createAdapter(this.pubClient, this.subClient));
    this.logger.log('Redis adapter 적용 완료');
    return server;
  }

  /**
   * OnlineUserService에서 Redis 명령 실행용 클라이언트 제공
   */
  getPubClient(): Redis {
    return this.pubClient;
  }
}

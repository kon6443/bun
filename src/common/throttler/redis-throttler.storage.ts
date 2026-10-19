import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Redis, RedisOptions } from 'ioredis';

/** `ThrottlerStorage.increment`의 반환 형태 (패키지가 레코드 타입을 루트에서 export하지 않는다) */
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/** Redis 명령 응답 상한. 넘기면 이번 요청은 인메모리로 센다 (요청 지연 방지) */
const COMMAND_TIMEOUT_MS = 200;

/** Redis 실패 1회 뒤 이 시간 동안은 Redis를 건너뛰고 인메모리로 센다 (차단기) */
const BREAKER_OPEN_MS = 5000;

const KEY_PREFIX = 'throttle:';

/**
 * 고정 윈도 카운터 + 차단 키를 한 번에 처리하는 Lua 스크립트 (원자적).
 * KEYS[1] = 카운터, KEYS[2] = 차단 표시 / ARGV = ttlMs, limit, blockMs
 * 반환: { totalHits, 카운터 남은 ms, isBlocked(0|1), 차단 남은 ms }
 *
 * 차단이 끝난 뒤 첫 요청에서 카운터가 한도를 넘어 있으면 0부터 다시 센다 —
 * 기본 저장소(`resetBlockdRequest`)와 같은 의미. 이게 없으면 blockDuration < ttl일 때 풀리자마자 다시 막힌다.
 */
const INCREMENT_SCRIPT = `
local blockPttl = redis.call('PTTL', KEYS[2])
if blockPttl > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  return { hits, redis.call('PTTL', KEYS[1]), 1, blockPttl }
end
if tonumber(redis.call('GET', KEYS[1]) or '0') > tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
end
local hits = redis.call('INCR', KEYS[1])
local pttl = redis.call('PTTL', KEYS[1])
if hits == 1 or pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  pttl = tonumber(ARGV[1])
end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return { hits, pttl, 1, tonumber(ARGV[3]) }
end
return { hits, pttl, 0, 0 }
`;

type ThrottleRedis = Redis & {
  throttleIncrement(counterKey: string, blockKey: string, ttl: number, limit: number, blockMs: number): Promise<number[]>;
};

/**
 * HTTP 스로틀 카운터를 **모든 레플리카가 Redis에서 공유**한다.
 *
 * 기본 저장소(`ThrottlerStorageService`)는 프로세스 메모리라 레플리카마다 따로 세서
 * 한도가 레플리카 수만큼 느슨해지고 요청 분산에 따라 들쭉날쭉했다.
 *
 * **스로틀 전용 Redis 연결**을 쓴다(Socket.IO 어댑터 클라이언트와 분리). 어댑터 클라이언트는
 * `maxRetriesPerRequest: null`이라 끊긴 동안 명령이 쌓였다가 재연결 때 **전부 재전송**된다 —
 * 이미 인메모리로 처리한 요청이 뒤늦게 Redis에 몰려 엉뚱한 429를 만든다. 전용 연결은
 * 오프라인 큐·재전송을 끄고 명령 타임아웃·TCP keep-alive를 건다.
 *
 * 장애 정책은 fail-open: Redis가 준비되지 않았거나·느리거나·오류면 이번 요청은 레플리카 인메모리로 센다.
 * 실패 1회 뒤 `BREAKER_OPEN_MS` 동안은 Redis를 아예 건너뛴다(조용히 끊긴 연결에서 매 요청 지연·로그 폭주 방지).
 */
export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly fallback = new ThrottlerStorageService();
  private redis?: ThrottleRedis;
  private breakerOpenUntil = 0;

  /** main.ts에서 1회 호출. 연결 실패는 던지지 않는다 — 연결될 때까지 인메모리로 센다 */
  connect(options: Pick<RedisOptions, 'host' | 'port'>): void {
    const client = new Redis({
      ...options,
      lazyConnect: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      autoResendUnfulfilledCommands: false,
      commandTimeout: COMMAND_TIMEOUT_MS,
      keepAlive: 30000,
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
    });
    client.defineCommand('throttleIncrement', { numberOfKeys: 2, lua: INCREMENT_SCRIPT });
    // error 리스너가 없으면 ioredis가 unhandled error를 낸다. 상태 변화는 increment가 status로 판단한다
    client.on('error', () => undefined);
    this.useClient(client as ThrottleRedis);
  }

  /** 테스트용 주입 지점 (`connect`가 만든 클라이언트와 같은 형태) */
  useClient(client: ThrottleRedis): void {
    this.redis = client;
  }

  async onApplicationShutdown(): Promise<void> {
    this.fallback.onApplicationShutdown();
    if (this.redis) {
      this.redis.disconnect();
    }
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (!this.redis || this.redis.status !== 'ready' || Date.now() < this.breakerOpenUntil) {
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }

    try {
      const result = await this.redis.throttleIncrement(
        `${KEY_PREFIX}${key}`,
        `${KEY_PREFIX}${key}:block`,
        ttl,
        limit,
        blockDuration,
      );
      const [totalHits, pttl, blocked, blockPttl] = result.map(Number);
      return {
        totalHits,
        timeToExpire: Math.ceil(Math.max(pttl, 0) / 1000),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.ceil(Math.max(blockPttl, 0) / 1000),
      };
    } catch (error) {
      this.openBreaker(error);
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  /** 차단기를 연다. 이미 열려 있던 구간에서는 로그를 다시 남기지 않는다 */
  private openBreaker(error: unknown): void {
    const wasClosed = Date.now() >= this.breakerOpenUntil;
    this.breakerOpenUntil = Date.now() + BREAKER_OPEN_MS;
    if (wasClosed) {
      this.logger.warn(
        `Redis 스로틀 카운트 실패 — ${BREAKER_OPEN_MS}ms 동안 레플리카 인메모리로 센다`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}

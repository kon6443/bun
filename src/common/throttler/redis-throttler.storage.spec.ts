import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * Redis 공유 스로틀 저장소 (Redis는 mock — 실제 Redis 대상 의미 검증은 test/redis-throttler.redis.e2e-spec.ts).
 * 핵심은 세 가지다:
 *  1. Redis가 정상이면 Lua 결과(ms)를 스로틀 레코드(초)로 정확히 옮긴다.
 *  2. Redis가 없거나·준비 안 됐거나·오류면 **요청을 막지 않고** 인메모리로 센다(fail-open).
 *  3. 실패 1회 뒤에는 차단기가 열려 일정 시간 Redis를 건너뛴다(매 요청 지연·로그 폭주 방지).
 */
describe('RedisThrottlerStorage', () => {
  let storage: RedisThrottlerStorage;

  type FakeRedis = { status: string; throttleIncrement: jest.Mock; disconnect: jest.Mock };
  const fakeRedis = (status: string, impl: () => Promise<unknown>): FakeRedis => ({
    status,
    throttleIncrement: jest.fn(impl),
    disconnect: jest.fn(),
  });
  const use = (redis: FakeRedis) => storage.useClient(redis as unknown as Parameters<typeof storage.useClient>[0]);

  beforeEach(() => {
    storage = new RedisThrottlerStorage();
  });

  afterEach(async () => {
    await storage.onApplicationShutdown();
    jest.useRealTimers();
  });

  it('Redis 결과를 초 단위 레코드로 옮긴다 (차단 아님)', async () => {
    const redis = fakeRedis('ready', async () => [3, 800, 0, 0]);
    use(redis);

    await expect(storage.increment('k', 1000, 5, 1000, 'short')).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 1,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    // 카운터·차단 키는 접두어로 다른 Redis 키와 섞이지 않는다
    expect(redis.throttleIncrement).toHaveBeenCalledWith('throttle:k', 'throttle:k:block', 1000, 5, 1000);
  });

  it('한도를 넘으면 차단 레코드를 돌려준다', async () => {
    use(fakeRedis('ready', async () => [6, 400, 1, 60000]));

    await expect(storage.increment('k', 1000, 5, 60000, 'short')).resolves.toMatchObject({
      totalHits: 6,
      isBlocked: true,
      timeToBlockExpire: 60,
    });
  });

  it('Redis가 ready가 아니면 묻지 않고 인메모리로 센다', async () => {
    const redis = fakeRedis('reconnecting', async () => [1, 1000, 0, 0]);
    use(redis);

    const record = await storage.increment('k', 1000, 5, 1000, 'short');

    expect(redis.throttleIncrement).not.toHaveBeenCalled();
    expect(record).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('연결 전(부팅 직후)에도 인메모리로 센다', async () => {
    await expect(storage.increment('k', 1000, 5, 1000, 'short')).resolves.toMatchObject({ totalHits: 1 });
  });

  it('Redis 오류(명령 타임아웃 포함)면 요청을 막지 않고 인메모리로 센다', async () => {
    use(fakeRedis('ready', async () => Promise.reject(new Error('Command timed out'))));

    await expect(storage.increment('k', 1000, 5, 1000, 'short')).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
  });

  it('실패 1회 뒤 차단기가 열려 5초 동안 Redis를 묻지 않는다 — 이후 다시 묻는다', async () => {
    jest.useFakeTimers();
    let fail = true;
    const redis = fakeRedis('ready', async () => (fail ? Promise.reject(new Error('down')) : [1, 1000, 0, 0]));
    use(redis);

    await storage.increment('k', 1000, 5, 1000, 'short');
    await storage.increment('k', 1000, 5, 1000, 'short');
    expect(redis.throttleIncrement).toHaveBeenCalledTimes(1); // 두 번째는 건너뜀

    fail = false;
    jest.advanceTimersByTime(5000);
    await storage.increment('k', 1000, 5, 1000, 'short');
    expect(redis.throttleIncrement).toHaveBeenCalledTimes(2); // 차단기 닫힘 → 다시 Redis
  });

  it('종료 시 전용 연결을 끊는다', async () => {
    const redis = fakeRedis('ready', async () => [1, 1000, 0, 0]);
    use(redis);

    await storage.onApplicationShutdown();

    expect(redis.disconnect).toHaveBeenCalled();
  });
});

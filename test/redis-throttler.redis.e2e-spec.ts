import { RedisThrottlerStorage } from '../src/common/throttler/redis-throttler.storage';

/**
 * 실제 Redis 대상 스로틀 저장소 검증 — **opt-in**.
 *
 * CI·기본 E2E에는 Redis가 없으므로 `THROTTLE_REDIS_TEST_PORT`가 있을 때만 돈다.
 * 로컬: `THROTTLE_REDIS_TEST_PORT=6380 pnpm test:e2e -- --testPathPatterns redis-throttler`
 * (`throttle:probe-*` 키만 쓰고 TTL(최대 5초)로 자동 만료된다. 운영 Redis를 가리키지 말 것.)
 *
 * mock 단위 테스트가 잡지 못하는 **Lua 본문의 의미**(레플리카 간 공유, 차단·해제, 차단 후 재시작)를 본다.
 */
const port = Number(process.env.THROTTLE_REDIS_TEST_PORT);
const describeIfRedis = port ? describe : describe.skip;

describeIfRedis('RedisThrottlerStorage — 실제 Redis', () => {
  const replicaA = new RedisThrottlerStorage();
  const replicaB = new RedisThrottlerStorage();
  const key = () => `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const waitReady = (s: RedisThrottlerStorage) =>
    new Promise<void>((resolve, reject) => {
      const client = (s as unknown as { redis: { status: string; once: (e: string, f: () => void) => void } }).redis;
      if (client.status === 'ready') return resolve();
      const timer = setTimeout(() => reject(new Error('Redis 연결 대기 초과')), 3000);
      client.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });

  beforeAll(async () => {
    replicaA.connect({ host: '127.0.0.1', port });
    replicaB.connect({ host: '127.0.0.1', port });
    await Promise.all([waitReady(replicaA), waitReady(replicaB)]);
  });

  afterAll(async () => {
    await replicaA.onApplicationShutdown();
    await replicaB.onApplicationShutdown();
  });

  it('두 레플리카가 한 카운터를 공유하고 한도를 넘으면 상대 레플리카에서도 막힌다', async () => {
    const k = key();
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      const s = i % 2 ? replicaB : replicaA;
      const r = await s.increment(k, 1000, 5, 1500, 'short');
      results.push(`${r.totalHits}${r.isBlocked ? 'B' : ''}`);
    }
    expect(results).toEqual(['1', '2', '3', '4', '5', '6B']);
    await expect(replicaA.increment(k, 1000, 5, 1500, 'short')).resolves.toMatchObject({ isBlocked: true });
  });

  it('차단이 끝나면 0부터 다시 센다 (blockDuration < ttl이어도 즉시 재차단되지 않는다)', async () => {
    const k = key();
    for (let i = 0; i < 3; i++) await replicaA.increment(k, 5000, 2, 300, 'short'); // 3번째에서 차단(300ms)
    await new Promise((r) => setTimeout(r, 350));

    // 카운터 윈도(5초)는 남아 있지만 차단이 풀렸으므로 1부터 다시
    await expect(replicaB.increment(k, 5000, 2, 300, 'short')).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
  });
});

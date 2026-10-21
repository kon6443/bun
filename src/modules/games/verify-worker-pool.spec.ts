import { Worker } from 'node:worker_threads';
import { Logger } from '@nestjs/common';
import { VerifyQueueFullError, VerifyTimeoutError, VerifyWorkerError, VerifyWorkerPool } from './verify-worker-pool';

/**
 * 검증 워커 풀 (docs/tasks/defense DESIGN §B5) — 실제 worker_threads로 돌린다.
 *
 * 테스트 워커 규약: 기동하면 { ready: true }를 먼저 보낸다. input { ms, value, fail?, crash? } → ms 동안 바쁘게 돈 뒤 value를 돌려준다.
 * fail이면 { ok: false } 답(워커 자체 처리 실패 = 인프라 흉내 — 재현 실패는 실제 워커에서 { ok: true, result: { ok: false } }로 답한다), crash면 워커 안에서 예외(워커 'error' 이벤트), exit면 process.exit(error 없는 종료).
 */
const TEST_WORKER = `
const { parentPort } = require('node:worker_threads');
parentPort.postMessage({ ready: true });
parentPort.on('message', ({ id, input }) => {
  const until = Date.now() + input.ms;
  while (Date.now() < until) {}
  if (input.crash) throw new Error('boom');
  if (input.exit) process.exit(0);
  if (input.readyAgain) parentPort.postMessage({ ready: true });
  if (input.fail) parentPort.postMessage({ id, ok: false, error: 'worker failure' });
  else parentPort.postMessage({ id, ok: true, result: input.value });
});
`;

type Input = { ms: number; value: number; fail?: boolean; crash?: boolean; exit?: boolean; readyAgain?: boolean; fn?: () => void };

/** ready를 보낸 직후 대기 중에 죽는 워커 — 잡히지 않은 비동기 예외 흉내 */
const IDLE_DYING_WORKER = `require('node:worker_threads').parentPort.postMessage({ ready: true }); setTimeout(() => { throw new Error('idle boom'); }, 10);`;

/** 살아 있지만 ready를 보내지 않는 워커 — 모듈 로드가 멈춘 경우·규약 위반 흉내 */
const SILENT_WORKER = `setInterval(() => {}, 1000);`;

/** 기동하자마자 죽는 워커 — 스크립트 경로·모듈 로드 오류 흉내 */
const BROKEN_WORKER = `throw new Error('load failed');`;

describe('VerifyWorkerPool', () => {
  let pool: VerifyWorkerPool<Input, number>;
  let created: number;

  const makePool = async (size: number, queueLimit: number, timeoutMs: number, code = TEST_WORKER, disabledRetryMs?: number) => {
    created = 0;
    pool = new VerifyWorkerPool<Input, number>(
      () => {
        created++;
        return new Worker(code, { eval: true });
      },
      { size, queueLimit, timeoutMs, disabledRetryMs },
    );
    if (code === TEST_WORKER) {
      // 정상 워커는 ready를 보낼 때까지 작업을 맡지 않는다 — 대기열 동작을 재는 테스트가 기동 대기에 섞이지 않게 먼저 준비시킨다
      await Promise.all(Array.from({ length: size }, () => pool.run({ ms: 0, value: 0 })));
    }
  };

  beforeEach(() => {
    // 재생성·자리 끄기 로그는 테스트 출력에서 숨긴다
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await pool.close();
    jest.restoreAllMocks();
  });

  it('ready를 보내기 전에는 작업을 맡기지 않고 대기열에 두었다가 ready 뒤 처리해야 함', async () => {
    created = 0;
    pool = new VerifyWorkerPool<Input, number>(() => new Worker(TEST_WORKER, { eval: true }), { size: 1, queueLimit: 1, timeoutMs: 2000 });

    await expect(pool.run({ ms: 0, value: 5 })).resolves.toBe(5);
  });

  it('워커가 계산한 결과를 돌려줘야 함', async () => {
    await makePool(1, 2, 2000);

    await expect(pool.run({ ms: 0, value: 7 })).resolves.toBe(7);
  });

  it('워커 수만큼만 동시에 돌고 나머지는 대기열에서 순서대로 처리해야 함', async () => {
    await makePool(1, 3, 5000);

    const results = await Promise.all([1, 2, 3].map((value) => pool.run({ ms: 30, value })));

    expect(results).toEqual([1, 2, 3]);
    expect(created).toBe(1);
  });

  it('대기열이 가득 차면 바로 VerifyQueueFullError — 진행 중·대기 작업은 그대로 끝나야 함', async () => {
    await makePool(1, 1, 5000);

    const running = pool.run({ ms: 100, value: 1 });
    const queued = pool.run({ ms: 0, value: 2 });
    await expect(pool.run({ ms: 0, value: 3 })).rejects.toBeInstanceOf(VerifyQueueFullError);
    await expect(Promise.all([running, queued])).resolves.toEqual([1, 2]);
  });

  it('시간 상한을 넘으면 VerifyTimeoutError — 워커를 새로 띄워 다음 작업을 처리해야 함', async () => {
    await makePool(1, 1, 100);

    const slow = pool.run({ ms: 1000, value: 1 });
    const next = pool.run({ ms: 0, value: 2 });

    await expect(slow).rejects.toBeInstanceOf(VerifyTimeoutError);
    await expect(next).resolves.toBe(2);
    expect(created).toBe(2);
  });

  it('워커 처리 실패 답({ ok: false })이면 VerifyWorkerError — 워커는 계속 쓴다', async () => {
    await makePool(1, 1, 2000);

    await expect(pool.run({ ms: 0, value: 1, fail: true })).rejects.toThrow(new VerifyWorkerError('worker failure'));
    await expect(pool.run({ ms: 0, value: 2 })).resolves.toBe(2);
    expect(created).toBe(1);
  });

  it('워커가 죽으면 VerifyWorkerError — 새 워커로 바꿔 다음 작업을 처리해야 함', async () => {
    await makePool(1, 1, 2000);

    const crashed = pool.run({ ms: 0, value: 1, crash: true });
    const next = pool.run({ ms: 0, value: 2 });

    await expect(crashed).rejects.toBeInstanceOf(VerifyWorkerError);
    await expect(next).resolves.toBe(2);
    expect(created).toBe(2);
  });

  it('워커가 error 없이 스스로 끝나면(process.exit) 시간 초과를 기다리지 않고 교체해야 함', async () => {
    await makePool(1, 1, 5000);

    const started = Date.now();
    const exited = pool.run({ ms: 0, value: 1, exit: true });
    const next = pool.run({ ms: 0, value: 2 });

    await expect(exited).rejects.toBeInstanceOf(VerifyWorkerError);
    await expect(next).resolves.toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('작업 중에 ready를 또 보내도(규약 위반) 진행 중 작업이 매달리지 않아야 함', async () => {
    await makePool(1, 1, 2000);

    await expect(pool.run({ ms: 50, value: 4, readyAgain: true })).resolves.toBe(4);
    await expect(pool.run({ ms: 0, value: 5 })).resolves.toBe(5);
  });

  it('복제할 수 없는 입력이면 그 작업만 VerifyWorkerError — 워커는 계속 쓴다', async () => {
    await makePool(1, 1, 2000);

    await expect(pool.run({ ms: 0, value: 1, fn: () => undefined })).rejects.toBeInstanceOf(VerifyWorkerError);
    await expect(pool.run({ ms: 0, value: 2 })).resolves.toBe(2);
    expect(created).toBe(1);
  });

  it('작업 중 크래시는 입력 탓일 수 있어 세지 않음 — 같은 입력을 여러 번 보내도 자리가 꺼지지 않아야 함', async () => {
    await makePool(1, 1, 2000);

    for (let i = 0; i < 4; i++) {
      await expect(pool.run({ ms: 0, value: i, crash: true })).rejects.toBeInstanceOf(VerifyWorkerError);
    }
    await expect(pool.run({ ms: 0, value: 9 })).resolves.toBe(9);
    expect(created).toBe(5);
  });

  it('뜨자마자(ready 뒤) 대기 중에 죽는 워커도 크래시로 세어 꺼야 함 — ready만으로는 카운트를 되돌리지 않는다', async () => {
    await makePool(1, 1, 2000, IDLE_DYING_WORKER);

    await new Promise((resolve) => setTimeout(resolve, 800));
    const createdWhenDisabled = created;
    expect(createdWhenDisabled).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(created).toBe(createdWhenDisabled);
  });

  it('ready를 보내지 않는 워커는 ready 시간 상한으로 회수해 크래시로 세고, 대기 작업이 매달리지 않아야 함', async () => {
    await makePool(1, 1, 150, SILENT_WORKER);

    // ready 시간 초과 150ms × 3 + 백오프 100·200ms 뒤 자리가 꺼지며 대기 작업이 거절된다
    const queued = pool.run({ ms: 0, value: 1 }).catch((e: unknown) => e);
    expect(await queued).toBeInstanceOf(VerifyWorkerError);
    expect(created).toBe(3);
  });

  it('꺼진 자리도 시간이 지나면 다시 시도해야 함 (스스로 복구)', async () => {
    await makePool(1, 1, 2000, BROKEN_WORKER, 300);

    await pool.run({ ms: 0, value: 1 }).catch(() => undefined);
    // 100·200ms 백오프 뒤 꺼지고, 300ms 뒤 다시 시도
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(created).toBeGreaterThan(3);
  });

  it('기동하자마자 계속 죽으면 3번 만에 자리를 끄고 이후 요청은 바로 거절해야 함 — 무한 재생성 금지', async () => {
    await makePool(1, 2, 2000, BROKEN_WORKER);

    const first = pool.run({ ms: 0, value: 1 }).catch((e: unknown) => e);
    const queued = pool.run({ ms: 0, value: 2 }).catch((e: unknown) => e);
    expect(await first).toBeInstanceOf(VerifyWorkerError);
    expect(await queued).toBeInstanceOf(VerifyWorkerError);

    // ready 전에 죽으므로 작업을 맡기지 않고 매번 크래시로 센다 → 3번째(100·200ms 백오프 뒤)에 자리가 꺼지고 대기 작업은 거절
    await new Promise((resolve) => setTimeout(resolve, 800));
    const createdWhenDisabled = created;
    expect(createdWhenDisabled).toBe(3);
    await expect(pool.run({ ms: 0, value: 3 })).rejects.toThrow('검증 워커를 쓸 수 없습니다');
    // 꺼진 뒤에는 재시도 간격(기본 60초) 전까지 더 띄우지 않는다
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(created).toBe(createdWhenDisabled);
  });

  it('닫으면 대기 중 작업은 실패하고 이후 요청도 거절해야 함', async () => {
    await makePool(1, 2, 5000);

    // close() 중에 거절되므로 결과를 먼저 받아 둔다(처리되지 않은 거절 방지)
    const running = pool.run({ ms: 100, value: 1 }).catch((e: unknown) => e);
    const queued = pool.run({ ms: 0, value: 2 }).catch((e: unknown) => e);
    await pool.close();

    expect(await running).toBeInstanceOf(VerifyWorkerError);
    expect(await queued).toBeInstanceOf(VerifyWorkerError);
    await expect(pool.run({ ms: 0, value: 3 })).rejects.toBeInstanceOf(VerifyWorkerError);
  });
});

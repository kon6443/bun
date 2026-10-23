import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { verifyDefenseReplay } from './defense-verify';
import { DefenseVerifyService } from './defense-verify.service';

/** 워커 대역 — 뜨자마자 ready, 작업에는 규약대로 { id, ok: true, result }로 답한다 */
class FakeWorker extends EventEmitter {
  static created: FakeWorker[] = [];
  constructor(readonly script: string) {
    super();
    FakeWorker.created.push(this);
    setImmediate(() => this.emit('message', { ready: true }));
  }
  postMessage({ id, input }: { id: number; input: { boardKey: string } }) {
    setImmediate(() =>
      this.emit('message', { id, ok: true, result: { ok: false, reason: `echo:${input.boardKey}` } }),
    );
  }
  terminate() {
    return Promise.resolve(0);
  }
}

jest.mock('node:worker_threads', () => ({ Worker: jest.fn((script: string) => new FakeWorker(script)) }));

describe('DefenseVerifyService — 워커 풀 배선', () => {
  const input = { seed: 1, boardKey: 'endless-s1', frames: 30, inputs: [], params: {} };
  const serviceWith = (workers?: string) => new DefenseVerifyService({ get: () => workers } as never);

  beforeEach(() => {
    FakeWorker.created = [];
    // jest(ts)에는 빌드 결과 .js가 없다 — 워커 풀 배선은 스크립트가 있는 것으로 놓고 본다
    jest.spyOn(DefenseVerifyService.prototype as unknown as { workerScriptAvailable: () => boolean }, 'workerScriptAvailable').mockReturnValue(true);
  });

  afterEach(() => jest.restoreAllMocks());

  it('첫 검증 때 빌드 결과의 워커 스크립트로 풀을 띄우고 결과를 돌려준다 — 생성만으로는 띄우지 않는다', async () => {
    const service = serviceWith();
    expect(FakeWorker.created).toHaveLength(0);

    await expect(service.verify(input)).resolves.toEqual({ ok: false, reason: 'echo:endless-s1' });
    await service.verify(input);

    expect(FakeWorker.created).toHaveLength(1);
    expect(FakeWorker.created[0].script).toMatch(/defense-verify\.worker\.js$/);
    await service.onModuleDestroy();
  });

  it.each([
    [undefined, 1],
    ['3', 3],
    ['8', 8],
    ['0', 1],
    ['9', 1],
    ['2.5', 1],
    ['abc', 1],
    ['', 1],
  ])('GAME_VERIFY_WORKERS=%p → 워커 %i개', async (workers, count) => {
    const service = serviceWith(workers);

    await service.verify(input);

    expect(FakeWorker.created).toHaveLength(count);
    await service.onModuleDestroy();
  });

  it('워커 스크립트가 없으면(ts 직접 실행) 워커를 띄우지 않고 메인 스레드에서 검증, 원인은 error 1번 (BD-13)', async () => {
    jest.spyOn(DefenseVerifyService.prototype as unknown as { workerScriptAvailable: () => boolean }, 'workerScriptAvailable').mockReturnValue(false);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = serviceWith();

    await expect(service.verify(input)).resolves.toEqual(verifyDefenseReplay(input));
    await service.verify(input);

    expect(FakeWorker.created).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('종료 뒤 들어온 검증은 풀을 새로 띄우지 않고 거절한다(→ 503)', async () => {
    const service = serviceWith();
    await service.onModuleDestroy();

    await expect(service.verify(input)).rejects.toThrow('종료 중');
    expect(FakeWorker.created).toHaveLength(0);
  });
});

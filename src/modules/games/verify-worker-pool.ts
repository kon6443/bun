import { Logger } from '@nestjs/common';
import type { Worker } from 'node:worker_threads';

/**
 * 리플레이 검증 워커 풀 (docs/tasks/defense DESIGN §B5)
 *
 * 무거운 검증(디펜스 수백 ms~초)이 메인 이벤트 루프를 막으면 같은 프로세스의 HTTP·WS·헬스체크가 함께 멈춘다.
 * 워커 스레드에서 돌리고, 대기열 상한·작업 시간 상한을 둔다. 실패는 모두 예외 — 서비스가 503 GAME_VERIFY_BUSY로 바꾸고 세션을 남긴다.
 *
 * 워커 규약: 기동(모듈 로드)을 마치면 `{ ready: true }`를 먼저 보낸다. 그 뒤 `{ id, input }`을 받아
 * `{ id, ok: true, result }` 또는 `{ id, ok: false, error }`를 돌려준다. 한 번에 1건만 맡기고, ready 전에는 맡기지 않는다.
 * `ok: false`는 **워커 자체의 처리 실패(인프라)** 전용이다 — 리플레이 재현 실패·엔진 예외처럼 입력에 대한 확정 결과는
 * 워커가 잡아 `{ ok: true, result: { ok: false, reason } }`로 답한다. 그래야 결정적 실패가 503(세션 유지) 무한 재시도가 되지 않는다(defense DESIGN §B2 ③).
 * 레플리카마다 풀이 따로 있다 — 공유 상태가 아니라 프로세스 안의 실행 자원이다.
 *
 * 작업 중에 죽으면 그 작업만 실패시키고 바로 다시 띄운다(입력 탓일 수 있다 — 같은 입력을 반복해도 자리가 꺼지지 않게).
 * 작업 없이 죽으면(ready 전 기동 실패·대기 중 종료) 점점 늦게 다시 띄우고, 연속으로 죽으면 그 자리를 끈다 — 스크립트 경로·빌드 오류로
 * 기동 즉시 죽는 워커를 끝없이 재생성하지 않게. 꺼진 자리도 긴 간격으로 다시 시도해 스스로 복구된다.
 * 살아 있는 자리가 없고 모든 자리가 꺼졌으면 요청을 바로 거절한다(503).
 */
export interface VerifyWorkerPoolOptions {
  /** 동시에 돌릴 워커 수 */
  size: number;
  /** 워커를 기다리는 작업 수 상한 — 넘으면 바로 거절 */
  queueLimit: number;
  /** 작업 1건 시간 상한(ms, 워커에 넘긴 때부터) — 넘으면 그 워커를 종료하고 새로 띄운다 */
  timeoutMs: number;
  /** 꺼진 자리를 다시 시도하는 간격(ms) — 기본 60초 */
  disabledRetryMs?: number;
}

export class VerifyQueueFullError extends Error {
  constructor() {
    super('검증 대기열이 가득 찼습니다');
  }
}

export class VerifyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`검증이 ${timeoutMs}ms 안에 끝나지 않았습니다`);
  }
}

export class VerifyWorkerError extends Error {}

/** 작업 없이 연속으로 이만큼 죽으면 그 자리를 끈다 */
const MAX_CONSECUTIVE_CRASHES = 3;
/** 재생성 대기 = 기준 × 2^(연속 크래시 − 1) */
const RESPAWN_BASE_DELAY_MS = 100;
const DEFAULT_DISABLED_RETRY_MS = 60_000;

interface Job<I, O> {
  input: I;
  resolve: (result: O) => void;
  reject: (error: Error) => void;
}

interface Slot<I, O> {
  index: number;
  worker: Worker;
  job: Job<I, O> | null;
  jobId: number;
  timer: NodeJS.Timeout | null;
  /** 워커가 기동을 마쳤다({ ready: true }) — 그 전에는 작업을 맡기지 않는다 */
  ready: boolean;
  /** 풀이 이 워커를 내보냈다 — 이후 이벤트는 무시한다 */
  retired: boolean;
}

type WorkerReply<O> = { ready: true } | { id: number; ok: true; result: O } | { id: number; ok: false; error: string };

export class VerifyWorkerPool<I, O> {
  private readonly logger = new Logger(VerifyWorkerPool.name);
  /** 자리별 현재 워커 — null이면 재생성 대기 중이거나 꺼진 자리 */
  private readonly slots: (Slot<I, O> | null)[];
  /** 자리별 "작업 없이" 연속 크래시 수 — 작업 답(성공·실패 답)을 받으면 0 */
  private readonly crashes: number[];
  private readonly queue: Job<I, O>[] = [];
  private nextJobId = 1;
  private closed = false;

  constructor(
    private readonly createWorker: () => Worker,
    private readonly options: VerifyWorkerPoolOptions,
  ) {
    this.slots = Array.from({ length: options.size }, () => null);
    this.crashes = Array.from({ length: options.size }, () => 0);
    for (let index = 0; index < options.size; index++) {
      this.respawn(index);
    }
  }

  run(input: I): Promise<O> {
    if (this.closed) {
      return Promise.reject(new VerifyWorkerError('검증 워커 풀이 닫혔습니다'));
    }
    if (this.isDisabled()) {
      return Promise.reject(new VerifyWorkerError('검증 워커를 쓸 수 없습니다'));
    }
    return new Promise<O>((resolve, reject) => {
      const job = { input, resolve, reject };
      const idle = this.slots.find((slot): slot is Slot<I, O> => slot !== null && slot.ready && slot.job === null);
      if (idle) {
        this.dispatch(idle, job);
      } else if (this.queue.length < this.options.queueLimit) {
        this.queue.push(job);
      } else {
        reject(new VerifyQueueFullError());
      }
    });
  }

  /** 모듈 종료 시 — 대기 중·진행 중 작업은 실패로 끝낸다 */
  async close(): Promise<void> {
    this.closed = true;
    this.rejectQueue(new VerifyWorkerError('검증 워커 풀이 닫혔습니다'));
    await Promise.all(
      this.slots.map(async (slot) => {
        if (slot) {
          this.retire(slot)?.reject(new VerifyWorkerError('검증 워커 풀이 닫혔습니다'));
          await slot.worker.terminate();
        }
      }),
    );
  }

  /** 살아 있는 워커가 없고 모든 자리가 꺼졌는지 — 재시도로 떠 있는 워커가 있으면 작업을 맡겨 본다 */
  private isDisabled(): boolean {
    return this.slots.every((slot) => slot === null) && this.crashes.every((count) => count >= MAX_CONSECUTIVE_CRASHES);
  }

  /** index 자리에 새 워커를 띄운다. 생성 자체가 실패하면 크래시로 센다 */
  private respawn(index: number): void {
    if (this.closed) {
      return;
    }
    let worker: Worker;
    try {
      worker = this.createWorker();
    } catch (error) {
      this.onCrash(index, error instanceof Error ? error.message : String(error));
      return;
    }
    const slot: Slot<I, O> = { index, worker, job: null, jobId: 0, timer: null, ready: false, retired: false };
    worker.on('message', (reply: WorkerReply<O>) => {
      if (slot.retired) {
        return;
      }
      if ('ready' in reply) {
        // 기동 성공 — 이제부터 작업을 맡긴다. 크래시 수는 작업 답을 받아야 0으로 되돌린다(뜨자마자 대기 중에 죽는 워커도 꺼지게).
        // 두 번째 ready(규약 위반)는 무시한다 — 진행 중 작업의 타이머를 지우면 그 작업이 매달린다
        if (!slot.ready) {
          this.finish(slot);
          slot.ready = true;
          this.next(slot);
        }
        return;
      }
      // 시간 초과로 버린 작업의 늦은 답은 무시한다
      if (reply.id !== slot.jobId) {
        return;
      }
      this.crashes[index] = 0;
      const job = this.finish(slot);
      if (reply.ok) {
        job?.resolve(reply.result);
      } else {
        job?.reject(new VerifyWorkerError(reply.error));
      }
      this.next(slot);
    });
    worker.on('error', (error: Error) => this.crash(slot, error.message));
    worker.on('messageerror', (error: Error) => this.crash(slot, `메시지 역직렬화 실패: ${error.message}`));
    // error 없이 끝나는 종료(process.exit)도 크래시 — 우리가 내보낸 워커의 종료는 retired라 무시된다
    worker.on('exit', (code: number) => this.crash(slot, `워커 종료(code ${code})`));
    this.slots[index] = slot;
    // ready가 오지 않고 멈춘 워커(모듈 로드가 멈춤·규약 위반)도 회수한다 — 대기 작업이 영원히 매달리지 않게
    slot.timer = setTimeout(() => this.crash(slot, `${this.options.timeoutMs}ms 안에 ready를 보내지 않음`), this.options.timeoutMs);
  }

  private dispatch(slot: Slot<I, O>, job: Job<I, O>): void {
    slot.job = job;
    slot.jobId = this.nextJobId++;
    slot.timer = setTimeout(() => this.timeout(slot), this.options.timeoutMs);
    try {
      slot.worker.postMessage({ id: slot.jobId, input: job.input });
    } catch (error) {
      // 복제할 수 없는 입력 — 워커는 멀쩡하므로 작업만 실패시키고 다음 작업으로
      this.finish(slot);
      job.reject(new VerifyWorkerError(error instanceof Error ? error.message : String(error)));
      this.next(slot);
    }
  }

  /** 진행 중 작업을 떼어 내고 타이머를 정리한다 */
  private finish(slot: Slot<I, O>): Job<I, O> | null {
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    const job = slot.job;
    slot.job = null;
    slot.jobId = 0;
    return job;
  }

  /** 워커를 내보낸다 — 진행 중 작업을 돌려주고 자리를 비운다(이벤트는 이후 무시) */
  private retire(slot: Slot<I, O>): Job<I, O> | null {
    slot.retired = true;
    if (this.slots[slot.index] === slot) {
      this.slots[slot.index] = null;
    }
    return this.finish(slot);
  }

  private next(slot: Slot<I, O>): void {
    if (slot.retired || !slot.ready || slot.job || this.closed) {
      return;
    }
    const job = this.queue.shift();
    if (job) {
      this.dispatch(slot, job);
    }
  }

  /** 시간 초과 — 입력이 무거운 것이라 크래시로 세지 않고 바로 새 워커를 띄운다 */
  private timeout(slot: Slot<I, O>): void {
    if (slot.retired) {
      return;
    }
    this.retire(slot)?.reject(new VerifyTimeoutError(this.options.timeoutMs));
    void slot.worker.terminate();
    this.respawn(slot.index);
  }

  /**
   * 워커 오류·종료.
   * 작업 중이었으면 입력 탓일 수 있다 — 그 작업만 실패시키고 바로 다시 띄운다(크래시로 세지 않음).
   * 작업이 없었으면(ready 전 기동 실패 포함 — ready 전에는 작업을 맡기지 않는다) 워커 자체 문제 — 크래시로 세고 점점 늦게 다시 띄운다
   */
  private crash(slot: Slot<I, O>, reason: string): void {
    if (slot.retired) {
      return;
    }
    const job = this.retire(slot);
    void slot.worker.terminate();
    if (job) {
      job.reject(new VerifyWorkerError(reason));
      this.logger.warn(`검증 워커 ${slot.index}번이 작업 중 종료 — 다시 띄움: ${reason}`);
      this.respawn(slot.index);
      return;
    }
    this.onCrash(slot.index, reason);
  }

  private onCrash(index: number, reason: string): void {
    if (this.closed) {
      return;
    }
    const count = ++this.crashes[index];
    if (count >= MAX_CONSECUTIVE_CRASHES) {
      const retryMs = this.options.disabledRetryMs ?? DEFAULT_DISABLED_RETRY_MS;
      this.logger.error(`검증 워커 ${index}번 자리를 끕니다(${retryMs}ms 뒤 다시 시도) — 연속 ${count}회 크래시: ${reason}`);
      if (this.isDisabled()) {
        this.rejectQueue(new VerifyWorkerError('검증 워커를 쓸 수 없습니다'));
      }
      setTimeout(() => this.respawn(index), retryMs).unref();
      return;
    }
    const delayMs = RESPAWN_BASE_DELAY_MS * 2 ** (count - 1);
    this.logger.warn(`검증 워커 ${index}번 재생성 ${delayMs}ms 후 — ${reason}`);
    setTimeout(() => this.respawn(index), delayMs).unref();
  }

  private rejectQueue(error: Error): void {
    for (const job of this.queue.splice(0)) {
      job.reject(error);
    }
  }
}

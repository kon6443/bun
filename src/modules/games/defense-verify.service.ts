import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ReplayInput, VerifiedReplay } from './game-engine.registry';
import { VerifyWorkerError, VerifyWorkerPool } from './verify-worker-pool';
import { DEFENSE_VERIFY_QUEUE_LIMIT, DEFENSE_VERIFY_TIMEOUT_MS } from '../../common/constants/app.constants';

/** 워커 엔트리 — 빌드 결과(dist)의 .js. ts 실행 환경(jest)에는 없으므로 테스트는 verifyDefenseReplay를 직접 주입한다 */
const WORKER_SCRIPT = join(__dirname, 'defense-verify.worker.js');

/**
 * 디펜스 리플레이 검증을 워커 스레드에서 돌린다 (defense DESIGN §B5)
 *
 * 풀은 첫 검증 때 띄운다 — 디펜스 제출이 없는 레플리카·테스트 모듈 조립에서 워커를 만들지 않게.
 * 대기열 초과·시간 초과·워커 오류는 예외 → 서비스가 503 GAME_VERIFY_BUSY + 세션 유지.
 */
@Injectable()
export class DefenseVerifyService implements OnModuleDestroy {
  private pool: VerifyWorkerPool<ReplayInput, VerifiedReplay> | null = null;
  /** 모듈 종료가 시작됐다 — 그 뒤 들어온 제출이 새 풀(정리되지 않는 워커)을 띄우지 않게 */
  private destroyed = false;

  constructor(private readonly configService: ConfigService) {}

  verify(input: ReplayInput): Promise<VerifiedReplay> {
    if (this.destroyed) {
      return Promise.reject(new VerifyWorkerError('검증 서비스가 종료 중입니다'));
    }
    this.pool ??= new VerifyWorkerPool(() => new Worker(WORKER_SCRIPT), {
      size: this.workerCount(),
      queueLimit: DEFENSE_VERIFY_QUEUE_LIMIT,
      timeoutMs: DEFENSE_VERIFY_TIMEOUT_MS,
    });
    return this.pool.run(input);
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    await this.pool?.close();
  }

  /** 레플리카당 워커 수 — GAME_VERIFY_WORKERS(1~8), 없거나 잘못된 값이면 1 (§B7) */
  private workerCount(): number {
    const count = Number(this.configService.get<string>('GAME_VERIFY_WORKERS'));
    return Number.isInteger(count) && count >= 1 && count <= 8 ? count : 1;
  }
}

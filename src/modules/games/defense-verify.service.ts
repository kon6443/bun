import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyDefenseReplay } from './defense-verify';
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
 * 워커 스크립트(.js)가 없으면(`pnpm dev:tsx`처럼 ts를 직접 실행) 워커가 매번 크래시해 모든 제출이 503이 되므로,
 * 원인을 error로 1번 남기고 메인 스레드에서 검증한다 — 운영 이미지는 dist라 해당 없음(games-polish BD-13)
 */
@Injectable()
export class DefenseVerifyService implements OnModuleDestroy {
  private readonly logger = new Logger(DefenseVerifyService.name);
  private pool: VerifyWorkerPool<ReplayInput, VerifiedReplay> | null = null;
  /** 모듈 종료가 시작됐다 — 그 뒤 들어온 제출이 새 풀(정리되지 않는 워커)을 띄우지 않게 */
  private destroyed = false;
  /** 워커 스크립트 확인 결과 — 첫 검증 때 1번 본다 */
  private inline: boolean | null = null;

  constructor(private readonly configService: ConfigService) {}

  verify(input: ReplayInput): Promise<VerifiedReplay> {
    if (this.destroyed) {
      return Promise.reject(new VerifyWorkerError('검증 서비스가 종료 중입니다'));
    }
    this.inline ??= this.resolveInline();
    if (this.inline) {
      try {
        return Promise.resolve(verifyDefenseReplay(input));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new VerifyWorkerError(String(error)));
      }
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

  /** 워커 스크립트가 있는지 — 테스트가 대체한다 */
  protected workerScriptAvailable(): boolean {
    return existsSync(WORKER_SCRIPT);
  }

  private resolveInline(): boolean {
    if (this.workerScriptAvailable()) return false;
    this.logger.error(`검증 워커 스크립트가 없습니다(${WORKER_SCRIPT}) — ts 직접 실행으로 보고 메인 스레드에서 검증합니다. 운영이면 빌드 결과를 확인하세요`);
    return true;
  }

  /** 레플리카당 워커 수 — GAME_VERIFY_WORKERS(1~8), 없거나 잘못된 값이면 1 (§B7) */
  private workerCount(): number {
    const count = Number(this.configService.get<string>('GAME_VERIFY_WORKERS'));
    return Number.isInteger(count) && count >= 1 && count <= 8 ? count : 1;
  }
}

import type { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { toErrorMessage } from '../../common/utils/error.utils';

/**
 * 하트비트·생존 확인 Redis 부품 (게임 공용). 키는 GameRoomKeys의 heartbeat·heartbeatProbe·probe를 쓴다.
 * 판정 규칙(누구를 끊김으로 볼지)은 방 서비스가 정한다.
 */

/** 간격 게이트(SET NX PX) — 레플리카 공통으로 intervalMs에 1번만 true */
export async function acquireIntervalGate(redis: Redis, key: string, intervalMs: number): Promise<boolean> {
  return (await redis.set(key, '1', 'PX', intervalMs, 'NX')) === 'OK';
}

/** 마지막 하트비트 기록 — ttlMs 안에 다시 쓰지 않으면 사라진다 */
export async function touchHeartbeat(redis: Redis, key: string, ttlMs: number): Promise<void> {
  await redis.set(key, '1', 'PX', ttlMs);
}

/**
 * presencePing 응답 기록 — 실패해도 던지지 않는다(로그만). 기록됐으면 true — 방 서비스는 그때만 하트비트 판정을 시작한다
 */
export async function recordHeartbeatSafely(redis: Redis, key: string, ttlMs: number, logger: Logger, code: string): Promise<boolean> {
  try {
    await touchHeartbeat(redis, key, ttlMs);
    return true;
  } catch (error) {
    logger.warn(`하트비트 기록 실패: code=${code}, ${toErrorMessage(error)}`);
    return false;
  }
}

/** 기억을 Redis 만료보다 이만큼 먼저 놓는다 — SET이 Redis에 닿기까지의 지연 차이로 경계에서 건너뛰지 않게(리뷰 B-R2) */
const GATE_HOLD_SAFETY_MARGIN_MS = 500;

/**
 * 이 레플리카가 잡은 판정 게이트(acquireIntervalGate)를 기억해, 게이트가 살아 있는 동안의 SET NX 시도를 건너뛴다 —
 * 정상 상황에서 그 시도는 실패하므로 왕복만 아낀다(Redis 재시작·축출로 키가 PX보다 먼저 사라지면 최대 한 간격 늦을 수 있다).
 * 잡은 때만 기록하므로(시도 시각이 아니라) 다른 레플리카가 게이트를 쥐었거나 Redis가 실패한 경우는 예전처럼
 * 다음 하트비트에 다시 시도한다(리뷰 B-R1).
 * 시각은 단조 시계로 SET NX 직전에 잰다 — 하트비트 기록 왕복 지연·벽시계 조정에 흔들리지 않는다(리뷰 B-R3·R4).
 * 레플리카 간 "간격당 1번"은 Redis NX가 보장하고, 이 맵은 트리거 절약일 뿐 공유 상태가 아니다
 */
export class LocalGateHold {
  private readonly acquiredAt = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    /** 이보다 많아지면 간격이 지난 항목을 지운다(끝난 방의 키가 남지 않게) */
    private readonly pruneAbove = 1000,
  ) {}

  /** 단조 시계(ms) — SET NX 직전에 재서 isHeld·markAcquired에 같은 값을 넘긴다(Redis PX 시작보다 앞서므로 기억이 먼저 끝난다) */
  now(): number {
    return performance.now();
  }

  /** at(= now())에 이 레플리카가 잡은 게이트가 아직 살아 있으면 true — 그 SET NX는 실패할 것이 뻔하다 */
  isHeld(key: string, at: number): boolean {
    const acquired = this.acquiredAt.get(key);
    return acquired !== undefined && at - acquired < this.intervalMs - GATE_HOLD_SAFETY_MARGIN_MS;
  }

  /** 게이트를 잡았을 때만 부른다. at은 그 SET NX 직전에 잰 now() */
  markAcquired(key: string, at: number): void {
    if (this.acquiredAt.size >= this.pruneAbove) {
      for (const [k, t] of this.acquiredAt) if (at - t >= this.intervalMs) this.acquiredAt.delete(k);
    }
    this.acquiredAt.set(key, at);
  }
}

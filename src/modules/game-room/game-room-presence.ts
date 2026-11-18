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

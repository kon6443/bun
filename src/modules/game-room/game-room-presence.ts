import type { Redis } from 'ioredis';

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

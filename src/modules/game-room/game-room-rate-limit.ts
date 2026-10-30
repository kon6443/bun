import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { GameRoomKeys } from './game-room-keys';

/** action → 한도. 게임마다 자기 표를 넘긴다(예: TETRIS_BATTLE_RATE_LIMITS) */
export type GameRoomRateLimits<A extends string> = Readonly<Record<A, { readonly limit: number; readonly windowSec: number }>>;

/** 고정 윈도 빈도 제한 (Redis INCR + EXPIRE NX, 게임 공용) — 키 `{prefix}rl:{action}:{subject}` */
export class GameRoomRateLimiter<A extends string> {
  constructor(
    private readonly keys: Pick<GameRoomKeys, 'rateLimit'>,
    private readonly limits: GameRoomRateLimits<A>,
    private readonly logger: Logger,
  ) {}

  /**
   * 한도 안이면 true.
   * Redis 명령이 실패하면 통과시킨다(팀 채팅 레이트 리밋과 같은 fail-open — 보조 방어선 때문에 기능 전체를 막지 않는다).
   */
  async consume(redis: Redis, action: A, subject: string): Promise<boolean> {
    const { limit, windowSec } = this.limits[action];
    const key = this.keys.rateLimit(action, subject);
    try {
      // MULTI: INCR과 TTL 설정 사이에 키가 TTL 없이 남지 않게. NX: 윈도 시작 때만 TTL
      const results = await redis.multi().incr(key).expire(key, windowSec, 'NX').exec();
      return Number(results?.[0]?.[1] ?? 0) <= limit;
    } catch (error) {
      this.logger.warn(`빈도 제한 확인 실패 — 통과: action=${action}, ${(error as Error).message}`);
      return true;
    }
  }
}

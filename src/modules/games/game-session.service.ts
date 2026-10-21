import { randomInt, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { GameType } from '../../entities/GameScore';
import { GAME_SESSION_TTL_SECONDS } from '../../common/constants/app.constants';
import { toErrorDetail } from '../../common/utils/error.utils';
import { GameSessionUnavailableErrorResponseDto } from './games-error.dto';

/**
 * 게임 세션 (docs/tasks/games DESIGN.md §2)
 *
 * Redis 키 패턴 (game: prefix):
 * - game:session:{sessionId} → JSON { gameType, seed, engineVersion, startedAt, userId } (TTL 2시간)
 *
 * 레플리카 여러 대가 같은 세션을 봐야 하므로 인메모리에 두지 않는다. 제출 시 GETDEL로 꺼내 1회만 쓴다.
 * Redis 클라이언트는 main.ts에서 RedisIoAdapter 초기화 후 주입한다(OnlineUserService와 같은 방식).
 */
export interface GameSession {
  gameType: GameType;
  seed: number;
  engineVersion: number;
  /** 서버 발급 시각 (epoch ms) — 리플레이 프레임 수와 실제 경과 시간 비교 기준 */
  startedAt: number;
  userId: number | null;
}

/** seed 범위 0 ~ 2^32 − 1 (randomInt의 상한은 미포함) */
const SEED_UPPER_EXCLUSIVE = 2 ** 32;

const sessionKey = (sessionId: string) => `game:session:${sessionId}`;

@Injectable()
export class GameSessionService {
  private readonly logger = new Logger(GameSessionService.name);
  private redis: Redis | null = null;

  /** main.ts에서 RedisIoAdapter 초기화 후 호출 */
  setRedisClient(client: Redis): void {
    this.redis = client;
  }

  async createSession({
    gameType,
    engineVersion,
    userId,
  }: {
    gameType: GameType;
    engineVersion: number;
    userId: number | null;
  }): Promise<{ sessionId: string; session: GameSession; expiresAt: Date }> {
    const redis = this.requireRedis();
    const sessionId = randomUUID();
    const session: GameSession = {
      gameType,
      seed: randomInt(0, SEED_UPPER_EXCLUSIVE),
      engineVersion,
      startedAt: Date.now(),
      userId,
    };

    try {
      await redis.set(sessionKey(sessionId), JSON.stringify(session), 'EX', GAME_SESSION_TTL_SECONDS);
    } catch (error) {
      this.logger.error('createSession() Redis 오류:', toErrorDetail(error));
      throw new GameSessionUnavailableErrorResponseDto();
    }

    return { sessionId, session, expiresAt: new Date(session.startedAt + GAME_SESSION_TTL_SECONDS * 1000) };
  }

  /** 세션을 꺼내면서 지운다(1회용). 없거나 만료면 null */
  async consumeSession(sessionId: string): Promise<GameSession | null> {
    const redis = this.requireRedis();
    let raw: string | null;
    try {
      raw = await redis.getdel(sessionKey(sessionId));
    } catch (error) {
      this.logger.error('consumeSession() Redis 오류:', toErrorDetail(error));
      throw new GameSessionUnavailableErrorResponseDto();
    }
    return raw ? (JSON.parse(raw) as GameSession) : null;
  }

  private requireRedis(): Redis {
    if (!this.redis || this.redis.status !== 'ready') {
      throw new GameSessionUnavailableErrorResponseDto();
    }
    return this.redis;
  }
}

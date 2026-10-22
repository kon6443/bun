import { randomInt, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { GameType } from '../../entities/GameScore';
import { toErrorDetail } from '../../common/utils/error.utils';
import { GameSessionUnavailableErrorResponseDto } from './games-error.dto';

/**
 * 게임 세션 (docs/tasks/games DESIGN.md §2)
 *
 * Redis 키 패턴 (game: prefix):
 * - game:session:{sessionId} → JSON { gameType, boardKey, seed, engineVersion, startedAt, userId } (TTL = 엔진별 sessionTtlSeconds)
 *
 * 레플리카 여러 대가 같은 세션을 봐야 하므로 인메모리에 두지 않는다.
 * 제출 시 GET으로 읽어 검증하고, 검증 결과가 확정된 뒤에만 GETDEL로 1회 소모한다 — 검증이 밀려 실패해도 세션이 남아 재시도할 수 있다(defense DESIGN §B4).
 * Redis 클라이언트는 main.ts에서 RedisIoAdapter 초기화 후 주입한다(OnlineUserService와 같은 방식).
 */
export interface GameSession {
  gameType: GameType;
  /**
   * 이 판이 등록될 랭킹 보드 — 발급 시 서버가 정하고 제출 때 그대로 쓴다(클라이언트가 보드를 바꿔 내지 못하게).
   * 보드 도입 전에 발급된 세션에는 없다 — 제출 시 엔진 기본 보드로 본다
   */
  boardKey?: string;
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
    boardKey,
    seed,
    engineVersion,
    userId,
    ttlSeconds,
  }: {
    gameType: GameType;
    boardKey: string;
    /** 보드가 정한 seed(주간 도전처럼 전원 동일). null이면 무작위 */
    seed: number | null;
    engineVersion: number;
    userId: number | null;
    ttlSeconds: number;
  }): Promise<{ sessionId: string; session: GameSession; expiresAt: Date }> {
    const redis = this.requireRedis();
    const sessionId = randomUUID();
    const session: GameSession = {
      gameType,
      boardKey,
      seed: seed ?? randomInt(0, SEED_UPPER_EXCLUSIVE),
      engineVersion,
      startedAt: Date.now(),
      userId,
    };

    try {
      await redis.set(sessionKey(sessionId), JSON.stringify(session), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.error('createSession() Redis 오류:', toErrorDetail(error));
      throw new GameSessionUnavailableErrorResponseDto();
    }

    return { sessionId, session, expiresAt: new Date(session.startedAt + ttlSeconds * 1000) };
  }

  /** 세션을 지우지 않고 읽는다(검증 전). 없거나 만료면 null */
  async getSession(sessionId: string): Promise<GameSession | null> {
    const redis = this.requireRedis();
    let raw: string | null;
    try {
      raw = await redis.get(sessionKey(sessionId));
    } catch (error) {
      this.logger.error('getSession() Redis 오류:', toErrorDetail(error));
      throw new GameSessionUnavailableErrorResponseDto();
    }
    return raw ? (JSON.parse(raw) as GameSession) : null;
  }

  /** 세션을 꺼내면서 지운다(1회용). 없거나 만료면 null — 같은 세션을 동시에 낸 두 요청 중 하나만 받는다 */
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

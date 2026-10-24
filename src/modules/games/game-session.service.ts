import { randomBytes, randomInt, randomUUID } from 'node:crypto';
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
 * - game:session:{sessionId}:verifying → 검증 진행 가드, 값 = 소유 토큰 (TTL 60초)
 * - game:session:{sessionId}:timeouts → 검증 시간 초과 횟수 (TTL = 세션 TTL)
 *
 * 레플리카 여러 대가 같은 세션을 봐야 하므로 인메모리에 두지 않는다.
 * 제출 시 GET으로 읽어 검증하고, 검증 결과가 확정된 뒤에만 GETDEL로 1회 소모한다 — 검증이 밀려 실패해도 세션이 남아 재시도할 수 있다(defense DESIGN §B4).
 * Redis 클라이언트는 main.ts에서 RedisIoAdapter 초기화 후 주입한다(OnlineUserService와 같은 방식).
 */
export interface GameSession {
  gameType: GameType;
  /** 이 판이 등록될 랭킹 보드 — 발급 시 서버가 정하고 제출 때 그대로 쓴다(클라이언트가 보드를 바꿔 내지 못하게) */
  boardKey: string;
  seed: number;
  engineVersion: number;
  /** 서버 발급 시각 (epoch ms) — 리플레이 프레임 수와 실제 경과 시간 비교 기준 */
  startedAt: number;
  /** 발급 때 로그인 사용자(기록용) — 등록 귀속은 제출 시점 로그인 사용자다(세션은 토큰에 묶지 않는다) */
  userId: number | null;
}

/** seed 범위 0 ~ 2^32 − 1 (randomInt의 상한은 미포함) */
const SEED_UPPER_EXCLUSIVE = 2 ** 32;

const sessionKey = (sessionId: string) => `game:session:${sessionId}`;
const verifyingKey = (sessionId: string) => `game:session:${sessionId}:verifying`;
const timeoutsKey = (sessionId: string) => `game:session:${sessionId}:timeouts`;

/** 검증 진행 가드 TTL(초) — 최악 대기(워커 1개·대기열 4 × 시간 상한 5초 + 자기 5초 = 25초) + DB 저장보다 넉넉히 */
const VERIFY_GUARD_TTL_SECONDS = 60;

/** 가드 값이 내 토큰일 때만 지운다 — 만료 뒤 다른 요청이 잡은 가드를 지우지 않게 */
const RELEASE_GUARD_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

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

  /**
   * 검증 진행 가드 — 같은 세션을 동시에 여러 번 내도 검증(워커 CPU)은 하나만 돈다(games-polish BD-01).
   * 잡으면 소유 토큰, 이미 잡혀 있으면 null. 결과가 정해지면 그 토큰으로 releaseVerification한다. 프로세스가 죽어도 TTL 뒤 풀린다
   */
  async claimVerification(sessionId: string): Promise<string | null> {
    const redis = this.requireRedis();
    const token = randomBytes(16).toString('hex');
    try {
      return (await redis.set(verifyingKey(sessionId), token, 'EX', VERIFY_GUARD_TTL_SECONDS, 'NX')) === 'OK' ? token : null;
    } catch (error) {
      this.logger.error('claimVerification() Redis 오류:', toErrorDetail(error));
      throw new GameSessionUnavailableErrorResponseDto();
    }
  }

  /** 검증 진행 가드 해제 — 내 토큰일 때만. 실패해도 TTL로 풀리므로 던지지 않는다 */
  async releaseVerification(sessionId: string, token: string): Promise<void> {
    try {
      await this.redis?.eval(RELEASE_GUARD_SCRIPT, 1, verifyingKey(sessionId), token);
    } catch (error) {
      this.logger.warn(`releaseVerification() Redis 오류: ${toErrorDetail(error)}`);
    }
  }

  /** 이 세션의 검증 시간 초과 횟수를 1 올리고 돌려준다(games-polish BD-02). 키 TTL은 세션 TTL과 같다 */
  async recordVerifyTimeout(sessionId: string, ttlSeconds: number): Promise<number> {
    const redis = this.requireRedis();
    try {
      const [[, count]] = (await redis.multi().incr(timeoutsKey(sessionId)).expire(timeoutsKey(sessionId), ttlSeconds).exec()) as [
        [Error | null, number],
        [Error | null, number],
      ];
      return count;
    } catch (error) {
      this.logger.error('recordVerifyTimeout() Redis 오류:', toErrorDetail(error));
      throw new GameSessionUnavailableErrorResponseDto();
    }
  }

  /**
   * 소모한 세션을 되돌린다 — 확정 결과를 저장하다 DB가 실패했을 때 같은 세션으로 다시 낼 수 있게(games-polish BD-03).
   * 남은 TTL만큼만, 이미 같은 키가 있으면 덮지 않는다. 만료가 지났으면 되돌리지 않고 false
   */
  async restoreSession(sessionId: string, session: GameSession, ttlSeconds: number): Promise<boolean> {
    const remainingSeconds = Math.floor((session.startedAt + ttlSeconds * 1000 - Date.now()) / 1000);
    if (remainingSeconds <= 0) return false;
    try {
      return (await this.requireRedis().set(sessionKey(sessionId), JSON.stringify(session), 'EX', remainingSeconds, 'NX')) === 'OK';
    } catch (error) {
      this.logger.error('restoreSession() Redis 오류:', toErrorDetail(error));
      return false;
    }
  }

  private requireRedis(): Redis {
    if (!this.redis || this.redis.status !== 'ready') {
      throw new GameSessionUnavailableErrorResponseDto();
    }
    return this.redis;
  }
}

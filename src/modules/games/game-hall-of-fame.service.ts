import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import { And, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { GameScore, GameType } from '../../entities/GameScore';
import { toErrorDetail } from '../../common/utils/error.utils';
import { GAME_HALL_OF_FAME_CACHE_SECONDS } from '../../common/constants/app.constants';
import { GAME_ENGINE_REGISTRY, GameEngineRegistry, HallOfFamePeriod } from './game-engine.registry';

/** 시상대 기록 — 랭킹 항목 컬럼 + 배지 계산용 USER_ID(응답에는 싣지 않는다) */
export type PodiumRow = Pick<GameScore, 'scoreId' | 'boardKey' | 'playerName' | 'score' | 'detail' | 'durationMs' | 'crtdAt' | 'userId'>;

export interface HallOfFamePodium extends HallOfFamePeriod {
  /** 1~3위 (순위 순) */
  rows: PodiumRow[];
}

/** 로그인 사용자의 입상 횟수 — 명예의 전당 범위 안 */
export interface Trophies {
  gold: number;
  silver: number;
  bronze: number;
}

const PODIUM_SIZE = 3;
const TROPHY_KEYS = ['gold', 'silver', 'bronze'] as const;

const cacheKey = (gameType: GameType) => `game:hall-of-fame:${gameType}`;

/** 시상대 → 사용자 ID별 입상 횟수. 비로그인 기록(USER_ID null)은 세지 않는다 — 이름은 누구나 쓸 수 있어 사칭이 된다(D-007) */
export function trophiesFromPodiums(podiums: HallOfFamePodium[]): Map<number, Trophies> {
  const trophies = new Map<number, Trophies>();
  for (const { rows } of podiums) {
    rows.forEach((row, index) => {
      if (row.userId === null) return;
      const entry = trophies.get(row.userId) ?? { gold: 0, silver: 0, bronze: 0 };
      entry[TROPHY_KEYS[index]] += 1;
      trophies.set(row.userId, entry);
    });
  }
  return trophies;
}

/**
 * 명예의 전당 — 지난 기간별 1~3위와 로그인 사용자 배지 (docs/tasks/games-growth D-007·D-010)
 *
 * 기록은 등록 뒤 바뀌지 않으므로 조회 시점에 계산한다(스냅샷 테이블·스케줄러 없음). 숨김은 다음 계산부터 반영된다.
 * 랭킹 목록마다 배지를 붙이므로 결과를 Redis에 캐시한다(game:hall-of-fame:{gameType}, TTL 10분 — 숨김도 최대 10분 늦게 반영).
 * 캐시가 비는 순간 같은 레플리카의 동시 요청은 계산 하나를 함께 기다린다(진행 중 Promise 공유 — 결과 보관이 아니라 중복 쿼리 방지).
 * Redis를 못 쓰면 명예의 전당 조회는 매번 계산하고, 랭킹의 배지는 건너뛴다(배지 때문에 랭킹마다 기간 수만큼 쿼리하지 않게).
 * Redis 클라이언트는 main.ts가 주입한다(GameSessionService와 같은 방식).
 */
@Injectable()
export class GameHallOfFameService {
  private readonly logger = new Logger(GameHallOfFameService.name);
  private redis: Redis | null = null;
  /** 게임별 진행 중인 계산 — 끝나면 지운다 */
  private readonly inFlight = new Map<GameType, Promise<HallOfFamePodium[]>>();

  constructor(
    @InjectRepository(GameScore)
    private readonly gameScoreRepository: Repository<GameScore>,
    @Inject(GAME_ENGINE_REGISTRY)
    private readonly engines: GameEngineRegistry,
  ) {}

  /** main.ts에서 RedisIoAdapter 초기화 후 호출 */
  setRedisClient(client: Redis): void {
    this.redis = client;
  }

  /** 기간별 1~3위 (최근 기간 먼저). 기록이 없는 기간은 뺀다 */
  async getPodiums(gameType: GameType): Promise<HallOfFamePodium[]> {
    const cached = await this.readCache(gameType);
    if (cached) {
      return cached;
    }
    const running = this.inFlight.get(gameType);
    if (running) {
      return running;
    }
    const computing = this.computeAndCache(gameType).finally(() => this.inFlight.delete(gameType));
    this.inFlight.set(gameType, computing);
    return computing;
  }

  /** 랭킹 목록용 배지 — Redis를 못 쓰면 빈 Map(배지 생략). 명예의 전당 화면은 getPodiums로 매번 계산한다 */
  async trophiesByUser(gameType: GameType): Promise<Map<number, Trophies>> {
    if (!this.readyRedis()) {
      return new Map();
    }
    return trophiesFromPodiums(await this.getPodiums(gameType));
  }

  private async computeAndCache(gameType: GameType): Promise<HallOfFamePodium[]> {
    const periods = this.engines[gameType].hallOfFamePeriods(new Date());
    // 기간별 상위 3건 — 서로 독립이라 함께 보낸다(지난 8주 + 7일 = 최대 15건, 10분 캐시)
    const podiums = await Promise.all(periods.map(async (period) => ({ ...period, rows: await this.topOf(gameType, period) })));
    const filled = podiums.filter((podium) => podium.rows.length > 0);
    await this.writeCache(gameType, filled);
    return filled;
  }

  /** 한 기간의 1~3위 — 랭킹과 같은 정렬(점수 DESC, 같으면 SCORE_ID ASC). 기간 필터 보드는 등록 시각 범위로 */
  private topOf(gameType: GameType, { boardKey, startsAt, endsAt }: HallOfFamePeriod): Promise<PodiumRow[]> {
    const byCreatedAt = this.engines[gameType].isPeriodRanking(boardKey);
    return this.gameScoreRepository.find({
      select: { scoreId: true, boardKey: true, playerName: true, score: true, detail: true, durationMs: true, crtdAt: true, userId: true },
      where: { gameType, boardKey, isHidden: 0, ...(byCreatedAt && { crtdAt: And(MoreThanOrEqual(startsAt), LessThan(endsAt)) }) },
      order: { score: 'DESC', scoreId: 'ASC' },
      take: PODIUM_SIZE,
    });
  }

  /** 쓸 수 있는 Redis 클라이언트 — 미주입·연결 끊김이면 null */
  private readyRedis(): Redis | null {
    return this.redis?.status === 'ready' ? this.redis : null;
  }

  private async readCache(gameType: GameType): Promise<HallOfFamePodium[] | null> {
    const redis = this.readyRedis();
    if (!redis) return null;
    try {
      const raw = await redis.get(cacheKey(gameType));
      if (!raw) return null;
      // JSON에서 Date가 문자열로 돌아온다 — 되살린다
      return (JSON.parse(raw) as HallOfFamePodium[]).map((podium) => ({
        ...podium,
        startsAt: new Date(podium.startsAt),
        endsAt: new Date(podium.endsAt),
        rows: podium.rows.map((row) => ({ ...row, crtdAt: new Date(row.crtdAt) })),
      }));
    } catch (error) {
      this.logger.warn(`readCache() Redis 오류 — 다시 계산한다: ${toErrorDetail(error)}`);
      return null;
    }
  }

  private async writeCache(gameType: GameType, podiums: HallOfFamePodium[]): Promise<void> {
    const redis = this.readyRedis();
    if (!redis) return;
    try {
      await redis.set(cacheKey(gameType), JSON.stringify(podiums), 'EX', GAME_HALL_OF_FAME_CACHE_SECONDS);
    } catch (error) {
      this.logger.warn(`writeCache() Redis 오류: ${toErrorDetail(error)}`);
    }
  }
}

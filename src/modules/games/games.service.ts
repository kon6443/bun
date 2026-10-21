import { createHmac } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, MoreThanOrEqual, Repository } from 'typeorm';
import { GAME_TYPES, GameScore, GameType } from '../../entities/GameScore';
import { GameReplay } from '../../entities/GameReplay';
import {
  GAME_RANKING_DEFAULT_LIMIT,
  GAME_REPLAY_TIME_TOLERANCE_MS,
} from '../../common/constants/app.constants';
import { toErrorDetail } from '../../common/utils/error.utils';
import { GameSessionService } from './game-session.service';
import { GAME_ENGINE_REGISTRY, GameEngineRegistry, ReplayInput } from './game-engine.registry';
import { checkPlayerName } from './player-name-policy';
import { rankingPeriodStart } from './ranking-period';
import {
  GameReplayDetailDto,
  GameScoreSubmittedDto,
  GameSessionDto,
  GetRankingsQueryDto,
  RANKING_PERIODS,
  RankingItemDto,
  RankingListDto,
  RankingPeriod,
  SubmitGameScoreDto,
} from './games.dto';
import {
  GameNotFoundErrorResponseDto,
  GamePlayerNameForbiddenErrorResponseDto,
  GamePlayerNameInvalidErrorResponseDto,
  GameReplayInvalidErrorResponseDto,
  GameScoreNotFoundErrorResponseDto,
  GameSessionInvalidErrorResponseDto,
} from './games-error.dto';

/** 엔진은 60fps 고정 틱 (DESIGN §5) */
const FRAMES_PER_SECOND = 60;

/** gzip 안에 저장하는 리플레이 본문 — seed·engineVersion은 컬럼에 따로 둔다 */
interface StoredReplay {
  das: number;
  arr: number;
  frames: number;
  inputs: number[];
}

/**
 * 게임 모음집 — 세션 발급 · 리플레이 검증 후 랭킹 등록 · 랭킹 · 리플레이 조회 (docs/tasks/games DESIGN.md)
 *
 * 점수는 클라이언트가 보내지 않는다. 서버가 발급한 seed와 제출된 입력 기록을 엔진으로 재실행해 계산한다(D-005).
 * 비로그인도 이름으로 등록한다(D-003) — 신원 대신 1회용 세션·실시간 검사·금칙어·스로틀로 막는다.
 */
@Injectable()
export class GamesService {
  private readonly logger = new Logger(GamesService.name);

  constructor(
    @InjectRepository(GameScore)
    private readonly gameScoreRepository: Repository<GameScore>,
    @InjectRepository(GameReplay)
    private readonly gameReplayRepository: Repository<GameReplay>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(GAME_ENGINE_REGISTRY)
    private readonly engines: GameEngineRegistry,
    private readonly gameSessionService: GameSessionService,
    private readonly configService: ConfigService,
  ) {}

  /** 경로의 게임 이름(소문자) → 코드값. 모르는 게임은 404 */
  toGameType(gameTypeParam: string): GameType {
    const gameType = gameTypeParam.toUpperCase();
    if (!(GAME_TYPES as readonly string[]).includes(gameType)) {
      throw new GameNotFoundErrorResponseDto();
    }
    return gameType as GameType;
  }

  async createSession(gameTypeParam: string, userId: number | null): Promise<GameSessionDto> {
    const gameType = this.toGameType(gameTypeParam);
    const { engineVersion } = this.engines[gameType];
    const { sessionId, session, expiresAt } = await this.gameSessionService.createSession({ gameType, engineVersion, userId });
    return { sessionId, seed: session.seed, engineVersion, expiresAt };
  }

  /**
   * 리플레이 검증 후 랭킹 등록 (DESIGN §4-2).
   * 이름 검사는 세션을 쓰기 전에 한다 — 이름만 바꿔 다시 낼 수 있게.
   */
  async submitScore({
    gameTypeParam,
    dto,
    userId,
    ip,
  }: {
    gameTypeParam: string;
    dto: SubmitGameScoreDto;
    userId: number | null;
    ip: string | undefined;
  }): Promise<GameScoreSubmittedDto> {
    const gameType = this.toGameType(gameTypeParam);
    const nameProblem = checkPlayerName(dto.playerName);
    if (nameProblem === 'INVALID') {
      throw new GamePlayerNameInvalidErrorResponseDto();
    }
    if (nameProblem === 'FORBIDDEN') {
      throw new GamePlayerNameForbiddenErrorResponseDto();
    }

    const engine = this.engines[gameType];
    const session = await this.gameSessionService.consumeSession(dto.sessionId);
    if (
      !session ||
      session.gameType !== gameType ||
      session.engineVersion !== engine.engineVersion ||
      dto.replay.engineVersion !== engine.engineVersion
    ) {
      throw new GameSessionInvalidErrorResponseDto();
    }

    const { das, arr, frames, inputs } = dto.replay;
    // 실시간 검사: 게임 시간이 서버가 잰 경과 시간보다 길 수 없다(빨리 감기·미리 계산한 입력 차단)
    const playedMs = (frames * 1000) / FRAMES_PER_SECOND;
    if (playedMs > Date.now() - session.startedAt + GAME_REPLAY_TIME_TOLERANCE_MS) {
      this.logger.warn(`submitScore(): 실제 경과 시간 초과 — frames=${frames}, elapsed=${Date.now() - session.startedAt}ms`);
      throw new GameReplayInvalidErrorResponseDto();
    }

    const replayInput: ReplayInput = { seed: session.seed, das, arr, frames, inputs };
    const verified = engine.verify(replayInput);
    if (!verified.ok) {
      this.logger.warn(`submitScore(): 리플레이 재현 실패 — ${gameType} reason=${verified.reason}`);
      throw new GameReplayInvalidErrorResponseDto();
    }

    const crtdAt = new Date();
    const storedReplay: StoredReplay = { das, arr, frames, inputs };
    const saved = await this.dataSource.transaction(async (manager: EntityManager) => {
      const score = await manager.save(
        manager.create(GameScore, {
          gameType,
          score: verified.score,
          playerName: dto.playerName,
          userId,
          durationMs: Math.round(playedMs),
          detail: JSON.stringify(verified.detail),
          ipHash: this.hashIp(ip),
          isHidden: 0,
          crtdAt,
        }),
      );
      await manager.save(
        manager.create(GameReplay, {
          scoreId: score.scoreId,
          gameType,
          engineVersion: engine.engineVersion,
          seed: session.seed,
          replay: gzipSync(JSON.stringify(storedReplay)),
          crtdAt,
        }),
      );
      return score;
    });

    // 기록은 이미 커밋됐고 세션도 소모됐다 — 순위 계산이 실패해도 등록 성공(201)은 지킨다(재시도하면 409라 결과를 잃는다)
    let ranks: GameScoreSubmittedDto['ranks'] = null;
    try {
      ranks = await this.computeRanks(gameType, saved.scoreId, verified.score, crtdAt);
    } catch (error) {
      this.logger.error(`submitScore(): 순위 계산 실패 — scoreId=${saved.scoreId}`, toErrorDetail(error));
    }
    return { scoreId: saved.scoreId, score: verified.score, detail: verified.detail, ranks };
  }

  /** 기간별 랭킹 — SCORE DESC, 같은 점수면 먼저 저장된 기록(SCORE_ID 작은 쪽)이 위. 숨김 제외 */
  async getRankings(gameTypeParam: string, query: GetRankingsQueryDto): Promise<RankingListDto> {
    const gameType = this.toGameType(gameTypeParam);
    const periodStart = rankingPeriodStart(query.period ?? 'all');
    const rows = await this.gameScoreRepository.find({
      // IP_HASH·USER_ID는 응답에 싣지 않는다
      select: { scoreId: true, playerName: true, score: true, detail: true, durationMs: true, crtdAt: true },
      where: { gameType, isHidden: 0, ...(periodStart && { crtdAt: MoreThanOrEqual(periodStart) }) },
      // 동점은 SCORE_ID(IDENTITY = 실제 INSERT 순서)로만 가른다 — rankOf와 같은 규칙. CRTD_AT은 앱 시각이라 레플리카·풀 대기에 따라 ID 순서와 어긋날 수 있다
      order: { score: 'DESC', scoreId: 'ASC' },
      take: query.limit ?? GAME_RANKING_DEFAULT_LIMIT,
    });

    return {
      items: rows.map((row, index) => this.toRankingItem(row, index + 1)),
      periodStart,
    };
  }

  /** 기록 요약 — 누구나 조회, 숨김·없음은 404. 링크 미리보기(OG)용이라 리플레이 입력은 싣지 않는다 (docs/tasks/game-share D-008) */
  async getScore(gameTypeParam: string, scoreId: number): Promise<RankingItemDto> {
    const gameType = this.toGameType(gameTypeParam);
    const score = await this.findVisibleScore(gameType, scoreId);
    return this.toRankingItem(score, await this.rankOf(gameType, { scoreId: score.scoreId, score: score.score }, null));
  }

  /** 리플레이 재생 데이터 — 누구나 조회, 숨김 기록은 404 (D-011) */
  async getReplay(gameTypeParam: string, scoreId: number): Promise<GameReplayDetailDto> {
    const gameType = this.toGameType(gameTypeParam);
    const score = await this.findVisibleScore(gameType, scoreId);
    const replay = await this.gameReplayRepository.findOneBy({ scoreId, gameType });
    if (!replay) {
      throw new GameScoreNotFoundErrorResponseDto();
    }

    const stored = JSON.parse(gunzipSync(replay.replay).toString('utf8')) as StoredReplay;
    return {
      ...this.toRankingItem(score, await this.rankOf(gameType, { scoreId: score.scoreId, score: score.score }, null)),
      engineVersion: replay.engineVersion,
      seed: replay.seed,
      das: stored.das,
      arr: stored.arr,
      frames: stored.frames,
      inputs: stored.inputs,
    };
  }

  /** 숨기지 않은 기록 1건 — 없으면 404. IP_HASH·USER_ID는 조회하지 않는다 */
  private async findVisibleScore(gameType: GameType, scoreId: number): Promise<GameScore> {
    const score = await this.gameScoreRepository.findOne({
      select: { scoreId: true, playerName: true, score: true, detail: true, durationMs: true, crtdAt: true },
      where: { scoreId, gameType, isHidden: 0 },
    });
    if (!score) {
      throw new GameScoreNotFoundErrorResponseDto();
    }
    return score;
  }

  /** 등록 직후 기간별 순위 — 기록이 그 기간에 속하므로 세 기간 모두 순위가 있다 */
  private async computeRanks(gameType: GameType, scoreId: number, score: number, crtdAt: Date) {
    const ranks = {} as Record<RankingPeriod, number>;
    for (const period of RANKING_PERIODS) {
      ranks[period] = await this.rankOf(gameType, { scoreId, score }, rankingPeriodStart(period, crtdAt));
    }
    return ranks;
  }

  /** 순위 = 앞서는 기록 수 + 1. getRankings 정렬과 같은 규칙 — 점수가 높거나, 같은 점수에 SCORE_ID가 작은 기록 */
  private async rankOf(gameType: GameType, target: { scoreId: number; score: number }, periodStart: Date | null): Promise<number> {
    const qb = this.gameScoreRepository
      .createQueryBuilder('s')
      .where('s.gameType = :gameType', { gameType })
      .andWhere('s.isHidden = 0')
      .andWhere('(s.score > :score OR (s.score = :score AND s.scoreId < :scoreId))', target);
    if (periodStart) {
      qb.andWhere('s.crtdAt >= :periodStart', { periodStart });
    }
    return (await qb.getCount()) + 1;
  }

  private toRankingItem(row: GameScore, rank: number): RankingItemDto {
    return {
      rank,
      scoreId: row.scoreId,
      playerName: row.playerName,
      score: row.score,
      detail: JSON.parse(row.detail) as Record<string, unknown>,
      durationMs: row.durationMs,
      createdAt: row.crtdAt,
    };
  }

  /** IP → HMAC-SHA256 hex. 원문 IP는 저장하지 않는다. 시크릿이 없으면 저장하지 않는다(D-010) */
  private hashIp(ip: string | undefined): string | null {
    const secret = this.configService.get<string>('GAME_IP_HASH_SECRET');
    if (!secret || !ip) {
      return null;
    }
    return createHmac('sha256', secret).update(ip).digest('hex');
  }
}

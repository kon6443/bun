import { createHash, createHmac } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, MoreThanOrEqual, QueryFailedError, Repository } from 'typeorm';
import { GAME_TYPES, GameScore, GameType } from '../../entities/GameScore';
import { GameReplay } from '../../entities/GameReplay';
import {
  GAME_RANKING_DEFAULT_LIMIT,
  GAME_REPLAY_TIME_TOLERANCE_MS,
  GAME_VERIFY_RETRY_AFTER_SECONDS,
  GAME_VERIFY_TIMEOUT_LIMIT,
  GAME_VERIFY_UNAVAILABLE_RETRY_AFTER_SECONDS,
} from '../../common/constants/app.constants';
import { toErrorDetail } from '../../common/utils/error.utils';
import { ApiValidationErrorResponseDto } from '../../common/dto/api-error.dto';
import { GameSession, GameSessionService } from './game-session.service';
import { VerifyQueueFullError, VerifyTimeoutError, VerifyUnavailableError } from './verify-worker-pool';
import { GAME_ENGINE_REGISTRY, GameEngineRegistry, VerifiedReplay } from './game-engine.registry';
import { checkPlayerName } from './player-name-policy';
import { rankingPeriodStart } from './ranking-period';
import {
  GameBoardListDto,
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
  GameReplayDuplicateErrorResponseDto,
  GameReplayInvalidErrorResponseDto,
  GameScoreNotFoundErrorResponseDto,
  GameSessionInvalidErrorResponseDto,
  GameVerifyBusyErrorResponseDto,
} from './games-error.dto';

/**
 * gzip 안에 저장하는 리플레이 본문 — seed·engineVersion은 컬럼에 따로 둔다.
 * 게임별 params를 최상위에 펼쳐 둔다 — 테트리스는 { das, arr, frames, inputs }로 이전 저장 형식과 같다
 */
type StoredReplay = { frames: number; inputs: number[] } & Record<string, number | number[]>;

/** 순위를 셀 기록 — 같은 보드 안에서만 비교한다 */
type RankTarget = Pick<GameScore, 'scoreId' | 'score' | 'boardKey'>;

/** 랭킹 항목으로 읽는 컬럼 — IP_HASH·USER_ID는 응답에 싣지 않으므로 조회하지 않는다 */
const RANKING_ITEM_SELECT = {
  scoreId: true,
  boardKey: true,
  playerName: true,
  score: true,
  detail: true,
  durationMs: true,
  crtdAt: true,
} as const;

/** params가 쓸 수 없는 키 — 저장 본문에서 params와 같은 층에 있다 */
const REPLAY_RESERVED_KEYS = ['frames', 'inputs'] as const;

/** 503 GAME_VERIFY_BUSY — 원인과 다시 낼 때까지 기다릴 시간을 details에 싣는다(컨트롤러가 Retry-After로도 보낸다, games-polish BD-04·BD-14) */
const verifyBusy = (reason: string, retryAfterSeconds: number) =>
  new GameVerifyBusyErrorResponseDto({ details: { reason, retryAfterSeconds } });

/** Oracle 유니크 위반(ORA-00001) — 메시지가 아니라 드라이버 에러 번호로 판정한다 */
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof QueryFailedError && (error.driverError as { errorNum?: number } | undefined)?.errorNum === 1;

/**
 * 같은 리플레이 판정용 해시(D-003) — 게임·보드·seed·params·frames·inputs.
 * params는 키를 정렬해 넣는다 — 클라이언트가 보낸 params의 키 순서만 바꿔 다른 해시를 만들지 못하게
 */
const hashReplay = (gameType: GameType, boardKey: string, seed: number, { frames, inputs, ...params }: StoredReplay): string => {
  const sortedParams = Object.keys(params)
    .sort()
    .map((key) => [key, params[key]]);
  return createHash('sha256').update(JSON.stringify({ gameType, boardKey, seed, params: sortedParams, frames, inputs })).digest('hex');
};

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

  /** 세션 발급 — board(플레이 방식)로 랭킹 보드·seed를 서버가 정한다. 생략하면 게임 기본 보드 (defense DESIGN §B3) */
  async createSession(gameTypeParam: string, userId: number | null, board?: string): Promise<GameSessionDto> {
    const gameType = this.toGameType(gameTypeParam);
    const engine = this.engines[gameType];
    const resolved = engine.resolveSessionBoard(board, new Date());
    if (!resolved) {
      throw new ApiValidationErrorResponseDto('지원하지 않는 플레이 방식입니다.');
    }
    const { sessionId, session, expiresAt } = await this.gameSessionService.createSession({
      gameType,
      boardKey: resolved.boardKey,
      seed: resolved.seed,
      engineVersion: engine.engineVersion,
      userId,
      ttlSeconds: engine.sessionTtlSeconds,
    });
    return { sessionId, seed: session.seed, engineVersion: engine.engineVersion, expiresAt, boardKey: resolved.boardKey, mode: resolved.mode };
  }

  /** 랭킹 보드 목록 — 현재·지난 보드 */
  listBoards(gameTypeParam: string): GameBoardListDto {
    const gameType = this.toGameType(gameTypeParam);
    return { items: this.engines[gameType].listBoards(new Date()) };
  }

  /**
   * 리플레이 검증 후 랭킹 등록 (games DESIGN §4-2, defense DESIGN §B4).
   * 형식·이름 검사는 세션을 쓰기 전에 한다 — 고쳐서 같은 세션으로 다시 낼 수 있게.
   * 세션은 결과가 확정된 뒤(성공·시간 초과·재현 실패)에만 소모한다. 검증기가 밀리거나 실패하면 503 + 세션 유지.
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
    const { frames, inputs } = dto.replay;
    const params = this.toReplayParams(dto.replay);
    // 게임별 상한·params 형식 — DTO는 모든 게임 공통 상한만 본다
    if (!params || frames > engine.maxFrames || inputs.length > engine.maxInputLength || !engine.isValidParams(params)) {
      throw new ApiValidationErrorResponseDto('리플레이 형식이 이 게임과 맞지 않습니다.');
    }

    // 엔진 버전이 다르면 배포 뒤 옛 화면이다 — 세션보다 먼저 봐서 "새로고침" 안내를 고를 수 있게(games-polish BD-04)
    if (dto.replay.engineVersion !== engine.engineVersion) {
      throw new GameSessionInvalidErrorResponseDto({ details: { reason: 'ENGINE_VERSION' } });
    }
    const session = await this.gameSessionService.getSession(dto.sessionId);
    if (!session) {
      // 없음·만료·이미 사용은 Redis에서 구분할 수 없다
      throw new GameSessionInvalidErrorResponseDto({ details: { reason: 'NOT_FOUND' } });
    }
    if (session.gameType !== gameType) {
      throw new GameSessionInvalidErrorResponseDto({ details: { reason: 'GAME_MISMATCH' } });
    }
    if (session.engineVersion !== engine.engineVersion) {
      throw new GameSessionInvalidErrorResponseDto({ details: { reason: 'ENGINE_VERSION' } });
    }

    // 실시간 검사: 최대 배속으로 돌려도 서버가 잰 경과 시간보다 길 수 없다(빨리 감기·미리 계산한 입력 차단)
    const playedMs = (frames * 1000) / engine.ticksPerSecond;
    if (playedMs / engine.maxSpeed > Date.now() - session.startedAt + GAME_REPLAY_TIME_TOLERANCE_MS) {
      this.logger.warn(`submitScore(): 실제 경과 시간 초과 — frames=${frames}, elapsed=${Date.now() - session.startedAt}ms`);
      // 확정 결과 — 같은 세션으로 기다렸다 다시 내지 못하게 소모한다(이전 테트리스 동작과 같음)
      await this.gameSessionService.consumeSession(dto.sessionId);
      throw new GameReplayInvalidErrorResponseDto({ details: { reason: 'ELAPSED_TIME' } });
    }

    // 보드는 세션이 정한 값
    const boardKey = session.boardKey;
    const storedReplay: StoredReplay = { ...params, frames, inputs };
    // 같은 보드에 같은 리플레이는 한 번만(D-003) — 검증(CPU) 전에 걸러 낸다. 동시 제출은 유니크 인덱스가 막는다
    const replayHash = hashReplay(gameType, boardKey, session.seed, storedReplay);
    if (await this.gameScoreRepository.exists({ where: { replayHash } })) {
      await this.gameSessionService.consumeSession(dto.sessionId);
      throw new GameReplayDuplicateErrorResponseDto();
    }

    // 같은 세션을 동시에 여러 번 내도 검증은 하나만(BD-01) — 그 결과가 정해진 뒤 다시 내면 409(소모됨) 또는 재시도
    const guard = await this.gameSessionService.claimVerification(dto.sessionId);
    if (!guard) {
      throw verifyBusy('IN_PROGRESS', GAME_VERIFY_RETRY_AFTER_SECONDS);
    }
    let saved: GameScore;
    let verified: VerifiedReplay & { ok: true };
    let crtdAt: Date;
    try {
      ({ saved, verified, crtdAt } = await this.verifyAndSave({ gameType, dto, userId, ip, session, boardKey, params, storedReplay, replayHash, playedMs }));
    } finally {
      await this.gameSessionService.releaseVerification(dto.sessionId, guard);
    }
    // 기록은 이미 커밋됐고 세션도 소모됐다 — 순위 계산이 실패해도 등록 성공(201)은 지킨다(재시도하면 409라 결과를 잃는다)
    let ranks: GameScoreSubmittedDto['ranks'] = null;
    try {
      ranks = await this.computeRanks(gameType, { scoreId: saved.scoreId, score: verified.score, boardKey }, crtdAt);
    } catch (error) {
      this.logger.error(`submitScore(): 순위 계산 실패 — scoreId=${saved.scoreId}`, toErrorDetail(error));
    }
    // 이름은 DTO가 정리한 값으로 저장됐다 — 클라이언트가 보낸 원문과 다를 수 있어 저장값을 돌려준다(games-polish Q-S2)
    return { scoreId: saved.scoreId, score: verified.score, playerName: dto.playerName, detail: verified.detail, ranks };
  }

  /**
   * 검증 → 세션 소모 → 저장. 세션은 결과가 확정된 뒤에만 소모한다 — 검증이 밀리거나 실패하면 503 + 세션 유지,
   * 저장이 실패하면 세션을 되돌리고 503(같은 세션으로 다시 낸다, games-polish BD-03)
   */
  private async verifyAndSave({
    gameType,
    dto,
    userId,
    ip,
    session,
    boardKey,
    params,
    storedReplay,
    replayHash,
    playedMs,
  }: {
    gameType: GameType;
    dto: SubmitGameScoreDto;
    userId: number | null;
    ip: string | undefined;
    session: GameSession;
    boardKey: string;
    params: Record<string, number>;
    storedReplay: StoredReplay;
    replayHash: string;
    playedMs: number;
  }): Promise<{ saved: GameScore; verified: VerifiedReplay & { ok: true }; crtdAt: Date }> {
    const engine = this.engines[gameType];
    const { frames, inputs } = storedReplay;
    let verified: VerifiedReplay;
    try {
      verified = await engine.verify({ seed: session.seed, boardKey, frames, inputs, params });
    } catch (error) {
      // 확정 결과가 아니다 — 503 자체는 전역 필터가 error로 남기므로 원인만 warn
      this.logger.warn(`submitScore(): 리플레이 검증 실패(인프라) — ${gameType}\n${toErrorDetail(error)}`);
      throw await this.verifyFailure(error, dto.sessionId, engine.sessionTtlSeconds);
    }

    // 확정 결과 — 여기서 1회 소모. 동시에 같은 세션을 낸 다른 요청이 먼저 소모했으면 409
    if (!(await this.gameSessionService.consumeSession(dto.sessionId))) {
      throw new GameSessionInvalidErrorResponseDto({ details: { reason: 'NOT_FOUND' } });
    }
    if (!verified.ok) {
      this.logger.warn(`submitScore(): 리플레이 재현 실패 — ${gameType} reason=${verified.reason}`);
      throw new GameReplayInvalidErrorResponseDto({ details: { reason: 'REPLAY_REJECTED', engineReason: verified.reason } });
    }

    const crtdAt = new Date();
    try {
      const saved = await this.dataSource.transaction(async (manager: EntityManager) => {
        const score = await manager.save(
          manager.create(GameScore, {
            gameType,
            boardKey,
            score: verified.score,
            playerName: dto.playerName,
            userId,
            durationMs: Math.round(playedMs),
            detail: JSON.stringify(verified.detail),
            ipHash: this.hashIp(ip),
            replayHash,
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
      return { saved, verified, crtdAt };
    } catch (error) {
      // 같은 리플레이를 동시에 낸 다른 세션이 먼저 저장했다 — 확정 결과라 세션은 소모된 채로 둔다
      if (isUniqueViolation(error)) throw new GameReplayDuplicateErrorResponseDto();
      const restored = await this.gameSessionService.restoreSession(dto.sessionId, session, engine.sessionTtlSeconds);
      this.logger.error(`submitScore(): 기록 저장 실패 — 세션 복구=${restored}`, toErrorDetail(error));
      if (!restored) throw error;
      throw verifyBusy('SAVE_FAILED', GAME_VERIFY_RETRY_AFTER_SECONDS);
    }
  }

  /** 검증기 예외 → 응답. 같은 세션이 시간 초과를 반복하면 결정적으로 느린 리플레이로 보고 소모·422(games-polish BD-02) */
  private async verifyFailure(error: unknown, sessionId: string, ttlSeconds: number): Promise<Error> {
    if (error instanceof VerifyTimeoutError) {
      if ((await this.gameSessionService.recordVerifyTimeout(sessionId, ttlSeconds)) >= GAME_VERIFY_TIMEOUT_LIMIT) {
        await this.gameSessionService.consumeSession(sessionId);
        return new GameReplayInvalidErrorResponseDto({ details: { reason: 'VERIFY_TIMEOUT' } });
      }
      return verifyBusy('TIMEOUT', GAME_VERIFY_RETRY_AFTER_SECONDS);
    }
    if (error instanceof VerifyUnavailableError) return verifyBusy('UNAVAILABLE', GAME_VERIFY_UNAVAILABLE_RETRY_AFTER_SECONDS);
    if (error instanceof VerifyQueueFullError) return verifyBusy('QUEUE_FULL', GAME_VERIFY_RETRY_AFTER_SECONDS);
    return verifyBusy('VERIFY_ERROR', GAME_VERIFY_RETRY_AFTER_SECONDS);
  }

  /** 보드·기간별 랭킹 — SCORE DESC, 같은 점수면 먼저 저장된 기록(SCORE_ID 작은 쪽)이 위. 숨김 제외 */
  async getRankings(gameTypeParam: string, query: GetRankingsQueryDto): Promise<RankingListDto> {
    const gameType = this.toGameType(gameTypeParam);
    const engine = this.engines[gameType];
    const boardKey = query.board ?? engine.defaultBoardKey;
    if (!engine.isRankingBoard(boardKey, new Date())) {
      throw new ApiValidationErrorResponseDto('지원하지 않는 랭킹 보드입니다.');
    }
    // 기간 필터를 쓰지 않는 보드(디펜스 주간)는 period를 무시한다
    const periodStart = engine.isPeriodRanking(boardKey) ? rankingPeriodStart(query.period ?? 'all') : null;
    const rows = await this.gameScoreRepository.find({
      select: RANKING_ITEM_SELECT,
      where: { gameType, boardKey, isHidden: 0, ...(periodStart && { crtdAt: MoreThanOrEqual(periodStart) }) },
      // 동점은 SCORE_ID(IDENTITY = 실제 INSERT 순서)로만 가른다 — rankOf와 같은 규칙. CRTD_AT은 앱 시각이라 레플리카·풀 대기에 따라 ID 순서와 어긋날 수 있다
      order: { score: 'DESC', scoreId: 'ASC' },
      take: query.limit ?? GAME_RANKING_DEFAULT_LIMIT,
    });

    return {
      boardKey,
      items: rows.map((row, index) => this.toRankingItem(row, index + 1)),
      periodStart,
    };
  }

  /** 기록 요약 — 누구나 조회, 숨김·없음은 404. 링크 미리보기(OG)용이라 리플레이 입력은 싣지 않는다 (docs/tasks/game-share D-008) */
  async getScore(gameTypeParam: string, scoreId: number): Promise<RankingItemDto> {
    const gameType = this.toGameType(gameTypeParam);
    const score = await this.findVisibleScore(gameType, scoreId);
    return this.toRankingItem(score, await this.rankOf(gameType, score, null));
  }

  /** 리플레이 재생 데이터 — 누구나 조회, 숨김 기록·아직 공개하지 않는 보드(디펜스 진행 중 주간)의 기록은 404 (D-011) */
  async getReplay(gameTypeParam: string, scoreId: number): Promise<GameReplayDetailDto> {
    const gameType = this.toGameType(gameTypeParam);
    const score = await this.findVisibleScore(gameType, scoreId);
    if (!this.engines[gameType].isReplayPublic(score.boardKey, new Date())) {
      throw new GameScoreNotFoundErrorResponseDto();
    }
    const replay = await this.gameReplayRepository.findOneBy({ scoreId, gameType });
    if (!replay) {
      throw new GameScoreNotFoundErrorResponseDto();
    }

    const { frames, inputs, ...stored } = JSON.parse(gunzipSync(replay.replay).toString('utf8')) as StoredReplay;
    const params = stored as Record<string, number>;
    const topLevel = Object.fromEntries(this.engines[gameType].topLevelReplayParams.map((key) => [key, params[key]]));
    return {
      ...this.toRankingItem(score, await this.rankOf(gameType, score, null)),
      engineVersion: replay.engineVersion,
      seed: replay.seed,
      // 게임별 기존 계약 필드(테트리스 das·arr)는 최상위에도 둔다
      ...topLevel,
      params,
      frames,
      inputs,
    };
  }

  /** 숨기지 않은 기록 1건 — 없으면 404. IP_HASH·USER_ID는 조회하지 않는다 */
  private async findVisibleScore(gameType: GameType, scoreId: number): Promise<GameScore> {
    const score = await this.gameScoreRepository.findOne({
      select: RANKING_ITEM_SELECT,
      where: { scoreId, gameType, isHidden: 0 },
    });
    if (!score) {
      throw new GameScoreNotFoundErrorResponseDto();
    }
    return score;
  }

  /**
   * 등록 직후 보드 안 기간별 순위 — 기록이 그 기간에 속하므로 세 기간 모두 순위가 있다.
   * 기간 필터를 쓰지 않는 보드(디펜스 주간)는 getRankings처럼 보드 전체 순위 하나를 세 기간에 같이 싣는다
   */
  private async computeRanks(gameType: GameType, target: RankTarget, crtdAt: Date) {
    const ranks = {} as Record<RankingPeriod, number>;
    if (!this.engines[gameType].isPeriodRanking(target.boardKey)) {
      const rank = await this.rankOf(gameType, target, null);
      for (const period of RANKING_PERIODS) {
        ranks[period] = rank;
      }
      return ranks;
    }
    // 기간별 COUNT는 서로 독립 — 순서대로 기다리지 않는다(games-polish BD-07)
    const counted = await Promise.all(RANKING_PERIODS.map((period) => this.rankOf(gameType, target, rankingPeriodStart(period, crtdAt))));
    RANKING_PERIODS.forEach((period, i) => (ranks[period] = counted[i]));
    return ranks;
  }

  /** 순위 = 같은 보드에서 앞서는 기록 수 + 1. getRankings 정렬과 같은 규칙 — 점수가 높거나, 같은 점수에 SCORE_ID가 작은 기록 */
  private async rankOf(gameType: GameType, { scoreId, score, boardKey }: RankTarget, periodStart: Date | null): Promise<number> {
    const qb = this.gameScoreRepository
      .createQueryBuilder('s')
      .where('s.gameType = :gameType', { gameType })
      .andWhere('s.boardKey = :boardKey', { boardKey })
      .andWhere('s.isHidden = 0')
      .andWhere('(s.score > :score OR (s.score = :score AND s.scoreId < :scoreId))', { score, scoreId });
    if (periodStart) {
      qb.andWhere('s.crtdAt >= :periodStart', { periodStart });
    }
    return (await qb.getCount()) + 1;
  }

  /**
   * 제출 본문의 게임별 설정 → params. 테트리스는 최상위 das·arr(기존 계약)를, 다른 게임은 replay.params를 쓴다.
   * 둘을 섞어 보내거나 값이 정수가 아니거나 저장 본문 예약 키(frames·inputs)를 쓰면 null(422) — 일반 객체라 전역 ValidationPipe가 내부 키·값을 못 막는다
   */
  private toReplayParams(replay: SubmitGameScoreDto['replay']): Record<string, number> | null {
    const { das, arr, params } = replay;
    const topLevel = { ...(das !== undefined && { das }), ...(arr !== undefined && { arr }) };
    if (params && Object.keys(topLevel).length > 0) {
      return null;
    }
    const merged: Record<string, unknown> = params ?? topLevel;
    if (REPLAY_RESERVED_KEYS.some((key) => key in merged)) {
      return null;
    }
    return Object.values(merged).every((value) => Number.isSafeInteger(value)) ? (merged as Record<string, number>) : null;
  }

  private toRankingItem(row: GameScore, rank: number): RankingItemDto {
    return {
      rank,
      scoreId: row.scoreId,
      boardKey: row.boardKey,
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

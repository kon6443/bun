import { createHash, createHmac } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, MoreThanOrEqual, QueryFailedError, Repository } from 'typeorm';
import { GAME_TYPES, GameScore, GameType } from '../../entities/GameScore';
import { GameReplay } from '../../entities/GameReplay';
import { GameReplayViewStat } from '../../entities/GameReplayViewStat';
import {
  GAME_POPULAR_DEFAULT_LIMIT,
  GAME_RANKING_DEFAULT_LIMIT,
  GAME_REPLAY_TIME_TOLERANCE_MS,
  GAME_VERIFY_RETRY_AFTER_SECONDS,
  GAME_VERIFY_TIMEOUT_LIMIT,
  GAME_VERIFY_UNAVAILABLE_RETRY_AFTER_SECONDS,
  GAME_WATCH_DAILY_CAP_MIN_MS,
  GAME_WATCH_DAILY_CAP_MULTIPLIER,
} from '../../common/constants/app.constants';
import { toErrorDetail } from '../../common/utils/error.utils';
import { ApiValidationErrorResponseDto } from '../../common/dto/api-error.dto';
import { GameSession, GameSessionService } from './game-session.service';
import { GameViewService } from './game-view.service';
import { GameHallOfFameService, Trophies, trophiesFromPodiums } from './game-hall-of-fame.service';
import { VerifyQueueFullError, VerifyTimeoutError, VerifyUnavailableError } from './verify-worker-pool';
import { GAME_ENGINE_REGISTRY, GameEngineRegistry, VerifiedReplay } from './game-engine.registry';
import { checkPlayerName } from './player-name-policy';
import { rankingPeriodStart } from './ranking-period';
import { kstDateOf } from './daily-board';
import { challengeBoardKey, challengeRootOf } from './challenge-board';
import {
  GameBoardListDto,
  GameReplayDetailDto,
  GameReplayViewDto,
  GameReplayWatchDto,
  GameScoreSubmittedDto,
  GameSessionDto,
  GetPopularReplaysQueryDto,
  GetRankingsQueryDto,
  HallOfFameDto,
  PopularReplayListDto,
  RANKING_PERIODS,
  RankingItemDto,
  RankingListDto,
  RankingPeriod,
  SubmitGameScoreDto,
} from './games.dto';
import {
  GameChallengeExpiredErrorResponseDto,
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

/** 랭킹 항목을 만드는 데 필요한 기록 컬럼 — RANKING_ITEM_SELECT와 같다 */
type RankingRow = Pick<GameScore, 'scoreId' | 'boardKey' | 'playerName' | 'score' | 'detail' | 'durationMs' | 'crtdAt'>;

/** 조회 집계 누적 값 — 집계 행이 없으면 0 */
type ReplayStats = { viewCount: number; watchMs: number };
const NO_STATS: ReplayStats = { viewCount: 0, watchMs: 0 };

/** 인기 정렬 → 집계 컬럼 */
const POPULAR_SORT_COLUMN = { views: 'v.viewCount', watch: 'v.watchMs' } as const;

/** params가 쓸 수 없는 키 — 저장 본문에서 params와 같은 층에 있다 */
const REPLAY_RESERVED_KEYS = ['frames', 'inputs'] as const;

/** 503 GAME_VERIFY_BUSY — 원인과 다시 낼 때까지 기다릴 시간을 details에 싣는다(컨트롤러가 Retry-After로도 보낸다, games-polish BD-04·BD-14) */
const verifyBusy = (reason: string, retryAfterSeconds: number) =>
  new GameVerifyBusyErrorResponseDto({ details: { reason, retryAfterSeconds } });

/** Oracle 에러 번호 — 메시지가 아니라 드라이버 에러 번호로 판정한다. QueryFailedError가 아니면 undefined */
const oraErrorNum = (error: unknown): number | undefined =>
  error instanceof QueryFailedError ? (error.driverError as { errorNum?: number } | undefined)?.errorNum : undefined;

/** Oracle 유니크 위반(ORA-00001) */
const isUniqueViolation = (error: unknown): boolean => oraErrorNum(error) === 1;

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
    @InjectRepository(GameReplayViewStat)
    private readonly viewStatRepository: Repository<GameReplayViewStat>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(GAME_ENGINE_REGISTRY)
    private readonly engines: GameEngineRegistry,
    private readonly gameSessionService: GameSessionService,
    private readonly gameViewService: GameViewService,
    private readonly hallOfFameService: GameHallOfFameService,
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

  /**
   * 세션 발급 — board(플레이 방식)로 랭킹 보드·seed를 서버가 정한다. 생략하면 게임 기본 보드 (defense DESIGN §B3).
   * challengeScoreId가 있으면 도전장 — 원본 기록의 seed로 `challenge-{원본 ID}` 보드 세션 (games-growth D-005)
   */
  async createSession(gameTypeParam: string, userId: number | null, board?: string, challengeScoreId?: number): Promise<GameSessionDto> {
    const gameType = this.toGameType(gameTypeParam);
    const engine = this.engines[gameType];
    if (challengeScoreId !== undefined && board !== undefined) {
      throw new ApiValidationErrorResponseDto('도전장과 플레이 방식은 함께 보낼 수 없습니다.');
    }
    const resolved =
      challengeScoreId === undefined
        ? { ...engine.resolveSessionBoard(board, new Date()), challengeOf: null }
        : await this.resolveChallengeBoard(gameType, challengeScoreId);
    if (!resolved.boardKey) {
      throw new ApiValidationErrorResponseDto('지원하지 않는 플레이 방식입니다.');
    }
    const { sessionId, session, expiresAt } = await this.gameSessionService.createSession({
      gameType,
      boardKey: resolved.boardKey,
      seed: resolved.seed ?? null,
      engineVersion: engine.engineVersion,
      userId,
      ttlSeconds: engine.sessionTtlSeconds,
      challengeOf: resolved.challengeOf,
    });
    return {
      sessionId,
      seed: session.seed,
      engineVersion: engine.engineVersion,
      expiresAt,
      // 절대 시각(expiresAt)은 기기 시계가 빠르면 짧게 보인다 — 클라이언트가 받은 시각 기준으로 셀 수 있게 길이도 준다(games-polish 프론트 리뷰)
      ttlSeconds: engine.sessionTtlSeconds,
      boardKey: resolved.boardKey,
      mode: resolved.mode ?? null,
    };
  }

  /**
   * 도전장 세션 보드 — 원본은 재생을 공개한 기록이어야 한다(진행 중 데일리·주간은 같은 판 복제가 되므로 404).
   * 도전장 기록으로 도전장을 열면 그 원본으로 묶는다(보드가 갈라지지 않게). 원본 엔진 버전이 다르면 같은 seed로도 다른 판이라 409
   */
  private async resolveChallengeBoard(
    gameType: GameType,
    challengeScoreId: number,
  ): Promise<{ boardKey: string; mode: string; seed: number; challengeOf: number }> {
    const engine = this.engines[gameType];
    if (!engine.supportsChallenge) {
      throw new ApiValidationErrorResponseDto('이 게임은 도전장을 지원하지 않습니다.');
    }
    const { score } = await this.findPublicReplayScore(gameType, challengeScoreId);
    const rootId = challengeRootOf(score.boardKey) ?? score.scoreId;
    if (rootId !== score.scoreId) {
      await this.findPublicReplayScore(gameType, rootId);
    }
    const root = await this.gameReplayRepository.findOne({ select: { seed: true, engineVersion: true }, where: { scoreId: rootId, gameType } });
    if (!root) {
      throw new GameScoreNotFoundErrorResponseDto();
    }
    if (root.engineVersion !== engine.engineVersion) {
      throw new GameChallengeExpiredErrorResponseDto();
    }
    return { boardKey: challengeBoardKey(rootId), mode: 'challenge', seed: root.seed, challengeOf: rootId };
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
    // 도전장: 같은 seed의 공개 리플레이를 그대로 내면 그 점수가 된다 — 원본 보드 기준 해시로 거른다(games-growth D-009·D-013)
    if (session.challengeOf && (await this.isChallengeRootCopy(gameType, session.challengeOf, session.seed, storedReplay))) {
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

    const scoreIds = rows.map((row) => row.scoreId);
    const [stats, trophies] = await Promise.all([this.statTotals(scoreIds), this.trophiesOf(gameType, scoreIds)]);
    return {
      boardKey,
      items: rows.map((row, index) => this.toRankingItem(row, index + 1, stats.get(row.scoreId), trophies.get(row.scoreId))),
      periodStart,
    };
  }

  /** 기록 요약 — 누구나 조회, 숨김·없음은 404. 링크 미리보기(OG)용이라 리플레이 입력은 싣지 않는다 (docs/tasks/game-share D-008) */
  async getScore(gameTypeParam: string, scoreId: number): Promise<RankingItemDto> {
    const gameType = this.toGameType(gameTypeParam);
    const score = await this.findVisibleScore(gameType, scoreId);
    const [rank, stats, trophies] = await Promise.all([
      this.rankOf(gameType, score, null),
      this.statTotals([scoreId]),
      this.trophiesOf(gameType, [scoreId]),
    ]);
    return this.toRankingItem(score, rank, stats.get(scoreId), trophies.get(scoreId));
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
    const [rank, stats, trophies] = await Promise.all([
      this.rankOf(gameType, score, null),
      this.statTotals([scoreId]),
      this.trophiesOf(gameType, [scoreId]),
    ]);

    const { frames, inputs, ...stored } = JSON.parse(gunzipSync(replay.replay).toString('utf8')) as StoredReplay;
    const params = stored as Record<string, number>;
    const topLevel = Object.fromEntries(this.engines[gameType].topLevelReplayParams.map((key) => [key, params[key]]));
    return {
      ...this.toRankingItem(score, rank, stats.get(scoreId), trophies.get(scoreId)),
      engineVersion: replay.engineVersion,
      seed: replay.seed,
      // 게임별 기존 계약 필드(테트리스 das·arr)는 최상위에도 둔다
      ...topLevel,
      params,
      frames,
      inputs,
    };
  }

  /**
   * 리플레이 조회 1회 기록 — 재생 화면 진입 때 프론트가 브라우저당 하루 1회 부른다 (docs/tasks/replay-views D-002·D-003).
   * 같은 IP 해시가 하루 상한을 넘으면 반영하지 않고 현재 값만 돌려준다(counted false)
   */
  async recordView(gameTypeParam: string, scoreId: number, ip: string | undefined): Promise<GameReplayViewDto> {
    const { gameType } = await this.findPublicReplayScore(gameTypeParam, scoreId);
    // IP 해시를 못 만들면(시크릿·IP 없음) 서버 상한 없이 센다 — 프론트의 하루 1회만 남는다
    const viewerKey = this.hashIp(ip);
    const counted = viewerKey === null || (await this.gameViewService.claimView(scoreId, viewerKey));
    if (counted) {
      await this.addTodayStat(scoreId, gameType, 'viewCount', 1);
    }
    const { viewCount } = (await this.statTotals([scoreId])).get(scoreId) ?? NO_STATS;
    return { scoreId, viewCount, counted };
  }

  /**
   * 시청시간 보고 — 재생이 진행된 벽시계 시간의 증분(ms)을 프론트가 주기적으로·이탈 때 보낸다 (D-004).
   * 같은 IP 해시의 하루 누적이 max(리플레이 길이 × 배수, 최소값)를 넘는 부분은 버린다(countedMs)
   */
  async recordWatch(gameTypeParam: string, scoreId: number, watchedMs: number, ip: string | undefined): Promise<GameReplayWatchDto> {
    const { gameType, score } = await this.findPublicReplayScore(gameTypeParam, scoreId);
    const viewerKey = this.hashIp(ip);
    const capMs = Math.max(score.durationMs * GAME_WATCH_DAILY_CAP_MULTIPLIER, GAME_WATCH_DAILY_CAP_MIN_MS);
    const countedMs = viewerKey === null ? watchedMs : await this.gameViewService.claimWatchMs(scoreId, viewerKey, watchedMs, capMs);
    if (countedMs > 0) {
      await this.addTodayStat(scoreId, gameType, 'watchMs', countedMs);
    }
    const { watchMs } = (await this.statTotals([scoreId])).get(scoreId) ?? NO_STATS;
    return { scoreId, watchMs, countedMs };
  }

  /**
   * 기간별 인기 리플레이 — 기간 안 조회수(views) 또는 시청시간(watch) 합이 큰 순, 같으면 먼저 등록된 기록 (D-005).
   * 보드 단위다. 재생을 공개하지 않는 보드(디펜스 진행 중 주간)는 빈 목록 — 여기서 링크를 내주면 재생이 404라서
   */
  async getPopularReplays(gameTypeParam: string, query: GetPopularReplaysQueryDto): Promise<PopularReplayListDto> {
    const gameType = this.toGameType(gameTypeParam);
    const engine = this.engines[gameType];
    const boardKey = query.board ?? engine.defaultBoardKey;
    const period = query.period ?? 'weekly';
    const sort = query.sort ?? 'views';
    const now = new Date();
    if (!engine.isRankingBoard(boardKey, now)) {
      throw new ApiValidationErrorResponseDto('지원하지 않는 랭킹 보드입니다.');
    }
    const periodStart = rankingPeriodStart(period, now);
    if (!engine.isReplayPublic(boardKey, now)) {
      return { boardKey, period, sort, periodStart, items: [] };
    }

    const sortColumn = POPULAR_SORT_COLUMN[sort];
    const qb = this.viewStatRepository
      .createQueryBuilder('v')
      .innerJoin(GameScore, 's', 's.scoreId = v.scoreId AND s.gameType = v.gameType')
      .select('v.scoreId', 'scoreId')
      .addSelect('SUM(v.viewCount)', 'viewCount')
      .addSelect('SUM(v.watchMs)', 'watchMs')
      .where('v.gameType = :gameType', { gameType })
      .andWhere('s.boardKey = :boardKey', { boardKey })
      .andWhere('s.isHidden = 0');
    if (periodStart) {
      qb.andWhere('v.statDate >= :fromDate', { fromDate: kstDateOf(periodStart) });
    }
    const ranked = await qb
      .groupBy('v.scoreId')
      .having(`SUM(${sortColumn}) > 0`)
      .orderBy(`SUM(${sortColumn})`, 'DESC')
      .addOrderBy('v.scoreId', 'ASC')
      .limit(query.limit ?? GAME_POPULAR_DEFAULT_LIMIT)
      .getRawMany<{ scoreId: number | string; viewCount: number | string; watchMs: number | string }>();
    if (ranked.length === 0) {
      return { boardKey, period, sort, periodStart, items: [] };
    }

    const scoreIds = ranked.map((row) => Number(row.scoreId));
    const [rows, totals, trophies] = await Promise.all([
      this.gameScoreRepository.find({ select: RANKING_ITEM_SELECT, where: { scoreId: In(scoreIds), gameType, isHidden: 0 } }),
      this.statTotals(scoreIds),
      this.trophiesOf(gameType, scoreIds),
    ]);
    const rowById = new Map(rows.map((row) => [row.scoreId, row]));
    // 두 조회 사이에 숨겨지거나 지워진 기록은 빼고 순서를 다시 매긴다
    const items = ranked
      .flatMap((stat) => {
        const row = rowById.get(Number(stat.scoreId));
        return row ? [{ row, stat }] : [];
      })
      .map(({ row, stat }, index) => ({
        ...this.toRankingItem(row, index + 1, totals.get(row.scoreId), trophies.get(row.scoreId)),
        periodViewCount: Number(stat.viewCount),
        periodWatchMs: Number(stat.watchMs),
      }));
    return { boardKey, period, sort, periodStart, items };
  }

  /**
   * 제출 리플레이가 원본 보드에 이미 있는 리플레이와 같은지 — 원본 1건만이 아니라 그 보드 전체를 본다.
   * 데일리 보드는 그날 기록이 전부 같은 seed라, 공개된 그날 1위 입력으로 하위 기록의 도전장을 이길 수 있기 때문(D-013).
   * 해시 도입 전 기록은 REPLAY_HASH가 없어 거르지 못한다
   */
  private async isChallengeRootCopy(gameType: GameType, rootId: number, seed: number, storedReplay: StoredReplay): Promise<boolean> {
    const root = await this.gameScoreRepository.findOne({ select: { scoreId: true, boardKey: true }, where: { scoreId: rootId, gameType } });
    return !!root && (await this.gameScoreRepository.exists({ where: { replayHash: hashReplay(gameType, root.boardKey, seed, storedReplay) } }));
  }

  /** 명예의 전당 — 끝난 기간별 1~3위 (games-growth D-007·D-010). 사용자 ID는 배지 계산에만 쓰고 싣지 않는다 */
  async getHallOfFame(gameTypeParam: string): Promise<HallOfFameDto> {
    const gameType = this.toGameType(gameTypeParam);
    const podiums = await this.hallOfFameService.getPodiums(gameType);
    const trophiesByUser = trophiesFromPodiums(podiums);
    const stats = await this.statTotals(podiums.flatMap(({ rows }) => rows.map((row) => row.scoreId)));
    return {
      periods: podiums.map(({ rows, ...period }) => ({
        ...period,
        podium: rows.map((row, index) =>
          this.toRankingItem(row, index + 1, stats.get(row.scoreId), row.userId === null ? undefined : trophiesByUser.get(row.userId)),
        ),
      })),
    };
  }

  /**
   * 기록 ID → 배지. 입상한 로그인 사용자가 없으면 기록 쪽은 조회하지 않는다.
   * 배지는 부가 정보라 계산이 실패해도 목록은 배지 없이 돌려준다
   */
  private async trophiesOf(gameType: GameType, scoreIds: number[]): Promise<Map<number, Trophies>> {
    const result = new Map<number, Trophies>();
    if (scoreIds.length === 0) return result;
    try {
      const trophiesByUser = await this.hallOfFameService.trophiesByUser(gameType);
      if (trophiesByUser.size === 0) return result;
      // 랭킹 항목 조회(RANKING_ITEM_SELECT)는 USER_ID를 읽지 않는다 — 배지 계산용으로만 따로 읽는다
      const owners = await this.gameScoreRepository.find({ select: { scoreId: true, userId: true }, where: { scoreId: In(scoreIds), gameType } });
      for (const { scoreId, userId } of owners) {
        const trophies = userId === null ? undefined : trophiesByUser.get(userId);
        if (trophies) result.set(scoreId, trophies);
      }
    } catch (error) {
      this.logger.warn(`trophiesOf(): 배지 계산 실패 — 배지 없이 응답한다: ${toErrorDetail(error)}`);
    }
    return result;
  }

  /** 재생을 공개하는 기록 1건 — 재생 API(GET .../replay)와 같은 규칙: 숨김·없음·공개 전(디펜스 진행 중 주간) 보드는 404 */
  private async findPublicReplayScore(gameTypeParam: string, scoreId: number): Promise<{ gameType: GameType; score: GameScore }> {
    const gameType = this.toGameType(gameTypeParam);
    const score = await this.findVisibleScore(gameType, scoreId);
    if (!this.engines[gameType].isReplayPublic(score.boardKey, new Date())) {
      throw new GameScoreNotFoundErrorResponseDto();
    }
    return { gameType, score };
  }

  /**
   * 오늘(KST) 집계 행에 더한다 — repository.increment(컬럼 = 컬럼 + n)라 동시 요청도 원자적으로 쌓인다.
   * 오늘 행이 없으면 새로 넣고, 그 사이 다른 요청이 먼저 넣었으면(ORA-00001) 다시 더한다
   */
  private async addTodayStat(scoreId: number, gameType: GameType, column: keyof ReplayStats, amount: number): Promise<void> {
    const statDate = kstDateOf(new Date());
    const { affected } = await this.viewStatRepository.increment({ scoreId, statDate }, column, amount);
    if (affected) return;
    try {
      await this.viewStatRepository.insert({ scoreId, statDate, gameType, ...NO_STATS, [column]: amount });
    } catch (error) {
      // 확인과 저장 사이에 기록이 지워졌다(FK 위반, ORA-02291) — 없는 기록과 같게 404
      if (oraErrorNum(error) === 2291) throw new GameScoreNotFoundErrorResponseDto();
      if (!isUniqueViolation(error)) throw error;
      await this.viewStatRepository.increment({ scoreId, statDate }, column, amount);
    }
  }

  /** 기록별 누적 조회수·시청시간 — 일별 집계의 SUM. 집계가 없는 기록은 Map에 없다(호출부가 0으로 본다) */
  private async statTotals(scoreIds: number[]): Promise<Map<number, ReplayStats>> {
    if (scoreIds.length === 0) {
      return new Map();
    }
    const rows = await this.viewStatRepository
      .createQueryBuilder('v')
      .select('v.scoreId', 'scoreId')
      .addSelect('SUM(v.viewCount)', 'viewCount')
      .addSelect('SUM(v.watchMs)', 'watchMs')
      .where({ scoreId: In(scoreIds) })
      .groupBy('v.scoreId')
      .getRawMany<{ scoreId: number | string; viewCount: number | string; watchMs: number | string }>();
    return new Map(rows.map((row) => [Number(row.scoreId), { viewCount: Number(row.viewCount), watchMs: Number(row.watchMs) }]));
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

  private toRankingItem(row: RankingRow, rank: number, stats: ReplayStats = NO_STATS, trophies?: Trophies): RankingItemDto {
    return {
      rank,
      scoreId: row.scoreId,
      boardKey: row.boardKey,
      playerName: row.playerName,
      score: row.score,
      detail: JSON.parse(row.detail) as Record<string, unknown>,
      durationMs: row.durationMs,
      viewCount: stats.viewCount,
      watchMs: stats.watchMs,
      trophies: trophies ?? null,
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

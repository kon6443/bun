import { createHmac } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, FindOperator } from 'typeorm';
import { GamesService } from './games.service';
import { GameSessionService, GameSession } from './game-session.service';
import { GAME_ENGINE_REGISTRY, GameEngine } from './game-engine.registry';
import { GameScore } from '../../entities/GameScore';
import { GameReplay } from '../../entities/GameReplay';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { SubmitGameScoreDto } from './games.dto';

/**
 * GamesService — 리플레이 검증 후 랭킹 등록 (docs/tasks/games D-003·D-005·D-010·D-011).
 *
 * 핵심:
 *  1. 점수는 클라이언트가 아니라 엔진 재실행 결과만 저장한다.
 *  2. 세션은 1회용이고 게임 종류·엔진 버전이 맞아야 한다. 이름·형식 검사는 세션을 읽기 전에 한다.
 *  3. 게임 시간(최대 배속 기준)이 서버가 잰 경과 시간보다 길면 거부한다.
 *  4. 세션은 검증 결과가 확정된 뒤에만 소모한다 — 검증기 예외는 503 + 세션 유지 (defense DESIGN §B4).
 *  5. 랭킹·리플레이 조회는 숨김 기록을 빼고, IP 해시를 응답에 싣지 않는다.
 */
describe('GamesService', () => {
  let service: GamesService;
  let gameScoreRepository: MockRepository<GameScore>;
  let gameReplayRepository: MockRepository<GameReplay>;
  let manager: { create: jest.Mock; save: jest.Mock };
  let gameSessionService: { createSession: jest.Mock; getSession: jest.Mock; consumeSession: jest.Mock };
  let engine: GameEngine & { verify: jest.Mock; isValidParams: jest.Mock; resolveSessionBoard: jest.Mock; isRankingBoard: jest.Mock; listBoards: jest.Mock };
  let env: Record<string, string | undefined>;

  const NOW = new Date('2026-10-21T05:00:00.000Z').getTime();
  const SESSION_ID = '3f1c2b9e-0a4d-4f7e-9a1b-2c3d4e5f6a7b';
  const session = (overrides: Partial<GameSession> = {}): GameSession => ({
    gameType: 'TETRIS',
    boardKey: 'default',
    seed: 123456789,
    engineVersion: 1,
    startedAt: NOW - 5 * 60 * 1000, // 5분 전 발급
    userId: null,
    ...overrides,
  });
  const dto = (overrides: Partial<SubmitGameScoreDto['replay']> = {}, playerName = '테트리스왕'): SubmitGameScoreDto => ({
    sessionId: SESSION_ID,
    playerName,
    replay: { engineVersion: 1, das: 10, arr: 2, frames: 60 * 60 * 3, inputs: [30, 2, 12, 3, 5, 8], ...overrides },
  });
  const VERIFIED_DETAIL = { lines: 12, level: 2, pieces: 40, tSpins: 1, tetrises: 2, maxCombo: 3, engineVersion: 1, das: 10, arr: 2 };

  beforeEach(async () => {
    jest.useFakeTimers({ now: NOW });
    gameScoreRepository = createMockRepository<GameScore>();
    gameReplayRepository = createMockRepository<GameReplay>();
    manager = {
      create: jest.fn((_entity: unknown, data: unknown) => data),
      save: jest.fn((data: Record<string, unknown>) => Promise.resolve('gameType' in data && 'score' in data ? { ...data, scoreId: 41 } : data)),
    };
    gameSessionService = {
      createSession: jest.fn(),
      getSession: jest.fn().mockResolvedValue(session()),
      consumeSession: jest.fn().mockResolvedValue(session()),
    };
    engine = {
      engineVersion: 1,
      ticksPerSecond: 60,
      maxSpeed: 1,
      maxFrames: 216_000,
      maxInputLength: 120_000,
      sessionTtlSeconds: 7200,
      defaultBoardKey: 'default',
      resolveSessionBoard: jest.fn((board?: string) => (board === undefined ? { boardKey: 'default', mode: null, seed: null } : null)),
      isRankingBoard: jest.fn((boardKey: string) => boardKey === 'default'),
      listBoards: jest.fn(() => [{ boardKey: 'default', mode: null, current: true, startsAt: null, endsAt: null }]),
      isValidParams: jest.fn().mockReturnValue(true),
      verify: jest.fn().mockResolvedValue({ ok: true, score: 12340, detail: VERIFIED_DETAIL }),
    };
    env = { GAME_IP_HASH_SECRET: 'test-secret' };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GamesService,
        { provide: getRepositoryToken(GameScore), useValue: gameScoreRepository },
        { provide: getRepositoryToken(GameReplay), useValue: gameReplayRepository },
        {
          provide: getDataSourceToken(),
          useValue: { transaction: jest.fn((run: (m: typeof manager) => unknown) => run(manager)) } as unknown as DataSource,
        },
        { provide: GAME_ENGINE_REGISTRY, useValue: { TETRIS: engine } },
        { provide: GameSessionService, useValue: gameSessionService },
        { provide: ConfigService, useValue: { get: jest.fn((key: string) => env[key]) } },
      ],
    }).compile();

    service = module.get(GamesService);
    gameScoreRepository.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getCount: 0 }) as never);
  });

  afterEach(() => jest.useRealTimers());

  const savedScore = () => manager.save.mock.calls.map(([data]) => data as Record<string, unknown>).find((d) => 'score' in d)!;
  const savedReplay = () => manager.save.mock.calls.map(([data]) => data as Record<string, unknown>).find((d) => 'replay' in d)!;

  describe('toGameType', () => {
    it('경로 이름(소문자)을 코드값으로 바꿔야 함', () => {
      expect(service.toGameType('tetris')).toBe('TETRIS');
    });

    it('모르는 게임은 404 GAME_NOT_FOUND', () => {
      expect(() => service.toGameType('pacman')).toThrow(expect.objectContaining({ code: 'GAME_NOT_FOUND', status: 404 }));
    });
  });

  describe('createSession', () => {
    it('레지스트리의 엔진 버전·세션 유효 시간으로 세션을 만들고 seed를 돌려줘야 함', async () => {
      const expiresAt = new Date(NOW + 7_200_000);
      gameSessionService.createSession.mockResolvedValue({ sessionId: SESSION_ID, session: session({ userId: 7 }), expiresAt });

      const result = await service.createSession('tetris', 7);

      expect(gameSessionService.createSession).toHaveBeenCalledWith({
        gameType: 'TETRIS',
        boardKey: 'default',
        seed: null,
        engineVersion: 1,
        userId: 7,
        ttlSeconds: 7200,
      });
      expect(result).toEqual({ sessionId: SESSION_ID, seed: 123456789, engineVersion: 1, expiresAt, boardKey: 'default', mode: null });
    });

    it('엔진이 보드가 정한 seed를 주면 그대로 세션에 넘겨야 함', async () => {
      engine.resolveSessionBoard.mockReturnValue({ boardKey: 'weekly-2026-w43', mode: 'weekly', seed: 42 });
      gameSessionService.createSession.mockResolvedValue({ sessionId: SESSION_ID, session: session({ boardKey: 'weekly-2026-w43', seed: 42 }), expiresAt: new Date(NOW) });

      const result = await service.createSession('tetris', null, 'weekly');

      expect(engine.resolveSessionBoard).toHaveBeenCalledWith('weekly', expect.any(Date));
      expect(gameSessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ boardKey: 'weekly-2026-w43', seed: 42 }));
      expect(result).toEqual(expect.objectContaining({ boardKey: 'weekly-2026-w43', mode: 'weekly', seed: 42 }));
    });

    it('엔진이 지원하지 않는 플레이 방식이면 422 VALIDATION_ERROR — 세션을 만들지 않아야 함', async () => {
      await expect(service.createSession('tetris', null, 'weekly')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
      expect(gameSessionService.createSession).not.toHaveBeenCalled();
    });
  });

  describe('listBoards', () => {
    it('엔진의 보드 목록을 그대로 돌려줘야 함', () => {
      expect(service.listBoards('tetris')).toEqual({ items: [{ boardKey: 'default', mode: null, current: true, startsAt: null, endsAt: null }] });
    });
  });

  describe('submitScore', () => {
    const submit = (d = dto(), userId: number | null = null, ip: string | undefined = '203.0.113.7') =>
      service.submitScore({ gameTypeParam: 'tetris', dto: d, userId, ip });

    it('엔진이 계산한 점수·상세 값을 저장하고 클라이언트 값은 쓰지 않아야 함', async () => {
      const result = await submit(dto(), 7);

      expect(engine.verify).toHaveBeenCalledWith({ seed: 123456789, boardKey: 'default', frames: 10800, inputs: [30, 2, 12, 3, 5, 8], params: { das: 10, arr: 2 } });
      expect(engine.isValidParams).toHaveBeenCalledWith({ das: 10, arr: 2 });
      expect(gameSessionService.consumeSession).toHaveBeenCalledWith(SESSION_ID);
      expect(savedScore()).toEqual(
        expect.objectContaining({
          gameType: 'TETRIS',
          boardKey: 'default',
          score: 12340,
          playerName: '테트리스왕',
          userId: 7,
          durationMs: 180000,
          detail: JSON.stringify(VERIFIED_DETAIL),
          isHidden: 0,
        }),
      );
      expect(result).toEqual({ scoreId: 41, score: 12340, detail: VERIFIED_DETAIL, ranks: { daily: 1, weekly: 1, all: 1 } });
    });

    it('리플레이는 세션 seed와 함께 gzip으로 저장해야 함 (같은 트랜잭션) — 테트리스는 이전과 같은 본문 형식', async () => {
      await submit();

      const replay = savedReplay();
      expect(replay).toEqual(expect.objectContaining({ scoreId: 41, gameType: 'TETRIS', engineVersion: 1, seed: 123456789 }));
      expect(JSON.parse(gunzipSync(replay.replay as Buffer).toString('utf8'))).toEqual({ das: 10, arr: 2, frames: 10800, inputs: [30, 2, 12, 3, 5, 8] });
    });

    it('IP는 HMAC으로만 저장하고, 시크릿이 없으면 저장하지 않아야 함', async () => {
      await submit();
      expect(savedScore().ipHash).toBe(createHmac('sha256', 'test-secret').update('203.0.113.7').digest('hex'));

      manager.save.mockClear();
      env.GAME_IP_HASH_SECRET = undefined;
      await submit();
      expect(savedScore().ipHash).toBeNull();
    });

    it('금칙어 이름은 422 GAME_PLAYER_NAME_FORBIDDEN — 세션을 쓰지 않아야 함(이름만 바꿔 재제출)', async () => {
      const error = await submit(dto({}, '시1발')).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'GAME_PLAYER_NAME_FORBIDDEN', status: 422 });
      expect(gameSessionService.getSession).not.toHaveBeenCalled();
      expect(gameSessionService.consumeSession).not.toHaveBeenCalled();
    });

    it.each([
      ['게임별 frames 상한 초과', () => dto({ frames: 216_001 }), () => undefined],
      ['게임별 입력 길이 상한 초과', () => dto(), () => (engine.maxInputLength = 4)],
      ['엔진이 params 형식을 거부', () => dto(), () => engine.isValidParams.mockReturnValue(false)],
      ['최상위 das·arr와 params를 섞어 보냄', () => dto({ params: { das: 10, arr: 2 } }), () => undefined],
      ['params 값이 정수가 아님', () => dto({ das: undefined, arr: undefined, params: { das: 10.5, arr: 2 } }), () => undefined],
      ['params에 저장 본문 예약 키(frames)', () => dto({ das: undefined, arr: undefined, params: { frames: 1 } }), () => undefined],
    ])('%s → 422 VALIDATION_ERROR — 세션을 읽지도 쓰지도 않아야 함', async (_name, makeDto, arrange) => {
      arrange();

      const error = await submit(makeDto()).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
      expect(gameSessionService.getSession).not.toHaveBeenCalled();
      expect(gameSessionService.consumeSession).not.toHaveBeenCalled();
      expect(engine.verify).not.toHaveBeenCalled();
    });

    it('replay.params로 보낸 설정을 엔진에 그대로 넘겨야 함 (테트리스 외 게임 형식)', async () => {
      await submit(dto({ das: undefined, arr: undefined, params: { das: 10, arr: 2 } }));

      expect(engine.verify).toHaveBeenCalledWith(expect.objectContaining({ params: { das: 10, arr: 2 } }));
    });

    it.each([
      ['세션 없음·만료·재사용', null],
      ['다른 게임의 세션', session({ gameType: 'OTHER' as never })],
      ['세션 엔진 버전이 현재와 다름', session({ engineVersion: 0 })],
    ])('%s → 409 GAME_SESSION_INVALID, 검증·소모·저장 없음', async (_name, found) => {
      gameSessionService.getSession.mockResolvedValue(found);

      const error = await submit().catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'GAME_SESSION_INVALID', status: 409 });
      expect(engine.verify).not.toHaveBeenCalled();
      expect(gameSessionService.consumeSession).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('제출한 엔진 버전이 현재와 다르면 409', async () => {
      const error = await submit(dto({ engineVersion: 2 })).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'GAME_SESSION_INVALID', status: 409 });
    });

    it('게임 시간이 서버 경과 시간 + 5초를 넘으면 422 GAME_REPLAY_INVALID — 엔진을 돌리지 않고, 확정 결과라 세션은 소모', async () => {
      // 세션 5분 전 발급, 리플레이는 5분 6초
      const error = await submit(dto({ frames: 60 * 306 })).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'GAME_REPLAY_INVALID', status: 422 });
      expect(engine.verify).not.toHaveBeenCalled();
      expect(gameSessionService.consumeSession).toHaveBeenCalledWith(SESSION_ID);
    });

    it('시간 검사는 엔진의 틱레이트·최대 배속 기준 — 30틱·3배속이면 5분 경과(+5초)에 게임 915초까지 통과 (경계)', async () => {
      engine.ticksPerSecond = 30;
      engine.maxSpeed = 3;

      await submit(dto({ frames: 30 * 915 }));
      expect(engine.verify).toHaveBeenCalled();
      // 플레이 시간은 배속과 무관하게 게임 시간(틱 ÷ 틱레이트)
      expect(savedScore().durationMs).toBe(915_000);

      engine.verify.mockClear();
      const error = await submit(dto({ frames: 30 * 916 })).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'GAME_REPLAY_INVALID', status: 422 });
      expect(engine.verify).not.toHaveBeenCalled();
    });

    it('경과 시간 + 5초 이내면 통과해야 함 (경계)', async () => {
      await submit(dto({ frames: 60 * 305 }));

      expect(engine.verify).toHaveBeenCalled();
    });

    it('엔진이 재현에 실패하면 422 GAME_REPLAY_INVALID — 확정 결과라 세션은 소모, 저장 없음', async () => {
      engine.verify.mockResolvedValue({ ok: false, reason: 'NOT_ENDED' });

      const error = await submit().catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'GAME_REPLAY_INVALID', status: 422 });
      expect(gameSessionService.consumeSession).toHaveBeenCalledWith(SESSION_ID);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('검증기가 예외를 던지면(대기열·타임아웃) 503 GAME_VERIFY_BUSY — 세션을 남겨 재시도할 수 있어야 함', async () => {
      engine.verify.mockRejectedValue(new Error('worker timeout'));

      const error = await submit().catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'GAME_VERIFY_BUSY', status: 503 });
      expect(gameSessionService.consumeSession).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('검증 중 같은 세션의 다른 제출이 먼저 소모했으면 409 — 저장 없음', async () => {
      gameSessionService.consumeSession.mockResolvedValue(null);

      const error = await submit().catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'GAME_SESSION_INVALID', status: 409 });
      expect(engine.verify).toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('기간별 순위는 앞서는 기록 수 + 1 — 일간·주간은 기간 시작 이후만 센다', async () => {
      const qbs = [3, 9, 120].map((count) => createMockQueryBuilder({ getCount: count }));
      qbs.forEach((qb) => gameScoreRepository.createQueryBuilder.mockReturnValueOnce(qb as never));

      const result = await submit();

      expect(result.ranks).toEqual({ daily: 4, weekly: 10, all: 121 });
      expect(qbs[0].andWhere).toHaveBeenCalledWith('s.crtdAt >= :periodStart', { periodStart: new Date('2026-10-20T15:00:00.000Z') });
      expect(qbs[1].andWhere).toHaveBeenCalledWith('s.crtdAt >= :periodStart', { periodStart: new Date('2026-10-18T15:00:00.000Z') });
      expect(qbs[2].andWhere).not.toHaveBeenCalledWith('s.crtdAt >= :periodStart', expect.anything());
      expect(qbs[0].andWhere).toHaveBeenCalledWith('s.isHidden = 0');
      // 같은 보드 안에서만 센다
      expect(qbs[0].andWhere).toHaveBeenCalledWith('s.boardKey = :boardKey', { boardKey: 'default' });
      // 목록 정렬(score DESC, scoreId ASC)과 같은 동점 규칙 — 다르면 응답 순위와 목록 순위가 어긋난다
      expect(qbs[0].andWhere).toHaveBeenCalledWith('(s.score > :score OR (s.score = :score AND s.scoreId < :scoreId))', {
        scoreId: 41,
        score: 12340,
      });
    });

    it('기록의 보드는 세션이 정한 값 — 보드 도입 전 세션(boardKey 없음)은 게임 기본 보드', async () => {
      gameSessionService.getSession.mockResolvedValue(session({ boardKey: 'weekly-2026-w43' }));
      const qb = createMockQueryBuilder({ getCount: 0 });
      gameScoreRepository.createQueryBuilder.mockReturnValue(qb as never);
      await submit();
      expect(savedScore().boardKey).toBe('weekly-2026-w43');
      // 검증기와 등록 직후 순위도 같은 보드 기준
      expect(engine.verify).toHaveBeenCalledWith(expect.objectContaining({ boardKey: 'weekly-2026-w43' }));
      expect(qb.andWhere).toHaveBeenCalledWith('s.boardKey = :boardKey', { boardKey: 'weekly-2026-w43' });

      manager.save.mockClear();
      gameSessionService.getSession.mockResolvedValue(session({ boardKey: undefined }));
      await submit();
      expect(savedScore().boardKey).toBe('default');
    });

    it('순위 계산만 실패하면 ranks: null로 201을 지켜야 함 (기록은 이미 커밋, 세션 소모됨)', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const failing = createMockQueryBuilder({ getCount: 0 });
      failing.getCount.mockRejectedValue(new Error('ORA-03113'));
      gameScoreRepository.createQueryBuilder.mockReturnValue(failing as never);

      const result = await submit();

      expect(result).toEqual({ scoreId: 41, score: 12340, detail: VERIFIED_DETAIL, ranks: null });
      expect(savedScore()).toBeDefined();
    });
  });

  describe('getRankings', () => {
    const row = (overrides: Partial<GameScore>) =>
      ({ scoreId: 1, boardKey: 'default', playerName: 'a', score: 100, detail: '{"lines":1}', durationMs: 1000, crtdAt: new Date(NOW), ...overrides }) as GameScore;

    it('숨김 제외·점수 내림차순·동점은 SCORE_ID 오름차순, 순위는 1부터 — IP 해시·USER_ID는 조회하지 않아야 함', async () => {
      gameScoreRepository.find.mockResolvedValue([row({ scoreId: 5, score: 900 }), row({ scoreId: 2, score: 500 })]);

      const result = await service.getRankings('tetris', {});

      const [options] = gameScoreRepository.find.mock.calls[0] as [Record<string, unknown>];
      expect(options.where).toEqual({ gameType: 'TETRIS', boardKey: 'default', isHidden: 0 });
      expect(options.order).toEqual({ score: 'DESC', scoreId: 'ASC' });
      expect(options.select).not.toHaveProperty('ipHash');
      expect(options.select).not.toHaveProperty('userId');
      expect(result.items.map((i) => [i.rank, i.scoreId])).toEqual([[1, 5], [2, 2]]);
      expect(result.items[0].detail).toEqual({ lines: 1 });
      expect(result.periodStart).toBeNull();
      expect(result.boardKey).toBe('default');
      expect(result.items[0].boardKey).toBe('default');
      // 응답에 보드를 싣기 위해 BOARD_KEY를 조회한다
      expect(options.select).toHaveProperty('boardKey', true);
    });

    it('board 쿼리를 그대로 보드 조건으로 쓰고, 엔진이 모르는 보드는 422 — 조회하지 않아야 함', async () => {
      gameScoreRepository.find.mockResolvedValue([]);
      engine.isRankingBoard.mockImplementation((boardKey: string) => boardKey === 'endless-s1');

      await service.getRankings('tetris', { board: 'endless-s1' });
      const [options] = gameScoreRepository.find.mock.calls[0] as [{ where: Record<string, unknown> }];
      expect(options.where).toEqual(expect.objectContaining({ boardKey: 'endless-s1' }));

      gameScoreRepository.find.mockClear();
      await expect(service.getRankings('tetris', { board: 'weekly-2026-w01' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
      expect(gameScoreRepository.find).not.toHaveBeenCalled();
    });

    it('weekly면 KST 이번 주 월요일 00:00 이후만', async () => {
      gameScoreRepository.find.mockResolvedValue([]);

      const result = await service.getRankings('tetris', { period: 'weekly', limit: 10 });

      const [options] = gameScoreRepository.find.mock.calls[0] as [{ where: { crtdAt: FindOperator<Date> }; take: number }];
      expect(options.where.crtdAt.type).toBe('moreThanOrEqual');
      expect(options.where.crtdAt.value).toEqual(new Date('2026-10-18T15:00:00.000Z'));
      expect(options.take).toBe(10);
      expect(result.periodStart).toEqual(new Date('2026-10-18T15:00:00.000Z'));
    });
  });

  describe('getScore (기록 요약 — 공유 미리보기용)', () => {
    it('숨기지 않은 기록을 전체 순위와 함께 돌려주고, 민감 필드·리플레이는 조회하지 않아야 함', async () => {
      gameScoreRepository.findOne.mockResolvedValue({ scoreId: 41, boardKey: 'default', playerName: 'a', score: 900, detail: '{"lines":3}', durationMs: 1000, crtdAt: new Date(NOW) } as GameScore);
      const qb = createMockQueryBuilder({ getCount: 4 });
      gameScoreRepository.createQueryBuilder.mockReturnValue(qb as never);

      const result = await service.getScore('tetris', 41);

      const [options] = gameScoreRepository.findOne.mock.calls[0] as [{ where: unknown; select: Record<string, boolean> }];
      expect(options.where).toEqual({ scoreId: 41, gameType: 'TETRIS', isHidden: 0 });
      expect(options.select).not.toHaveProperty('ipHash');
      expect(options.select).not.toHaveProperty('userId');
      expect(gameReplayRepository.findOneBy).not.toHaveBeenCalled();
      expect(qb.andWhere).not.toHaveBeenCalledWith('s.crtdAt >= :periodStart', expect.anything());
      expect(qb.andWhere).toHaveBeenCalledWith('s.boardKey = :boardKey', { boardKey: 'default' });
      expect(result).toEqual({ rank: 5, scoreId: 41, boardKey: 'default', playerName: 'a', score: 900, detail: { lines: 3 }, durationMs: 1000, createdAt: new Date(NOW) });
    });

    it('없거나 숨긴 기록은 404 GAME_SCORE_NOT_FOUND', async () => {
      gameScoreRepository.findOne.mockResolvedValue(null);

      await expect(service.getScore('tetris', 41)).rejects.toMatchObject({ code: 'GAME_SCORE_NOT_FOUND', status: 404 });
    });

    it('모르는 게임은 404 GAME_NOT_FOUND', async () => {
      await expect(service.getScore('pacman', 41)).rejects.toMatchObject({ code: 'GAME_NOT_FOUND', status: 404 });
    });
  });

  describe('getReplay', () => {
    it('숨김이 아닌 기록이면 gzip을 풀어 재생 데이터를 돌려줘야 함', async () => {
      gameScoreRepository.findOne.mockResolvedValue({ scoreId: 41, playerName: 'a', score: 900, detail: '{}', durationMs: 1, crtdAt: new Date(NOW) } as GameScore);
      gameReplayRepository.findOneBy.mockResolvedValue({
        scoreId: 41,
        gameType: 'TETRIS',
        engineVersion: 1,
        seed: 99,
        replay: gzipSync(JSON.stringify({ das: 8, arr: 1, frames: 600, inputs: [1, 6] })),
        crtdAt: new Date(NOW),
      });

      const result = await service.getReplay('tetris', 41);

      expect(gameScoreRepository.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { scoreId: 41, gameType: 'TETRIS', isHidden: 0 } }));
      expect(result).toEqual(
        expect.objectContaining({ scoreId: 41, rank: 1, engineVersion: 1, seed: 99, das: 8, arr: 1, params: { das: 8, arr: 1 }, frames: 600, inputs: [1, 6] }),
      );
      expect(result).not.toHaveProperty('ipHash');
    });

    it.each([
      ['기록 없음·숨김', null, null],
      ['리플레이 없음', { scoreId: 41 } as GameScore, null],
    ])('%s → 404 GAME_SCORE_NOT_FOUND', async (_name, score, replay) => {
      gameScoreRepository.findOne.mockResolvedValue(score);
      gameReplayRepository.findOneBy.mockResolvedValue(replay);

      await expect(service.getReplay('tetris', 41)).rejects.toMatchObject({ code: 'GAME_SCORE_NOT_FOUND', status: 404 });
    });
  });
});

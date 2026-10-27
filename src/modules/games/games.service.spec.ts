import { createHash, createHmac } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, FindOperator, QueryFailedError } from 'typeorm';
import { GamesService } from './games.service';
import { GameSessionService, GameSession } from './game-session.service';
import { GameViewService } from './game-view.service';
import { GameHallOfFameService } from './game-hall-of-fame.service';
import { GAME_ENGINE_REGISTRY, GameEngine } from './game-engine.registry';
import { VerifyQueueFullError, VerifyTimeoutError, VerifyUnavailableError } from './verify-worker-pool';
import { GameScore } from '../../entities/GameScore';
import { GameReplay } from '../../entities/GameReplay';
import { GameReplayViewStat } from '../../entities/GameReplayViewStat';
import { User } from '../../entities/User';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { SubmitGameScoreDto } from './games.dto';
import { UserSkinService } from '../users/user-skin.service';
import { UserPointService } from '../users/user-point.service';
import { SKIN_LEVEL_COSTS } from '../users/skin-catalog';

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
  let viewStatRepository: MockRepository<GameReplayViewStat>;
  let userRepository: MockRepository<User>;
  let gameViewService: { claimView: jest.Mock; claimWatchMs: jest.Mock };
  let hallOfFameService: { getPodiums: jest.Mock; trophiesByUser: jest.Mock };
  let userSkinService: { boardSkinsOf: jest.Mock; collection: jest.Mock };
  let userPointService: { pointsOf: jest.Mock; record: jest.Mock };
  /** 엔진 레지스트리 — 다른 게임 경로가 필요한 테스트만 항목을 더한다 */
  let engines: Record<string, unknown>;
  let manager: { create: jest.Mock; save: jest.Mock };
  let gameSessionService: {
    createSession: jest.Mock;
    getSession: jest.Mock;
    consumeSession: jest.Mock;
    claimVerification: jest.Mock;
    releaseVerification: jest.Mock;
    recordVerifyTimeout: jest.Mock;
    restoreSession: jest.Mock;
  };
  let engine: GameEngine & {
    verify: jest.Mock;
    isValidParams: jest.Mock;
    resolveSessionBoard: jest.Mock;
    isRankingBoard: jest.Mock;
    isPeriodRanking: jest.Mock;
    isReplayPublic: jest.Mock;
    listBoards: jest.Mock;
  };
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
    viewStatRepository = createMockRepository<GameReplayViewStat>();
    userRepository = createMockRepository<User>();
    userRepository.find.mockResolvedValue([]);
    // 집계 없음 — 누적 조회수·시청시간 0
    viewStatRepository.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getRawMany: [] }) as never);
    // 입상자 없음 — 배지 null
    hallOfFameService = { getPodiums: jest.fn().mockResolvedValue([]), trophiesByUser: jest.fn().mockResolvedValue(new Map()) };
    userSkinService = {
      boardSkinsOf: jest.fn().mockResolvedValue({ block: 'default', effect: 'default', board: 'default', levels: { block: 1, effect: 1, board: 1 } }),
      collection: jest.fn().mockResolvedValue({ signedIn: true, slots: [{ slot: 'block', items: [] }] }),
    };
    userPointService = { pointsOf: jest.fn().mockResolvedValue({ earned: 112_340, spent: 0, balance: 112_340 }), record: jest.fn().mockResolvedValue(undefined) };
    gameViewService = { claimView: jest.fn().mockResolvedValue(true), claimWatchMs: jest.fn((_id, _key, ms: number) => Promise.resolve(ms)) };
    manager = {
      create: jest.fn((_entity: unknown, data: unknown) => data),
      save: jest.fn((data: Record<string, unknown>) => Promise.resolve('gameType' in data && 'score' in data ? { ...data, scoreId: 41 } : data)),
    };
    gameSessionService = {
      createSession: jest.fn(),
      getSession: jest.fn().mockResolvedValue(session()),
      consumeSession: jest.fn().mockResolvedValue(session()),
      claimVerification: jest.fn().mockResolvedValue('guard-token'),
      releaseVerification: jest.fn().mockResolvedValue(undefined),
      recordVerifyTimeout: jest.fn().mockResolvedValue(1),
      restoreSession: jest.fn().mockResolvedValue(true),
    };
    engine = {
      engineVersion: 1,
      ticksPerSecond: 60,
      maxSpeed: 1,
      maxFrames: 216_000,
      maxInputLength: 120_000,
      sessionTtlSeconds: 7200,
      defaultBoardKey: 'default',
      supportsChallenge: true,
      hallOfFamePeriods: jest.fn().mockReturnValue([]),
      resolveSessionBoard: jest.fn((board?: string) => (board === undefined ? { boardKey: 'default', mode: null, seed: null } : null)),
      isRankingBoard: jest.fn((boardKey: string) => boardKey === 'default'),
      isPeriodRanking: jest.fn().mockReturnValue(true),
      isReplayPublic: jest.fn().mockReturnValue(true),
      topLevelReplayParams: ['arr', 'das'],
      listBoards: jest.fn(() => [{ boardKey: 'default', mode: null, current: true, startsAt: null, endsAt: null }]),
      isValidParams: jest.fn().mockReturnValue(true),
      verify: jest.fn().mockResolvedValue({ ok: true, score: 12340, detail: VERIFIED_DETAIL }),
    };
    env = { GAME_IP_HASH_SECRET: 'test-secret' };
    engines = { TETRIS: engine };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GamesService,
        { provide: getRepositoryToken(GameScore), useValue: gameScoreRepository },
        { provide: getRepositoryToken(GameReplay), useValue: gameReplayRepository },
        { provide: getRepositoryToken(GameReplayViewStat), useValue: viewStatRepository },
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: GameViewService, useValue: gameViewService },
        { provide: GameHallOfFameService, useValue: hallOfFameService },
        { provide: UserSkinService, useValue: userSkinService },
        { provide: UserPointService, useValue: userPointService },
        {
          provide: getDataSourceToken(),
          useValue: { transaction: jest.fn((run: (m: typeof manager) => unknown) => run(manager)) } as unknown as DataSource,
        },
        { provide: GAME_ENGINE_REGISTRY, useValue: engines },
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
        challengeOf: null,
        // 판 시작 때의 보드 스킨(tetris-skins D-007)
        skins: { block: 'default', effect: 'default', board: 'default', levels: { block: 1, effect: 1, board: 1 } },
      });
      expect(userSkinService.boardSkinsOf).toHaveBeenCalledWith(7);
      expect(result).toEqual({ sessionId: SESSION_ID, seed: 123456789, engineVersion: 1, expiresAt, ttlSeconds: 7200, boardKey: 'default', mode: null });
    });

    it('게스트 세션에는 스킨을 싣지 않는다 — 조회하지 않는다 (D-007)', async () => {
      gameSessionService.createSession.mockResolvedValue({ sessionId: SESSION_ID, session: session(), expiresAt: new Date(NOW) });
      await service.createSession('tetris', null);
      expect(gameSessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ skins: null }));
      expect(userSkinService.boardSkinsOf).not.toHaveBeenCalled();
    });

    it('스킨 조회가 실패해도 세션은 발급한다 — 그 판은 default로 남는다 (D-007)', async () => {
      userSkinService.boardSkinsOf.mockRejectedValueOnce(new Error('ORA-03113'));
      gameSessionService.createSession.mockResolvedValue({ sessionId: SESSION_ID, session: session({ userId: 7 }), expiresAt: new Date(NOW) });
      await expect(service.createSession('tetris', 7)).resolves.toMatchObject({ sessionId: SESSION_ID });
      expect(gameSessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ skins: null }));
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

  /**
   * 도전장 (docs/tasks/games-growth D-005·D-009) — 원본 기록의 seed로 `challenge-{원본 ID}` 보드 세션.
   * 원본은 재생 공개 기록이어야 하고, 엔진 버전이 같아야 하며, 원본 리플레이를 그대로 낸 제출은 거른다.
   */
  describe('도전장', () => {
    const root = (overrides: Partial<GameScore> = {}) =>
      ({ scoreId: 41, boardKey: 'default', playerName: 'a', score: 900, detail: '{}', durationMs: 1000, crtdAt: new Date(NOW), ...overrides }) as GameScore;

    beforeEach(() => {
      gameScoreRepository.findOne.mockResolvedValue(root());
      gameReplayRepository.findOne = jest.fn().mockResolvedValue({ seed: 777, engineVersion: 1 });
      gameSessionService.createSession.mockResolvedValue({
        sessionId: SESSION_ID,
        session: session({ boardKey: 'challenge-41', seed: 777, challengeOf: 41 }),
        expiresAt: new Date(NOW),
      });
    });

    it('원본의 seed로 challenge-{원본 ID} 보드 세션을 연다', async () => {
      const result = await service.createSession('tetris', null, undefined, 41);

      expect(gameSessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ boardKey: 'challenge-41', seed: 777, challengeOf: 41 }),
      );
      expect(engine.resolveSessionBoard).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ boardKey: 'challenge-41', mode: 'challenge', seed: 777 }));
    });

    it('도전장 기록으로 열면 그 원본으로 묶는다 — 보드가 갈라지지 않게', async () => {
      gameScoreRepository.findOne
        .mockResolvedValueOnce(root({ scoreId: 50, boardKey: 'challenge-41' }))
        .mockResolvedValueOnce(root());

      await service.createSession('tetris', null, undefined, 50);

      expect(gameReplayRepository.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { scoreId: 41, gameType: 'TETRIS' } }));
      expect(gameSessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ boardKey: 'challenge-41', challengeOf: 41 }));
    });

    it('원본 엔진 버전이 다르면 409 GAME_CHALLENGE_EXPIRED', async () => {
      gameReplayRepository.findOne = jest.fn().mockResolvedValue({ seed: 777, engineVersion: 0 });

      await expect(service.createSession('tetris', null, undefined, 41)).rejects.toMatchObject({ code: 'GAME_CHALLENGE_EXPIRED', status: 409 });
      expect(gameSessionService.createSession).not.toHaveBeenCalled();
    });

    it.each([
      ['없거나 숨긴 원본', () => gameScoreRepository.findOne.mockResolvedValue(null)],
      ['재생 공개 전 원본(진행 중 데일리·주간)', () => engine.isReplayPublic.mockReturnValue(false)],
      ['리플레이 없는 원본', () => (gameReplayRepository.findOne = jest.fn().mockResolvedValue(null))],
    ])('%s → 404 GAME_SCORE_NOT_FOUND', async (_name, arrange) => {
      arrange();

      await expect(service.createSession('tetris', null, undefined, 41)).rejects.toMatchObject({ code: 'GAME_SCORE_NOT_FOUND', status: 404 });
      expect(gameSessionService.createSession).not.toHaveBeenCalled();
    });

    it('board와 함께 보내면 422', async () => {
      await expect(service.createSession('tetris', null, 'daily', 41)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
    });

    it('도전장을 지원하지 않는 게임이면 422', async () => {
      engine.supportsChallenge = false;

      await expect(service.createSession('tetris', null, undefined, 41)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
    });

    describe('제출 — 원본 리플레이 복제 차단', () => {
      // 서비스 hashReplay와 같은 규칙(게임·원본 보드·seed·정렬한 params·frames·inputs) — 원본은 같은 seed라 같은 입력이면 같은 해시
      const rootHash = (replay: SubmitGameScoreDto['replay']) =>
        createHash('sha256')
          .update(
            JSON.stringify({
              gameType: 'TETRIS',
              boardKey: 'default',
              seed: 777,
              params: [['arr', replay.arr], ['das', replay.das]],
              frames: replay.frames,
              inputs: replay.inputs,
            }),
          )
          .digest('hex');

      beforeEach(() => {
        gameSessionService.getSession.mockResolvedValue(session({ boardKey: 'challenge-41', seed: 777, challengeOf: 41 }));
      });

      // 원본 보드에 같은 해시가 있는지는 exists로 본다 — 원본 1건이 아니라 보드 전체(데일리면 그날 전체, D-013)
      const existsOnRootBoard = (hash: string) =>
        gameScoreRepository.exists.mockImplementation((options) => Promise.resolve((options?.where as { replayHash?: string } | undefined)?.replayHash === hash));

      it('원본 보드에 같은 리플레이가 있으면(원본·같은 날 다른 기록) 검증 전에 409 GAME_REPLAY_DUPLICATE + 세션 소모', async () => {
        const body = dto();
        gameScoreRepository.findOne.mockResolvedValue({ scoreId: 41, boardKey: 'default' } as GameScore);
        existsOnRootBoard(rootHash(body.replay));

        await expect(service.submitScore({ gameTypeParam: 'tetris', dto: body, userId: null, ip: undefined })).rejects.toMatchObject({
          code: 'GAME_REPLAY_DUPLICATE',
          status: 409,
        });
        expect(engine.verify).not.toHaveBeenCalled();
        expect(gameSessionService.consumeSession).toHaveBeenCalledWith(SESSION_ID);
      });

      it('다른 리플레이면 도전장 보드로 검증·저장한다', async () => {
        gameScoreRepository.findOne.mockResolvedValue({ scoreId: 41, boardKey: 'default' } as GameScore);
        existsOnRootBoard('other');

        await service.submitScore({ gameTypeParam: 'tetris', dto: dto(), userId: null, ip: undefined });

        expect(engine.verify).toHaveBeenCalledWith(expect.objectContaining({ seed: 777, boardKey: 'challenge-41' }));
        expect(savedScore()).toEqual(expect.objectContaining({ boardKey: 'challenge-41' }));
      });
    });
  });

  describe('listSkins (tetris-skins D-005)', () => {
    it('TETRIS는 도감을 요청 사용자 기준으로', async () => {
      await expect(service.listSkins('tetris', 7)).resolves.toEqual({ signedIn: true, slots: [{ slot: 'block', items: [] }] });
      expect(userSkinService.collection).toHaveBeenCalledWith(7);
    });

    it('스킨이 없는 게임은 빈 목록 — 스킨 조회를 하지 않는다', async () => {
      await expect(service.listSkins('defense', null)).resolves.toEqual({ signedIn: false, maxLevel: 5, levelCosts: SKIN_LEVEL_COSTS, points: null, slots: [] });
      expect(userSkinService.collection).not.toHaveBeenCalled();
    });

    it('모르는 게임은 404 GAME_NOT_FOUND', async () => {
      await expect(service.listSkins('pacman', null)).rejects.toMatchObject({ status: 404, code: 'GAME_NOT_FOUND' });
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
      expect(result).toEqual({ scoreId: 41, score: 12340, playerName: '테트리스왕', detail: VERIFIED_DETAIL, ranks: { daily: 1, weekly: 1, all: 1 }, points: { earned: 12340, balance: 112_340 } });
    });

    describe('포인트 (skin-levels D-002)', () => {
      it('기록 주인이 있으면 이번 판 점수 = 적립, 적립 뒤 잔액을 돌려준다 — 세션 주인 폴백 포함', async () => {
        gameSessionService.getSession.mockResolvedValue(session({ userId: 7 }));
        const result = await submit(dto(), null);
        expect(result.points).toEqual({ earned: 12340, balance: 112_340 });
        expect(userPointService.pointsOf).toHaveBeenCalledWith(7);
        // 적립 줄도 세션 주인에게
        expect(userPointService.record).toHaveBeenCalledWith(manager, expect.objectContaining({ userId: 7, refKey: '41' }));
      });

      it('적립 줄은 기록 저장과 같은 트랜잭션에서 — 기록 번호·보드·점수로 (D-004)', async () => {
        await submit(dto(), 7);
        expect(userPointService.record).toHaveBeenCalledWith(manager, {
          userId: 7,
          amount: 12340,
          reason: 'TETRIS_SCORE',
          refKey: '41',
          memo: '테트리스 기록 #41 · default 보드 · 12,340점',
          crtdAt: new Date(NOW),
        });
        // 기록·리플레이를 저장한 뒤
        expect(Math.max(...manager.save.mock.invocationCallOrder)).toBeLessThan(userPointService.record.mock.invocationCallOrder[0]);
      });

      it('적립 줄 저장이 실패하면 기록도 저장되지 않는다 — 같은 트랜잭션이라 503 + 세션 복구', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        userPointService.record.mockRejectedValue(new Error('ORA-03113'));
        await expect(submit(dto(), 7)).rejects.toMatchObject({ status: 503 });
        expect(gameSessionService.restoreSession).toHaveBeenCalled();
      });

      it('0점 판·비로그인 기록은 적립 줄이 없다', async () => {
        engine.verify.mockResolvedValue({ ok: true, score: 0, detail: VERIFIED_DETAIL });
        await submit(dto(), 7);
        await submit(dto(), null);
        expect(userPointService.record).not.toHaveBeenCalled();
      });

      it('비로그인 기록은 null — 포인트를 읽지 않는다', async () => {
        expect((await submit()).points).toBeNull();
        expect(userPointService.pointsOf).not.toHaveBeenCalled();
      });

      it('테트리스가 아니면 null', async () => {
        engines.DEFENSE = engine;
        gameSessionService.getSession.mockResolvedValue(session({ gameType: 'DEFENSE', userId: 7 }));
        const result = await service.submitScore({ gameTypeParam: 'defense', dto: dto(), userId: 7, ip: undefined });
        expect(result.points).toBeNull();
        expect(userPointService.pointsOf).not.toHaveBeenCalled();
        expect(userPointService.record).not.toHaveBeenCalled();
      });

      it('잔액 조회가 실패해도 등록 성공은 지킨다 — points null', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        userPointService.pointsOf.mockRejectedValue(new Error('ORA-03113'));
        const result = await submit(dto(), 7);
        expect(result).toEqual(expect.objectContaining({ scoreId: 41, points: null }));
      });
    });

    it.each([
      ['제출이 익명이면 세션을 받은 로그인 사용자로 저장한다(만료 토큰 거절 뒤 토큰 없이 재시도 — tetris-skins D-002)', null, 7, 7],
      ['제출 토큰 사용자가 있으면 그 사용자가 우선', 9, 7, 9],
      ['세션도 익명이면 익명', null, null, null],
    ])('%s', async (_name, submitUserId, sessionUserId, savedUserId) => {
      gameSessionService.getSession.mockResolvedValue(session({ userId: sessionUserId }));
      await submit(dto(), submitUserId);
      expect(savedScore()).toEqual(expect.objectContaining({ userId: savedUserId }));
    });

    it('세션에 보관한 판 시작 때의 보드 스킨을 리플레이에 남긴다 (D-007)', async () => {
      gameSessionService.getSession.mockResolvedValue(session({ userId: 7, skins: { block: 'neon', effect: 'neon', board: 'gameboy', levels: { block: 3, effect: 1, board: 1 } } }));
      await submit(dto(), 7);
      expect(savedReplay().boardSkins).toBe(JSON.stringify({ block: 'neon', effect: 'neon', board: 'gameboy', levels: { block: 3, effect: 1, board: 1 } }));
    });

    it('리플레이는 세션 seed와 함께 gzip으로 저장해야 함 (같은 트랜잭션) — 테트리스는 이전과 같은 본문 형식', async () => {
      await submit();

      const replay = savedReplay();
      expect(replay).toEqual(expect.objectContaining({ scoreId: 41, gameType: 'TETRIS', engineVersion: 1, seed: 123456789, boardSkins: null }));
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

    describe('사유·중복·검증 가드·저장 실패 (games-polish P2)', () => {
      const failWith = async (d = dto()) => (await submit(d).catch((e: unknown) => e)) as { code: string; status: number; details?: unknown };
      const saveFails = (error: unknown) => {
        const dataSource = (service as unknown as { dataSource: { transaction: jest.Mock } }).dataSource;
        dataSource.transaction.mockRejectedValueOnce(error);
      };
      const oraError = (errorNum: number) => new QueryFailedError('INSERT', [], Object.assign(new Error(`ORA-${errorNum}`), { errorNum }));

      it('리플레이 엔진 버전이 다르면 세션을 읽기 전에 409 reason ENGINE_VERSION — 새로고침 안내용 (BD-04)', async () => {
        const error = await failWith(dto({ engineVersion: 2 }));
        expect(error).toMatchObject({ code: 'GAME_SESSION_INVALID', status: 409, details: { reason: 'ENGINE_VERSION' } });
        expect(gameSessionService.getSession).not.toHaveBeenCalled();
      });

      it.each([
        ['세션 없음', null, 'NOT_FOUND'],
        ['다른 게임 세션', session({ gameType: 'DEFENSE' }), 'GAME_MISMATCH'],
        ['세션 엔진 버전이 다름', session({ engineVersion: 0 }), 'ENGINE_VERSION'],
      ])('%s → 409 reason %s (BD-04)', async (_label, found, reason) => {
        gameSessionService.getSession.mockResolvedValue(found);
        await expect(failWith()).resolves.toMatchObject({ code: 'GAME_SESSION_INVALID', status: 409, details: { reason } });
      });

      it('422는 사유를 싣는다 — 경과 시간 초과 ELAPSED_TIME, 재현 실패 REPLAY_REJECTED + 엔진 사유 (BD-04)', async () => {
        await expect(failWith(dto({ frames: 60 * 60 * 60 }))).resolves.toMatchObject({ status: 422, details: { reason: 'ELAPSED_TIME' } });

        engine.verify.mockResolvedValue({ ok: false, reason: 'NOT_STARTED' });
        await expect(failWith()).resolves.toMatchObject({
          code: 'GAME_REPLAY_INVALID',
          status: 422,
          details: { reason: 'REPLAY_REJECTED', engineReason: 'NOT_STARTED' },
        });
      });

      it('리플레이 해시를 저장한다 — 게임·보드·seed·본문이 같으면 같은 해시 (D-003)', async () => {
        await submit();
        await submit();
        const hashes = manager.create.mock.calls.filter(([entity]) => entity === GameScore).map(([, row]) => (row as { replayHash: string }).replayHash);
        expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
        expect(hashes[1]).toBe(hashes[0]);

        // params 키 순서만 바꿔도 같은 리플레이다
        await submit({ ...dto(), replay: { ...dto().replay, das: undefined, arr: undefined, params: { arr: 2, das: 10 } } } as never);
        const reordered = manager.create.mock.calls.filter(([entity]) => entity === GameScore).map(([, row]) => (row as { replayHash: string }).replayHash)[2];
        expect(reordered).toBe(hashes[0]);

        gameSessionService.getSession.mockResolvedValue(session({ seed: 1 }));
        await submit();
        const other = manager.create.mock.calls.filter(([entity]) => entity === GameScore).map(([, row]) => (row as { replayHash: string }).replayHash)[3];
        expect(other).not.toBe(hashes[0]);
      });

      it('같은 리플레이가 이미 있으면 검증 없이 409 GAME_REPLAY_DUPLICATE, 세션 소모 (D-003)', async () => {
        gameScoreRepository.exists.mockResolvedValue(true);
        await expect(failWith()).resolves.toMatchObject({ code: 'GAME_REPLAY_DUPLICATE', status: 409 });
        expect(engine.verify).not.toHaveBeenCalled();
        expect(gameSessionService.consumeSession).toHaveBeenCalledWith(SESSION_ID);
      });

      it('동시 제출로 저장 때 유니크 위반(ORA-00001)이면 409 GAME_REPLAY_DUPLICATE, 세션을 되돌리지 않는다 (D-003)', async () => {
        saveFails(oraError(1));
        await expect(failWith()).resolves.toMatchObject({ code: 'GAME_REPLAY_DUPLICATE', status: 409 });
        expect(gameSessionService.restoreSession).not.toHaveBeenCalled();
      });

      it('같은 세션이 검증 중이면 검증하지 않고 503 reason IN_PROGRESS — 남의 가드는 풀지 않는다 (BD-01)', async () => {
        gameSessionService.claimVerification.mockResolvedValue(null);
        await expect(failWith()).resolves.toMatchObject({ code: 'GAME_VERIFY_BUSY', status: 503, details: { reason: 'IN_PROGRESS' } });
        expect(engine.verify).not.toHaveBeenCalled();
        expect(gameSessionService.releaseVerification).not.toHaveBeenCalled();
      });

      it('검증 가드는 성공·실패 모두 끝나면 푼다 (BD-01)', async () => {
        await submit();
        engine.verify.mockResolvedValue({ ok: false, reason: 'NOT_ENDED' });
        await failWith();
        expect(gameSessionService.releaseVerification).toHaveBeenCalledTimes(2);
        expect(gameSessionService.releaseVerification).toHaveBeenCalledWith(SESSION_ID, 'guard-token');
      });

      it('검증 시간 초과는 첫 번째는 503 TIMEOUT(세션 유지), 같은 세션 2번째는 422 VERIFY_TIMEOUT(세션 소모) (BD-02)', async () => {
        engine.verify.mockRejectedValue(new VerifyTimeoutError(5000));

        await expect(failWith()).resolves.toMatchObject({ code: 'GAME_VERIFY_BUSY', details: { reason: 'TIMEOUT', retryAfterSeconds: 2 } });
        expect(gameSessionService.consumeSession).not.toHaveBeenCalled();

        gameSessionService.recordVerifyTimeout.mockResolvedValue(2);
        await expect(failWith()).resolves.toMatchObject({ code: 'GAME_REPLAY_INVALID', status: 422, details: { reason: 'VERIFY_TIMEOUT' } });
        expect(gameSessionService.recordVerifyTimeout).toHaveBeenLastCalledWith(SESSION_ID, 7200);
        expect(gameSessionService.consumeSession).toHaveBeenCalledWith(SESSION_ID);
      });

      it.each([
        ['워커 꺼짐', new VerifyUnavailableError('x'), 'UNAVAILABLE', 30],
        ['대기열 가득', new VerifyQueueFullError(), 'QUEUE_FULL', 2],
      ])('%s → 503 reason %s, retryAfterSeconds %i (BD-14)', async (_label, thrown, reason, retryAfterSeconds) => {
        engine.verify.mockRejectedValue(thrown);
        await expect(failWith()).resolves.toMatchObject({ code: 'GAME_VERIFY_BUSY', details: { reason, retryAfterSeconds } });
      });

      it('저장이 실패하면 세션을 되돌리고 503 SAVE_FAILED — 같은 세션으로 다시 낼 수 있다 (BD-03)', async () => {
        saveFails(oraError(12516));
        await expect(failWith()).resolves.toMatchObject({ code: 'GAME_VERIFY_BUSY', status: 503, details: { reason: 'SAVE_FAILED' } });
        expect(gameSessionService.restoreSession).toHaveBeenCalledWith(SESSION_ID, session(), 7200);
      });

      it('세션을 되돌리지 못하면(만료 등) 원래 오류를 그대로 던진다 — 재시도해도 409라 503을 주지 않는다 (BD-03)', async () => {
        const original = oraError(12516);
        saveFails(original);
        gameSessionService.restoreSession.mockResolvedValue(false);
        await expect(failWith()).resolves.toBe(original);
      });
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

    it('기록의 보드는 세션이 정한 값', async () => {
      gameSessionService.getSession.mockResolvedValue(session({ boardKey: 'weekly-2026-w43' }));
      const qb = createMockQueryBuilder({ getCount: 0 });
      gameScoreRepository.createQueryBuilder.mockReturnValue(qb as never);
      await submit();
      expect(savedScore().boardKey).toBe('weekly-2026-w43');
      // 검증기와 등록 직후 순위도 같은 보드 기준
      expect(engine.verify).toHaveBeenCalledWith(expect.objectContaining({ boardKey: 'weekly-2026-w43' }));
      expect(qb.andWhere).toHaveBeenCalledWith('s.boardKey = :boardKey', { boardKey: 'weekly-2026-w43' });

    });

    it('순위 계산만 실패하면 ranks: null로 201을 지켜야 함 (기록은 이미 커밋, 세션 소모됨)', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const failing = createMockQueryBuilder({ getCount: 0 });
      failing.getCount.mockRejectedValue(new Error('ORA-03113'));
      gameScoreRepository.createQueryBuilder.mockReturnValue(failing as never);

      const result = await submit();

      expect(result).toEqual({ scoreId: 41, score: 12340, playerName: '테트리스왕', detail: VERIFIED_DETAIL, ranks: null, points: null });
      expect(savedScore()).toBeDefined();
    });
  });

  describe('getRankings', () => {
    const row = (overrides: Partial<GameScore>) =>
      ({ scoreId: 1, boardKey: 'default', playerName: 'a', score: 100, detail: '{"lines":1}', durationMs: 1000, crtdAt: new Date(NOW), ...overrides }) as GameScore;

    it('숨김 제외·점수 내림차순·동점은 SCORE_ID 오름차순, 순위는 1부터 — IP 해시는 조회하지 않고 USER_ID는 응답에 싣지 않아야 함', async () => {
      gameScoreRepository.find.mockResolvedValue([row({ scoreId: 5, score: 900 }), row({ scoreId: 2, score: 500 })]);

      const result = await service.getRankings('tetris', {});

      const [options] = gameScoreRepository.find.mock.calls[0] as [Record<string, unknown>];
      expect(options.where).toEqual({ gameType: 'TETRIS', boardKey: 'default', isHidden: 0 });
      expect(options.order).toEqual({ score: 'DESC', scoreId: 'ASC' });
      expect(options.select).not.toHaveProperty('ipHash');
      // USER_ID는 표시 이름(계정 이름)을 정하는 데만 읽는다
      expect(options.select).toHaveProperty('userId', true);
      expect(result.items[0]).not.toHaveProperty('userId');
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

  describe('표시 이름 — 로그인 기록은 현재 계정 이름', () => {
    const row = (overrides: Partial<GameScore>) =>
      ({ scoreId: 1, boardKey: 'default', playerName: 'a', userId: null, score: 100, detail: '{}', durationMs: 1000, crtdAt: new Date(NOW), ...overrides }) as GameScore;

    it('USER_ID가 있는 기록은 USERS.USER_NAME으로, 없는 기록은 저장된 이름으로 — 사용자는 한 번에 모아 조회한다', async () => {
      gameScoreRepository.find.mockResolvedValue([
        row({ scoreId: 1, score: 900, playerName: '옛이름', userId: 7 }),
        row({ scoreId: 2, score: 800, playerName: '손님', userId: null }),
        row({ scoreId: 3, score: 700, playerName: '옛이름2', userId: 7 }),
      ]);
      userRepository.find.mockResolvedValue([{ userId: 7, userName: '새이름' } as User]);

      const result = await service.getRankings('tetris', {});

      expect(result.items.map((i) => i.playerName)).toEqual(['새이름', '손님', '새이름']);
      expect(userRepository.find).toHaveBeenCalledTimes(1);
      const [options] = userRepository.find.mock.calls[0] as [Record<string, unknown>];
      expect(options.select).toEqual({ userId: true, userName: true });
      expect((options.where as { userId: FindOperator<number[]> }).userId.value).toEqual([7]);
    });

    it('계정 이름이 비어 있으면 저장된 이름을 그대로 쓴다', async () => {
      gameScoreRepository.find.mockResolvedValue([row({ playerName: '저장이름', userId: 7 })]);
      userRepository.find.mockResolvedValue([{ userId: 7, userName: null } as User]);

      const result = await service.getRankings('tetris', {});

      expect(result.items[0].playerName).toBe('저장이름');
    });

    it.each([
      ['금칙어(사칭)', '운영자'],
      ['길이 초과(13자)', '가나다라마바사아자차카타파'],
      ['허용하지 않는 문자', '이름!'],
    ])('계정 이름이 랭킹 이름 정책을 통과하지 못하면(%s) 저장된 이름을 쓴다', async (_case, userName) => {
      gameScoreRepository.find.mockResolvedValue([row({ playerName: '저장이름', userId: 7 })]);
      userRepository.find.mockResolvedValue([{ userId: 7, userName } as User]);

      const result = await service.getRankings('tetris', {});

      expect(result.items[0].playerName).toBe('저장이름');
    });

    it('계정 이름은 제출 때와 같이 정규화한다 — 앞뒤 공백 제거·연속 공백 1개', async () => {
      gameScoreRepository.find.mockResolvedValue([row({ playerName: '저장이름', userId: 7 })]);
      userRepository.find.mockResolvedValue([{ userId: 7, userName: '  새   이름 ' } as User]);

      const result = await service.getRankings('tetris', {});

      expect(result.items[0].playerName).toBe('새 이름');
    });

    it('로그인 기록이 없으면 사용자를 조회하지 않는다', async () => {
      gameScoreRepository.find.mockResolvedValue([row({ userId: null })]);

      await service.getRankings('tetris', {});

      expect(userRepository.find).not.toHaveBeenCalled();
    });

    it('명예의 전당도 캐시된 입상 기록 위에 현재 계정 이름을 입힌다', async () => {
      hallOfFameService.getPodiums.mockResolvedValue([
        { period: 'weekly', startsAt: new Date(NOW), endsAt: new Date(NOW), boardKey: 'default', rows: [row({ scoreId: 9, playerName: '옛이름', userId: 7 })] },
      ]);
      userRepository.find.mockResolvedValue([{ userId: 7, userName: '새이름' } as User]);

      const result = await service.getHallOfFame('tetris');

      expect(result.periods[0].podium[0].playerName).toBe('새이름');
      expect(result.periods[0].podium[0]).not.toHaveProperty('userId');
    });
  });

  describe('내 기록 — isMine·getMyBest', () => {
    const row = (overrides: Partial<GameScore>) =>
      ({ scoreId: 1, boardKey: 'default', playerName: 'a', userId: null, score: 100, detail: '{}', durationMs: 1000, crtdAt: new Date(NOW), ...overrides }) as GameScore;

    it('요청자의 로그인 기록만 isMine true — 다른 사용자·비로그인 기록은 false', async () => {
      gameScoreRepository.find.mockResolvedValue([row({ scoreId: 1, userId: 7 }), row({ scoreId: 2, userId: 8 }), row({ scoreId: 3, userId: null })]);

      const result = await service.getRankings('tetris', {}, 7);

      expect(result.items.map((i) => [i.scoreId, i.isMine])).toEqual([[1, true], [2, false], [3, false]]);
    });

    it('비로그인 조회는 모두 false', async () => {
      gameScoreRepository.find.mockResolvedValue([row({ scoreId: 1, userId: 7 })]);

      const result = await service.getRankings('tetris', {});

      expect(result.items[0].isMine).toBe(false);
    });

    it('명예의 전당·기록 단건도 요청자 기준으로 isMine을 채운다', async () => {
      hallOfFameService.getPodiums.mockResolvedValue([
        { period: 'weekly', startsAt: new Date(NOW), endsAt: new Date(NOW), boardKey: 'default', rows: [row({ scoreId: 9, userId: 7 })] },
      ]);
      gameScoreRepository.findOne.mockResolvedValue(row({ scoreId: 41, userId: 7 }));
      gameScoreRepository.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getCount: 0 }) as never);

      const hall = await service.getHallOfFame('tetris', 7);
      const score = await service.getScore('tetris', 41, 7);

      expect(hall.periods[0].podium[0].isMine).toBe(true);
      expect(score.isMine).toBe(true);
    });

    it('getMyBest — 요청자의 숨기지 않은 기록 중 최고점, 동점은 먼저 저장된 기록', async () => {
      gameScoreRepository.findOne.mockResolvedValue({ scoreId: 128, score: 281542, boardKey: 'default' } as GameScore);

      const result = await service.getMyBest('tetris', 7);

      expect(result).toEqual({ score: 281542, scoreId: 128, boardKey: 'default' });
      const [options] = gameScoreRepository.findOne.mock.calls[0] as [Record<string, unknown>];
      expect(options.where).toEqual({ gameType: 'TETRIS', userId: 7, isHidden: 0 });
      expect(options.order).toEqual({ score: 'DESC', scoreId: 'ASC' });
    });

    it('getMyBest — board를 주면 그 보드만', async () => {
      gameScoreRepository.findOne.mockResolvedValue(null);

      const result = await service.getMyBest('tetris', 7, 'daily-2026-10-25');

      expect(result).toEqual({ score: null, scoreId: null, boardKey: null });
      const [options] = gameScoreRepository.findOne.mock.calls[0] as [Record<string, unknown>];
      expect(options.where).toEqual({ gameType: 'TETRIS', userId: 7, isHidden: 0, boardKey: 'daily-2026-10-25' });
    });

    it('getMyBest — 비로그인은 조회하지 않고 null', async () => {
      const result = await service.getMyBest('tetris', null);

      expect(result).toEqual({ score: null, scoreId: null, boardKey: null });
      expect(gameScoreRepository.findOne).not.toHaveBeenCalled();
    });

    it('getMyBest — 모르는 게임은 404 GAME_NOT_FOUND', async () => {
      await expect(service.getMyBest('chess', 7)).rejects.toMatchObject({ code: 'GAME_NOT_FOUND', status: 404 });
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
      expect(options.select).toHaveProperty('userId', true);
      expect(gameReplayRepository.findOneBy).not.toHaveBeenCalled();
      expect(qb.andWhere).not.toHaveBeenCalledWith('s.crtdAt >= :periodStart', expect.anything());
      expect(qb.andWhere).toHaveBeenCalledWith('s.boardKey = :boardKey', { boardKey: 'default' });
      expect(result).toEqual({ rank: 5, scoreId: 41, boardKey: 'default', playerName: 'a', score: 900, detail: { lines: 3 }, durationMs: 1000, viewCount: 0, watchMs: 0, trophies: null, isMine: false, createdAt: new Date(NOW) });
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
    it('보드 스킨은 그 판 당시 저장값 — 없거나(기능 전 기록·게스트) 깨진 값이면 default, 소유자·장착을 읽지 않는다 (D-007)', async () => {
      gameScoreRepository.findOne.mockResolvedValue({ scoreId: 41, playerName: 'a', score: 900, detail: '{}', durationMs: 1, crtdAt: new Date(NOW) } as GameScore);
      const replayRow = (boardSkins: string | null) => ({
        scoreId: 41, gameType: 'TETRIS' as const, engineVersion: 1, seed: 99,
        replay: gzipSync(JSON.stringify({ das: 8, arr: 1, frames: 600, inputs: [] })), crtdAt: new Date(NOW), boardSkins,
      });
      const DEFAULT = { block: 'default', effect: 'default', board: 'default', levels: { block: 1, effect: 1, board: 1 } };

      gameReplayRepository.findOneBy.mockResolvedValueOnce(replayRow(JSON.stringify({ block: 'neon', effect: 'gameboy', board: 'high-contrast' })));
      // 레벨 기능 전 기록 — 레벨은 모두 1
      expect((await service.getReplay('tetris', 41)).skins).toEqual({ block: 'neon', effect: 'gameboy', board: 'high-contrast', levels: { block: 1, effect: 1, board: 1 } });
      // 레벨이 있는 기록은 그 레벨, 범위 밖·정수 아닌 레벨은 1 (skin-levels D-002)
      gameReplayRepository.findOneBy.mockResolvedValueOnce(
        replayRow(JSON.stringify({ block: 'chocolate', effect: 'clear', board: 'neon', levels: { block: 5, effect: 9, board: 2.5 } })),
      );
      expect((await service.getReplay('tetris', 41)).skins).toEqual({ block: 'chocolate', effect: 'clear', board: 'neon', levels: { block: 5, effect: 1, board: 1 } });
      gameReplayRepository.findOneBy.mockResolvedValueOnce(replayRow(null));
      expect((await service.getReplay('tetris', 41)).skins).toEqual(DEFAULT);
      gameReplayRepository.findOneBy.mockResolvedValueOnce(replayRow('{"block":"neon"}'));
      expect((await service.getReplay('tetris', 41)).skins).toEqual(DEFAULT);
      expect(userSkinService.boardSkinsOf).not.toHaveBeenCalled();
    });

    it('숨김이 아닌 기록이면 gzip을 풀어 재생 데이터를 돌려줘야 함', async () => {
      gameScoreRepository.findOne.mockResolvedValue({ scoreId: 41, playerName: 'a', score: 900, detail: '{}', durationMs: 1, crtdAt: new Date(NOW) } as GameScore);
      gameReplayRepository.findOneBy.mockResolvedValue({
        scoreId: 41,
        gameType: 'TETRIS',
        engineVersion: 1,
        seed: 99,
        replay: gzipSync(JSON.stringify({ das: 8, arr: 1, frames: 600, inputs: [1, 6] })),
        crtdAt: new Date(NOW),
        boardSkins: null,
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

  describe('기간 필터 없는 보드 · 게임별 최상위 리플레이 필드 (디펜스 주간 등)', () => {
    beforeEach(() => {
      engine.isPeriodRanking.mockReturnValue(false);
      engine.isRankingBoard.mockReturnValue(true);
    });

    it('getRankings는 period를 무시하고 보드 전체를 본다', async () => {
      gameScoreRepository.find.mockResolvedValue([]);

      const result = await service.getRankings('tetris', { board: 'weekly-2026-w43', period: 'daily' });

      const [options] = gameScoreRepository.find.mock.calls[0] as [{ where: Record<string, unknown> }];
      expect(options.where).not.toHaveProperty('crtdAt');
      expect(options.where).toMatchObject({ boardKey: 'weekly-2026-w43' });
      expect(engine.isPeriodRanking).toHaveBeenCalledWith('weekly-2026-w43');
      expect(result.periodStart).toBeNull();
    });

    it('등록 직후 순위는 보드 전체 순위 하나를 세 기간에 같이 싣는다', async () => {
      gameSessionService.getSession.mockResolvedValue(session({ boardKey: 'weekly-2026-w43' }));
      const qb = createMockQueryBuilder({ getCount: 6 });
      gameScoreRepository.createQueryBuilder.mockReturnValue(qb as never);

      const result = await service.submitScore({
        gameTypeParam: 'tetris',
        dto: dto(),
        userId: null,
        ip: undefined,
      });

      expect(result.ranks).toEqual({ daily: 7, weekly: 7, all: 7 });
      expect(gameScoreRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(qb.andWhere).toHaveBeenCalledWith('s.boardKey = :boardKey', { boardKey: 'weekly-2026-w43' });
      expect(qb.andWhere).not.toHaveBeenCalledWith('s.crtdAt >= :periodStart', expect.anything());
    });

    it('getReplay는 엔진이 정한 최상위 필드만 펼친다 — 없으면 params에만', async () => {
      engine.topLevelReplayParams = [];
      gameScoreRepository.findOne.mockResolvedValue({
        scoreId: 41,
        playerName: 'a',
        score: 900,
        detail: '{}',
        durationMs: 1,
        crtdAt: new Date(NOW),
      } as GameScore);
      gameReplayRepository.findOneBy.mockResolvedValue({
        scoreId: 41,
        gameType: 'TETRIS',
        engineVersion: 1,
        seed: 99,
        replay: gzipSync(JSON.stringify({ frames: 600, inputs: [0, 0] })),
        crtdAt: new Date(NOW),
        boardSkins: null,
      });

      const result = await service.getReplay('tetris', 41);

      expect(result).toEqual(expect.objectContaining({ params: {}, frames: 600, inputs: [0, 0] }));
      expect(result).not.toHaveProperty('das');
      expect(result).not.toHaveProperty('arr');
    });

    it('공개하지 않는 보드(진행 중 주간)의 기록은 리플레이를 읽지 않고 404 GAME_SCORE_NOT_FOUND', async () => {
      engine.isReplayPublic.mockReturnValue(false);
      gameScoreRepository.findOne.mockResolvedValue({
        scoreId: 41,
        boardKey: 'weekly-2026-w43',
        playerName: 'a',
        score: 900,
        detail: '{}',
        durationMs: 1,
        crtdAt: new Date(NOW),
      } as GameScore);

      await expect(service.getReplay('tetris', 41)).rejects.toMatchObject({
        code: 'GAME_SCORE_NOT_FOUND',
        status: 404,
      });
      expect(engine.isReplayPublic).toHaveBeenCalledWith('weekly-2026-w43', new Date(NOW));
      expect(gameReplayRepository.findOneBy).not.toHaveBeenCalled();
    });
  });

  /**
   * 리플레이 조회수·시청시간·인기 목록 (docs/tasks/replay-views).
   * 집계는 기록 × KST 하루 1행에 더하고, 누적 값은 SUM으로 읽는다. 시청자(IP 해시)별 하루 상한은 GameViewService(Redis)가 정한다.
   */
  describe('리플레이 조회 집계 (replay-views)', () => {
    const TODAY_KST = '2026-10-21'; // NOW(10-21 14:00 KST)의 KST 날짜
    const TODAY_START = new Date('2026-10-20T15:00:00.000Z'); // 그날 KST 00:00
    const visible = (overrides: Partial<GameScore> = {}) =>
      ({ scoreId: 41, boardKey: 'default', playerName: 'a', score: 900, detail: '{}', durationMs: 100_000, crtdAt: new Date(NOW), ...overrides }) as GameScore;
    const totals = (rows: { scoreId: number; viewCount: number; watchMs: number }[]) =>
      viewStatRepository.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getRawMany: rows }) as never);
    const oraError = (errorNum: number) => new QueryFailedError('INSERT', [], Object.assign(new Error(`ORA-${errorNum}`), { errorNum }));
    const viewerKey = createHmac('sha256', 'test-secret').update('1.2.3.4').digest('hex');

    beforeEach(() => {
      gameScoreRepository.findOne.mockResolvedValue(visible());
      viewStatRepository.increment.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });
    });

    describe('recordView', () => {
      it('오늘(KST) 행에 조회 1을 더하고 누적 값을 돌려준다 — 시청자 키는 IP 해시', async () => {
        totals([{ scoreId: 41, viewCount: 13, watchMs: 0 }]);

        await expect(service.recordView('tetris', 41, '1.2.3.4')).resolves.toEqual({ scoreId: 41, viewCount: 13, counted: true });
        expect(gameViewService.claimView).toHaveBeenCalledWith(41, viewerKey);
        expect(viewStatRepository.increment).toHaveBeenCalledWith({ scoreId: 41, statDate: TODAY_KST }, 'viewCount', 1);
        expect(viewStatRepository.insert).not.toHaveBeenCalled();
      });

      it('오늘 행이 없으면 새로 넣는다 — 게임 종류와 함께', async () => {
        viewStatRepository.increment.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });

        await service.recordView('tetris', 41, '1.2.3.4');

        expect(viewStatRepository.insert).toHaveBeenCalledWith({ scoreId: 41, statDate: TODAY_KST, gameType: 'TETRIS', viewCount: 1, watchMs: 0 });
      });

      it('같은 순간 다른 요청이 오늘 행을 먼저 넣었으면(ORA-00001) 다시 더한다', async () => {
        viewStatRepository.increment.mockResolvedValueOnce({ affected: 0, raw: [], generatedMaps: [] });
        viewStatRepository.insert.mockRejectedValue(oraError(1));

        await service.recordView('tetris', 41, '1.2.3.4');

        expect(viewStatRepository.increment).toHaveBeenCalledTimes(2);
      });

      it('유니크·FK 위반이 아닌 DB 오류는 그대로 던진다', async () => {
        viewStatRepository.increment.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });
        viewStatRepository.insert.mockRejectedValue(oraError(1400));

        await expect(service.recordView('tetris', 41, '1.2.3.4')).rejects.toBeInstanceOf(QueryFailedError);
      });

      it('확인과 저장 사이에 기록이 지워졌으면(FK 위반 ORA-02291) 404 GAME_SCORE_NOT_FOUND', async () => {
        viewStatRepository.increment.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });
        viewStatRepository.insert.mockRejectedValue(oraError(2291));

        await expect(service.recordView('tetris', 41, '1.2.3.4')).rejects.toMatchObject({ code: 'GAME_SCORE_NOT_FOUND', status: 404 });
      });

      it('같은 IP의 하루 상한을 넘으면 더하지 않고 counted false (200)', async () => {
        gameViewService.claimView.mockResolvedValue(false);
        totals([{ scoreId: 41, viewCount: 5, watchMs: 0 }]);

        await expect(service.recordView('tetris', 41, '1.2.3.4')).resolves.toEqual({ scoreId: 41, viewCount: 5, counted: false });
        expect(viewStatRepository.increment).not.toHaveBeenCalled();
      });

      it('IP 해시 시크릿이 없으면 서버 상한 없이 센다', async () => {
        delete env.GAME_IP_HASH_SECRET;

        await expect(service.recordView('tetris', 41, '1.2.3.4')).resolves.toEqual({ scoreId: 41, viewCount: 0, counted: true });
        expect(gameViewService.claimView).not.toHaveBeenCalled();
        expect(viewStatRepository.increment).toHaveBeenCalled();
      });

      it.each([
        ['없거나 숨긴 기록', () => gameScoreRepository.findOne.mockResolvedValue(null)],
        ['공개 전 보드(진행 중 주간)', () => engine.isReplayPublic.mockReturnValue(false)],
      ])('%s → 404 GAME_SCORE_NOT_FOUND, 집계하지 않음', async (_name, arrange) => {
        arrange();

        await expect(service.recordView('tetris', 41, '1.2.3.4')).rejects.toMatchObject({ code: 'GAME_SCORE_NOT_FOUND', status: 404 });
        expect(gameViewService.claimView).not.toHaveBeenCalled();
        expect(viewStatRepository.increment).not.toHaveBeenCalled();
      });
    });

    describe('recordWatch', () => {
      it('상한 안의 증분을 오늘 행에 더한다 — 하루 상한은 리플레이 길이 × 3', async () => {
        totals([{ scoreId: 41, viewCount: 1, watchMs: 30_000 }]);

        await expect(service.recordWatch('tetris', 41, 30_000, '1.2.3.4')).resolves.toEqual({ scoreId: 41, watchMs: 30_000, countedMs: 30_000 });
        expect(gameViewService.claimWatchMs).toHaveBeenCalledWith(41, viewerKey, 30_000, 300_000);
        expect(viewStatRepository.increment).toHaveBeenCalledWith({ scoreId: 41, statDate: TODAY_KST }, 'watchMs', 30_000);
      });

      it('짧은 리플레이도 하루 상한은 최소 1분', async () => {
        gameScoreRepository.findOne.mockResolvedValue(visible({ durationMs: 5_000 }));

        await service.recordWatch('tetris', 41, 10_000, '1.2.3.4');

        expect(gameViewService.claimWatchMs).toHaveBeenCalledWith(41, viewerKey, 10_000, 60_000);
      });

      it('상한을 넘어 반영할 몫이 0이면 더하지 않는다', async () => {
        gameViewService.claimWatchMs.mockResolvedValue(0);

        await expect(service.recordWatch('tetris', 41, 30_000, '1.2.3.4')).resolves.toEqual({ scoreId: 41, watchMs: 0, countedMs: 0 });
        expect(viewStatRepository.increment).not.toHaveBeenCalled();
      });

      it('공개 전 보드면 404', async () => {
        engine.isReplayPublic.mockReturnValue(false);

        await expect(service.recordWatch('tetris', 41, 30_000, '1.2.3.4')).rejects.toMatchObject({ code: 'GAME_SCORE_NOT_FOUND', status: 404 });
      });
    });

    describe('누적 값을 랭킹 항목에 싣는다', () => {
      it('getRankings — 목록 기록들의 집계를 한 번에 SUM으로 읽고, 집계 없는 기록은 0', async () => {
        gameScoreRepository.find.mockResolvedValue([visible({ scoreId: 41 }), visible({ scoreId: 42 })]);
        const qb = createMockQueryBuilder({ getRawMany: [{ scoreId: '41', viewCount: '3', watchMs: '9000' }] });
        viewStatRepository.createQueryBuilder.mockReturnValue(qb as never);

        const { items } = await service.getRankings('tetris', {});

        expect(viewStatRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
        expect(qb.groupBy).toHaveBeenCalledWith('v.scoreId');
        expect(items.map(({ scoreId, viewCount, watchMs }) => ({ scoreId, viewCount, watchMs }))).toEqual([
          { scoreId: 41, viewCount: 3, watchMs: 9000 },
          { scoreId: 42, viewCount: 0, watchMs: 0 },
        ]);
      });

      it('빈 랭킹이면 집계를 읽지 않는다', async () => {
        gameScoreRepository.find.mockResolvedValue([]);

        await service.getRankings('tetris', {});

        expect(viewStatRepository.createQueryBuilder).not.toHaveBeenCalled();
      });
    });

    describe('getPopularReplays', () => {
      it('기간 안 합으로 정렬한 순서대로 항목을 만든다 — rank는 인기 순서, 누적·기간 값을 함께', async () => {
        const popularQb = createMockQueryBuilder({
          getRawMany: [
            { scoreId: '42', viewCount: '5', watchMs: '1000' },
            { scoreId: '41', viewCount: '2', watchMs: '500' },
          ],
        });
        const totalsQb = createMockQueryBuilder({
          getRawMany: [
            { scoreId: '41', viewCount: '10', watchMs: '9000' },
            { scoreId: '42', viewCount: '6', watchMs: '2000' },
          ],
        });
        viewStatRepository.createQueryBuilder.mockReturnValueOnce(popularQb as never).mockReturnValueOnce(totalsQb as never);
        gameScoreRepository.find.mockResolvedValue([visible({ scoreId: 41 }), visible({ scoreId: 42 })]);

        const result = await service.getPopularReplays('tetris', { period: 'daily', sort: 'views' });

        expect(popularQb.andWhere).toHaveBeenCalledWith('v.statDate >= :fromDate', { fromDate: TODAY_KST });
        expect(popularQb.andWhere).toHaveBeenCalledWith('s.isHidden = 0');
        expect(popularQb.orderBy).toHaveBeenCalledWith('SUM(v.viewCount)', 'DESC');
        expect(popularQb.limit).toHaveBeenCalledWith(10);
        expect(result).toEqual(expect.objectContaining({ boardKey: 'default', period: 'daily', sort: 'views', periodStart: TODAY_START }));
        expect(result.items.map(({ rank, scoreId, viewCount, periodViewCount, periodWatchMs }) => ({ rank, scoreId, viewCount, periodViewCount, periodWatchMs }))).toEqual([
          { rank: 1, scoreId: 42, viewCount: 6, periodViewCount: 5, periodWatchMs: 1000 },
          { rank: 2, scoreId: 41, viewCount: 10, periodViewCount: 2, periodWatchMs: 500 },
        ]);
      });

      it('기본값 — 주간·조회수순·기본 보드. sort=watch는 시청시간 합으로, all은 기간 필터 없음', async () => {
        const qb = createMockQueryBuilder({ getRawMany: [] });
        viewStatRepository.createQueryBuilder.mockReturnValue(qb as never);

        await expect(service.getPopularReplays('tetris', {})).resolves.toEqual(
          expect.objectContaining({ period: 'weekly', sort: 'views', boardKey: 'default', items: [] }),
        );
        await service.getPopularReplays('tetris', { period: 'all', sort: 'watch' });

        expect(qb.orderBy).toHaveBeenLastCalledWith('SUM(v.watchMs)', 'DESC');
        expect(qb.andWhere).toHaveBeenCalledTimes(2 + 1 + 2); // 주간: 보드·숨김 + 기간 / 전체: 보드·숨김
        expect(gameScoreRepository.find).not.toHaveBeenCalled();
      });

      it('두 조회 사이에 숨겨진 기록은 빼고 남은 순서로 다시 매긴다', async () => {
        viewStatRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder({ getRawMany: [{ scoreId: '42', viewCount: '5', watchMs: '0' }, { scoreId: '41', viewCount: '2', watchMs: '0' }] }) as never,
        );
        gameScoreRepository.find.mockResolvedValue([visible({ scoreId: 41 })]);

        const { items } = await service.getPopularReplays('tetris', {});

        expect(items.map(({ rank, scoreId }) => ({ rank, scoreId }))).toEqual([{ rank: 1, scoreId: 41 }]);
      });

      it('재생을 공개하지 않는 보드(진행 중 주간)는 집계를 읽지 않고 빈 목록', async () => {
        engine.isReplayPublic.mockReturnValue(false);

        await expect(service.getPopularReplays('tetris', {})).resolves.toEqual(expect.objectContaining({ items: [] }));
        expect(viewStatRepository.createQueryBuilder).not.toHaveBeenCalled();
      });

      it('랭킹 보드가 아니면 422 VALIDATION_ERROR', async () => {
        await expect(service.getPopularReplays('tetris', { board: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 });
      });
    });
  });

  /** 명예의 전당·배지 (docs/tasks/games-growth D-007·D-010) — 사용자 ID는 배지 계산에만 쓰고 응답에 싣지 않는다 */
  describe('명예의 전당·배지', () => {
    const scoreRow = (scoreId: number) =>
      ({ scoreId, boardKey: 'default', playerName: `p${scoreId}`, score: 900, detail: '{}', durationMs: 1, crtdAt: new Date(NOW) }) as GameScore;

    it('랭킹 — 입상한 로그인 사용자의 기록에만 trophies, USER_ID는 배지 계산용으로 따로 읽는다', async () => {
      hallOfFameService.trophiesByUser.mockResolvedValue(new Map([[7, { gold: 1, silver: 0, bronze: 2 }]]));
      gameScoreRepository.find
        .mockResolvedValueOnce([scoreRow(41), scoreRow(42)])
        .mockResolvedValueOnce([
          { scoreId: 41, userId: 7 },
          { scoreId: 42, userId: null },
        ] as GameScore[]);

      const { items } = await service.getRankings('tetris', {});

      expect(gameScoreRepository.find).toHaveBeenLastCalledWith({ select: { scoreId: true, userId: true }, where: { scoreId: expect.anything(), gameType: 'TETRIS' } });
      expect(items.map(({ scoreId, trophies }) => ({ scoreId, trophies }))).toEqual([
        { scoreId: 41, trophies: { gold: 1, silver: 0, bronze: 2 } },
        { scoreId: 42, trophies: null },
      ]);
      expect(items[0]).not.toHaveProperty('userId');
    });

    it('입상자가 없으면 기록의 USER_ID를 읽지 않는다', async () => {
      gameScoreRepository.find.mockResolvedValue([scoreRow(41)]);

      await service.getRankings('tetris', {});

      expect(gameScoreRepository.find).toHaveBeenCalledTimes(1);
    });

    it('배지 계산이 실패해도 랭킹은 배지 없이 돌려준다', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      hallOfFameService.trophiesByUser.mockRejectedValue(new Error('db'));
      gameScoreRepository.find.mockResolvedValue([scoreRow(41)]);

      const { items } = await service.getRankings('tetris', {});

      expect(items[0].trophies).toBeNull();
    });

    it('getHallOfFame — 기간별 시상대를 랭킹 항목으로, 순위는 기간 안 순위', async () => {
      const period = { kind: 'weekly' as const, boardKey: 'default', startsAt: new Date('2026-10-11T15:00:00.000Z'), endsAt: new Date('2026-10-18T15:00:00.000Z') };
      hallOfFameService.getPodiums.mockResolvedValue([{ ...period, rows: [{ ...scoreRow(41), userId: 7 }, { ...scoreRow(42), userId: null }] }]);
      hallOfFameService.trophiesByUser.mockResolvedValue(new Map([[7, { gold: 1, silver: 0, bronze: 0 }]]));

      const { periods } = await service.getHallOfFame('tetris');

      expect(periods).toHaveLength(1);
      expect(periods[0]).toEqual(expect.objectContaining(period));
      expect(periods[0].podium.map(({ rank, scoreId, trophies }) => ({ rank, scoreId, trophies }))).toEqual([
        { rank: 1, scoreId: 41, trophies: { gold: 1, silver: 0, bronze: 0 } },
        { rank: 2, scoreId: 42, trophies: null },
      ]);
      expect(periods[0].podium[0]).not.toHaveProperty('userId');
    });
  });
});

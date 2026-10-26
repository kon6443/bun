import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GamesController } from '../src/modules/games/games.controller';
import { GamesService } from '../src/modules/games/games.service';
import { GameSessionService } from '../src/modules/games/game-session.service';
import { GameViewService } from '../src/modules/games/game-view.service';
import { GameHallOfFameService } from '../src/modules/games/game-hall-of-fame.service';
import { GAME_ENGINE_REGISTRY, GameEngine } from '../src/modules/games/game-engine.registry';
import { createTetrisGameEngine } from '../src/modules/games/tetris-game-engine';
import { createDefenseGameEngine } from '../src/modules/games/defense-game-engine';
import { verifyDefenseReplay } from '../src/modules/games/defense-verify';
import { ENGINE_VERSION as DEFENSE_ENGINE_VERSION } from '../src/modules/games/defense-engine';
import { weeklySeed } from '../src/modules/games/weekly-board';
import golden from '../src/modules/games/tetris-engine/__fixtures__/golden-replays.json';
import { GameScore } from '../src/entities/GameScore';
import { GameReplay } from '../src/entities/GameReplay';
import { GameReplayViewStat } from '../src/entities/GameReplayViewStat';
import { User } from '../src/entities/User';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createE2eApp, E2eApp } from './helpers/e2e-app';
import { UserSkinService } from '../src/modules/users/user-skin.service';
import { UserSkinEquip } from '../src/entities/UserSkinEquip';
import { sign } from 'jsonwebtoken';
import { createUser } from '../src/entities/__spec__/entity.factory';

type GoldenCase = { name: string; input: { seed: number; das: number; arr: number; frames: number; inputs: number[] }; expected: Record<string, unknown> };
const CASES = golden as GoldenCase[];
const SUCCESS = CASES.find((c) => c.name === 'back-to-back')!;
const FAILURE = CASES.find((c) => c.expected.reason === 'NOT_ENDED')!;

/** Redis 대역 — set·get·getdel만 (GameSessionService가 쓰는 명령) */
class FakeRedis {
  status = 'ready';
  store = new Map<string, string>();
  set(key: string, value: string) {
    this.store.set(key, value);
    return Promise.resolve('OK');
  }
  get(key: string) {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  getdel(key: string) {
    const value = this.store.get(key) ?? null;
    this.store.delete(key);
    return Promise.resolve(value);
  }
}

/**
 * 게임 REST를 HTTP 경계에서 검증한다 (docs/tasks/games DESIGN.md §2·§3·§4·§7).
 *
 * 실제 GamesService·GameSessionService·**실제 테트리스 엔진**을 태우고 Repository·Redis만 대역으로 바꾼다.
 * 골든 리플레이(프론트와 같은 픽스처)를 실제로 제출해 서버가 점수를 계산·저장하는지, 위조·재사용이 막히는지 본다.
 * 라우트 스로틀은 E2E가 CustomThrottlerGuard를 조립하지 않아 여기서 보지 않는다.
 */
describe('E2E 게임', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let redis: FakeRedis;
  let gameScoreRepository: MockRepository<GameScore>;
  let gameReplayRepository: MockRepository<GameReplay>;
  let viewStatRepository: MockRepository<GameReplayViewStat>;
  let skinEquipRepository: MockRepository<UserSkinEquip>;
  let saved: Record<string, unknown>[];
  /** 레지스트리 — 테스트가 검증기를 바꿔 끼울 수 있게 매번 새 객체 */
  let engines: Record<string, GameEngine>;
  /** ConfigService 대역의 값 — 테스트가 주간 비밀값을 빼 볼 수 있게 매번 새 객체 */
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    redis = new FakeRedis();
    gameScoreRepository = createMockRepository<GameScore>();
    gameReplayRepository = createMockRepository<GameReplay>();
    viewStatRepository = createMockRepository<GameReplayViewStat>();
    viewStatRepository.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getRawMany: [] }) as never);
    viewStatRepository.increment.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });
    saved = [];
    env = { GAME_IP_HASH_SECRET: 'e2e-secret', GAME_WEEKLY_SEED_SECRET: 'e2e-weekly' };
    // 디펜스 검증은 워커 대신 같은 함수를 인프로세스로 — 운영 배선(GamesModule)과 같은 엔진 항목
    engines = {
      TETRIS: createTetrisGameEngine({ getDailySecret: () => env.GAME_WEEKLY_SEED_SECRET }),
      DEFENSE: createDefenseGameEngine({
        getWeeklySecret: () => env.GAME_WEEKLY_SEED_SECRET,
        verify: input => Promise.resolve(verifyDefenseReplay(input)),
      }),
    };
    const manager = {
      create: (_entity: unknown, data: Record<string, unknown>) => data,
      save: (data: Record<string, unknown>) => {
        const row = 'playerName' in data ? { ...data, scoreId: 41 } : data;
        saved.push(row);
        return Promise.resolve(row);
      },
    };

    skinEquipRepository = createMockRepository<UserSkinEquip>();
    skinEquipRepository.find.mockResolvedValue([]);
    e2e = await createE2eApp({
      controllers: [GamesController],
      providers: [
        GamesService,
        GameSessionService,
        // Redis 미주입 — 조회 상한은 fail-open(상한 없이 반영)으로 돈다
        GameViewService,
        // Redis 미주입 — 명예의 전당은 매번 계산한다
        GameHallOfFameService,
        { provide: GAME_ENGINE_REGISTRY, useValue: engines },
        { provide: getRepositoryToken(GameScore), useValue: gameScoreRepository },
        { provide: getRepositoryToken(GameReplay), useValue: gameReplayRepository },
        { provide: getRepositoryToken(GameReplayViewStat), useValue: viewStatRepository },
        // 보드 주인 스킨 — 장착 없음(모두 default)
        UserSkinService,
        { provide: getRepositoryToken(UserSkinEquip), useValue: skinEquipRepository },
        // OptionalJwtAuthGuard(JwtAuthGuard 상속)의 의존 — 토큰이 없으면 쓰지 않는다
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
        {
          provide: getDataSourceToken(),
          useValue: { transaction: (run: (m: typeof manager) => unknown) => run(manager) } as unknown as DataSource,
        },
      ],
    });
    app = e2e.app;
    app.get(GameSessionService).setRedisClient(redis as never);
    gameScoreRepository.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getCount: 2 }) as never);
  });

  afterEach(async () => {
    await app.close();
  });

  /** 세션을 발급받고, 골든 케이스를 재현하도록 seed·시작 시각을 맞춘다(서버 발급 seed는 랜덤이므로) */
  const issueSession = async (seed: number, startedAgoMs = 3_600_000) => {
    const res = await request(app.getHttpServer()).post(e2e.url('/games/tetris/sessions')).expect(201);
    const key = `game:session:${res.body.data.sessionId}`;
    const session = JSON.parse(redis.store.get(key)!);
    redis.store.set(key, JSON.stringify({ ...session, seed, startedAt: Date.now() - startedAgoMs }));
    return res.body.data.sessionId as string;
  };
  const body = (sessionId: string, c: GoldenCase, extra: Record<string, unknown> = {}) => ({
    sessionId,
    playerName: '  테트리스   왕 ',
    replay: { engineVersion: 1, das: c.input.das, arr: c.input.arr, frames: c.input.frames, inputs: c.input.inputs },
    ...extra,
  });
  const submit = (payload: object) => request(app.getHttpServer()).post(e2e.url('/games/tetris/scores')).send(payload);

  describe('POST /games/:gameType/sessions', () => {
    it('비로그인도 201 — seed·엔진 버전·만료 시각을 주고 Redis에 저장해야 함', async () => {
      const res = await request(app.getHttpServer()).post(e2e.url('/games/tetris/sessions')).expect(201);

      expect(res.body.data).toEqual(
        expect.objectContaining({ engineVersion: 1, seed: expect.any(Number), expiresAt: expect.any(String), ttlSeconds: 7200, boardKey: 'default', mode: null }),
      );
      // 본문 없이 보내도(테트리스 기존 클라이언트) 기본 보드로 세션을 저장한다
      expect(JSON.parse(redis.store.get(`game:session:${res.body.data.sessionId}`)!)).toEqual(expect.objectContaining({ boardKey: 'default' }));
    });

    it.each([
      ['테트리스가 지원하지 않는 플레이 방식', { board: 'weekly' }],
      ['board 형식 위반', { board: 'Weekly!' }],
      ['정의 외 필드', { seed: 1 }],
    ])('%s → 422 VALIDATION_ERROR — 세션을 만들지 않아야 함', async (_name, payload) => {
      const res = await request(app.getHttpServer()).post(e2e.url('/games/tetris/sessions')).send(payload).expect(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(redis.store.size).toBe(0);
    });

    it('board=daily → 오늘의 테트리스 보드 + 데일리 seed(같은 날 전원 동일) (games-growth D-004)', async () => {
      const first = await request(app.getHttpServer()).post(e2e.url('/games/tetris/sessions')).send({ board: 'daily' }).expect(201);
      const second = await request(app.getHttpServer()).post(e2e.url('/games/tetris/sessions')).send({ board: 'daily' }).expect(201);

      expect(first.body.data).toEqual(expect.objectContaining({ boardKey: expect.stringMatching(/^daily-\d{4}-\d{2}-\d{2}$/), mode: 'daily' }));
      expect(second.body.data.seed).toBe(first.body.data.seed);
    });

    it('데일리 비밀값이 없으면 daily만 503 GAME_DAILY_UNAVAILABLE', async () => {
      delete env.GAME_WEEKLY_SEED_SECRET;

      const res = await request(app.getHttpServer()).post(e2e.url('/games/tetris/sessions')).send({ board: 'daily' }).expect(503);
      expect(res.body.code).toBe('GAME_DAILY_UNAVAILABLE');
      await request(app.getHttpServer()).post(e2e.url('/games/tetris/sessions')).expect(201);
    });

    describe('도전장 challengeScoreId (games-growth D-005)', () => {
      beforeEach(() => {
        gameScoreRepository.findOne.mockResolvedValue({ scoreId: 41, boardKey: 'default', playerName: 'a', score: 900, detail: '{}', durationMs: 1, crtdAt: new Date() } as GameScore);
      });

      it('원본의 seed로 challenge-{원본 ID} 보드 세션 — 세션에 원본 ID를 남긴다', async () => {
        (gameReplayRepository.findOne as jest.Mock).mockResolvedValue({ seed: 777, engineVersion: 1 });

        const res = await request(app.getHttpServer()).post(e2e.url('/games/tetris/sessions')).send({ challengeScoreId: 41 }).expect(201);

        expect(res.body.data).toEqual(expect.objectContaining({ boardKey: 'challenge-41', mode: 'challenge', seed: 777 }));
        expect(JSON.parse(redis.store.get(`game:session:${res.body.data.sessionId}`)!)).toEqual(expect.objectContaining({ challengeOf: 41 }));
      });

      it('원본 엔진 버전이 다르면 409 GAME_CHALLENGE_EXPIRED', async () => {
        (gameReplayRepository.findOne as jest.Mock).mockResolvedValue({ seed: 777, engineVersion: 0 });

        const res = await request(app.getHttpServer()).post(e2e.url('/games/tetris/sessions')).send({ challengeScoreId: 41 }).expect(409);
        expect(res.body.code).toBe('GAME_CHALLENGE_EXPIRED');
      });

      it.each([
        ['board와 함께', '/games/tetris/sessions', { board: 'daily', challengeScoreId: 41 }, 422, 'VALIDATION_ERROR'],
        ['정수가 아닌 ID', '/games/tetris/sessions', { challengeScoreId: 'x' }, 422, 'VALIDATION_ERROR'],
        ['도전장 미지원 게임(디펜스)', '/games/defense/sessions', { challengeScoreId: 41 }, 422, 'VALIDATION_ERROR'],
      ])('%s → %i %s', async (_name, path, payload, status, code) => {
        const res = await request(app.getHttpServer()).post(e2e.url(path)).send(payload).expect(status);
        expect(res.body.code).toBe(code);
        expect(redis.store.size).toBe(0);
      });

      it('원본이 없거나 숨김이면 404 GAME_SCORE_NOT_FOUND', async () => {
        gameScoreRepository.findOne.mockResolvedValue(null);

        const res = await request(app.getHttpServer()).post(e2e.url('/games/tetris/sessions')).send({ challengeScoreId: 41 }).expect(404);
        expect(res.body.code).toBe('GAME_SCORE_NOT_FOUND');
      });
    });

    it('모르는 게임은 404 GAME_NOT_FOUND', async () => {
      const res = await request(app.getHttpServer()).post(e2e.url('/games/pacman/sessions')).expect(404);
      expect(res.body.code).toBe('GAME_NOT_FOUND');
    });

    it('Redis를 못 쓰면 503 GAME_SESSION_UNAVAILABLE', async () => {
      redis.status = 'reconnecting';
      const res = await request(app.getHttpServer()).post(e2e.url('/games/tetris/sessions')).expect(503);
      expect(res.body.code).toBe('GAME_SESSION_UNAVAILABLE');
    });
  });

  describe('POST /games/:gameType/scores', () => {
    it('골든 리플레이를 실제 엔진으로 재실행해 그 점수로 201 — 이름은 정규화, 리플레이도 저장', async () => {
      const sessionId = await issueSession(SUCCESS.input.seed);

      const res = await submit(body(sessionId, SUCCESS)).expect(201);

      expect(res.body.data).toEqual({
        scoreId: 41,
        score: SUCCESS.expected.score,
        // 보낸 '  테트리스   왕 '을 DTO가 정리해 저장한 값 — 공유 카드는 이 값을 쓴다(games-polish Q-S2)
        playerName: '테트리스 왕',
        detail: expect.objectContaining({ lines: SUCCESS.expected.lines, level: SUCCESS.expected.level }),
        ranks: { daily: 3, weekly: 3, all: 3 },
      });
      expect(saved[0]).toEqual(expect.objectContaining({ playerName: '테트리스 왕', score: SUCCESS.expected.score, userId: null, boardKey: 'default' }));
      expect(saved[1]).toEqual(expect.objectContaining({ scoreId: 41, gameType: 'TETRIS', seed: SUCCESS.input.seed }));
    });

    it('같은 세션으로 다시 내면 409 GAME_SESSION_INVALID (1회용)', async () => {
      const sessionId = await issueSession(SUCCESS.input.seed);
      await submit(body(sessionId, SUCCESS)).expect(201);

      const res = await submit(body(sessionId, SUCCESS)).expect(409);
      expect(res.body.code).toBe('GAME_SESSION_INVALID');
    });

    it('다른 seed로 발급된 세션에 리플레이를 붙이면 재현이 안 돼 422 GAME_REPLAY_INVALID — 확정 결과라 세션 소모(다시 내면 409)', async () => {
      const sessionId = await issueSession(SUCCESS.input.seed + 1);

      const res = await submit(body(sessionId, SUCCESS)).expect(422);
      expect(res.body.code).toBe('GAME_REPLAY_INVALID');
      expect(saved).toHaveLength(0);
      expect(redis.store.has(`game:session:${sessionId}`)).toBe(false);
      await submit(body(sessionId, SUCCESS)).expect(409);
    });

    it('검증기가 실패하면 503 GAME_VERIFY_BUSY + Retry-After — 세션이 남아 같은 세션으로 다시 내면 201', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const sessionId = await issueSession(SUCCESS.input.seed);
      const tetris = engines.TETRIS;
      engines.TETRIS = { ...tetris, verify: () => Promise.reject(new Error('worker timeout')) };

      const res = await submit(body(sessionId, SUCCESS)).expect(503);
      expect(res.body.code).toBe('GAME_VERIFY_BUSY');
      expect(res.headers['retry-after']).toBe('2');
      expect(redis.store.has(`game:session:${sessionId}`)).toBe(true);

      engines.TETRIS = tetris;
      await submit(body(sessionId, SUCCESS)).expect(201);
    });

    it('게임 오버로 끝나지 않은 리플레이는 422 GAME_REPLAY_INVALID', async () => {
      const sessionId = await issueSession(FAILURE.input.seed);

      const res = await submit(body(sessionId, FAILURE)).expect(422);
      expect(res.body.code).toBe('GAME_REPLAY_INVALID');
    });

    it('세션 발급 직후 긴 판을 내면(빨리 감기) 422 GAME_REPLAY_INVALID — 확정 결과라 세션 소모(기다렸다 다시 낼 수 없다)', async () => {
      const sessionId = await issueSession(SUCCESS.input.seed, 1_000);

      const res = await submit(body(sessionId, SUCCESS)).expect(422);
      expect(res.body.code).toBe('GAME_REPLAY_INVALID');
      expect(redis.store.has(`game:session:${sessionId}`)).toBe(false);
    });

    it('금칙어 이름은 422 GAME_PLAYER_NAME_FORBIDDEN — 세션이 남아 이름만 바꿔 다시 낼 수 있어야 함', async () => {
      const sessionId = await issueSession(SUCCESS.input.seed);

      const res = await submit(body(sessionId, SUCCESS, { playerName: '시1발' })).expect(422);
      expect(res.body.code).toBe('GAME_PLAYER_NAME_FORBIDDEN');
      await submit(body(sessionId, SUCCESS)).expect(201);
    });

    it.each([
      ['허용 외 문자', '<script>'],
      ['13자', '가'.repeat(13)],
      ['공백만', '   '],
    ])('이름 %s → 422 GAME_PLAYER_NAME_INVALID — 세션이 남아 이름만 바꿔 다시 낼 수 있어야 함', async (_name, playerName) => {
      const sessionId = await issueSession(SUCCESS.input.seed);

      const res = await submit(body(sessionId, SUCCESS, { playerName })).expect(422);
      expect(res.body.code).toBe('GAME_PLAYER_NAME_INVALID');
      await submit(body(sessionId, SUCCESS)).expect(201);
    });

    it('100kb를 넘어도 300kb 한도 안이면 본문을 받아야 함 (Express 기본 100kb로 되돌아가면 413으로 실패)', async () => {
      // 약 150KB — 발급하지 않은 세션이라 본문 파싱·검증을 통과한 뒤 409에서 멈춘다
      const payload = {
        sessionId: '3f1c2b9e-0a4d-4f7e-9a1b-2c3d4e5f6a7b',
        playerName: '긴판',
        replay: { engineVersion: 1, das: 10, arr: 2, frames: 216_000, inputs: new Array(75_000).fill(1) },
      };
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(140_000);

      const res = await submit(payload).expect(409);
      expect(res.body.code).toBe('GAME_SESSION_INVALID');
    });

    it('JSON 문법 오류는 400 BAD_REQUEST — Nest가 필터보다 먼저 BadRequestException으로 바꾼다', async () => {
      const res = await request(app.getHttpServer())
        .post(e2e.url('/games/tetris/scores'))
        .set('Content-Type', 'application/json')
        .send('{"sessionId":}')
        .expect(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });

    it('본문이 JSON 한도(300kb)를 넘으면 413 PAYLOAD_TOO_LARGE (500 아님)', async () => {
      const res = await submit({ sessionId: 'x', playerName: 'a', replay: { inputs: new Array(160_000).fill(12) } }).expect(413);
      expect(res.body).toEqual(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE', message: '요청 본문이 너무 큽니다.' }));
    });

    it.each([
      ['점수 필드를 보냄 (클라이언트 점수 불가)', { score: 99999999 }],
      ['replay 안에 정의 외 필드', { replay: { engineVersion: 1, das: 10, arr: 2, frames: 100, inputs: [], score: 1 } }],
      ['UUID가 아닌 세션', { sessionId: 'abc' }],
      ['상한 초과 frames', { replay: { engineVersion: 1, das: 10, arr: 2, frames: 216_001, inputs: [] } }],
      ['das 누락 (테트리스 params 형식)', { replay: { engineVersion: 1, arr: 2, frames: 100, inputs: [] } }],
      ['최상위 das·arr와 params를 섞음', { replay: { engineVersion: 1, das: 10, arr: 2, params: { das: 10, arr: 2 }, frames: 100, inputs: [] } }],
      ['params에 정의 외 키', { replay: { engineVersion: 1, params: { das: 10, arr: 2, x: 1 }, frames: 100, inputs: [] } }],
      ['replay 누락', { replay: undefined }],
      ['replay가 배열', { replay: [] }],
      ['replay가 null', { replay: null }],
    ])('%s → 422 VALIDATION_ERROR — 세션을 소모하지 않아야 함', async (_name, extra) => {
      const sessionId = await issueSession(SUCCESS.input.seed);

      const res = await submit(body(sessionId, SUCCESS, extra)).expect(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(redis.store.has(`game:session:${sessionId}`)).toBe(true);
    });
  });

  describe('GET /games/:gameType/boards', () => {
    it('200 — 테트리스는 default + 오늘·어제 데일리(비밀값이 있을 때), 없으면 default 하나', async () => {
      const res = await request(app.getHttpServer()).get(e2e.url('/games/tetris/boards')).expect(200);
      expect(res.body.data.items.map((b: { boardKey: string; mode: string | null; current: boolean }) => [b.mode, b.current])).toEqual([
        [null, true],
        ['daily', true],
        ['daily', false],
      ]);

      delete env.GAME_WEEKLY_SEED_SECRET;
      const without = await request(app.getHttpServer()).get(e2e.url('/games/tetris/boards')).expect(200);
      expect(without.body.data).toEqual({ items: [{ boardKey: 'default', mode: null, current: true, startsAt: null, endsAt: null }] });
    });

    it('모르는 게임은 404 GAME_NOT_FOUND', async () => {
      const res = await request(app.getHttpServer()).get(e2e.url('/games/pacman/boards')).expect(404);
      expect(res.body.code).toBe('GAME_NOT_FOUND');
    });
  });

  describe('GET /games/:gameType/rankings', () => {
    it('period 생략이면 전체, periodStart null', async () => {
      gameScoreRepository.find.mockResolvedValue([]);

      const res = await request(app.getHttpServer()).get(e2e.url('/games/tetris/rankings')).expect(200);
      expect(res.body.data).toEqual({ boardKey: 'default', items: [], periodStart: null });
    });

    it('board=default는 생략과 같은 보드로 조회해야 함', async () => {
      gameScoreRepository.find.mockResolvedValue([]);

      await request(app.getHttpServer()).get(e2e.url('/games/tetris/rankings?board=default')).expect(200);
      expect(gameScoreRepository.find).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ boardKey: 'default' }) }));
    });

    it.each([['period=monthly'], ['limit=101'], ['limit=0'], ['board=endless-s1'], ['board=BAD_KEY']])('%s → 422', async (query) => {
      await request(app.getHttpServer()).get(e2e.url(`/games/tetris/rankings?${query}`)).expect(422);
    });
  });

  describe('GET /games/:gameType/scores/:scoreId (기록 요약)', () => {
    it('200 — 랭킹 항목 형태 + 전체 순위, 리플레이 입력·민감 필드 없음', async () => {
      gameScoreRepository.findOne.mockResolvedValue({ scoreId: 41, playerName: 'a', score: 900, detail: '{"lines":3}', durationMs: 1000, crtdAt: new Date('2026-10-21T00:00:00.000Z') } as GameScore);

      const res = await request(app.getHttpServer()).get(e2e.url('/games/tetris/scores/41')).expect(200);

      expect(res.body.data).toEqual({ rank: 3, scoreId: 41, playerName: 'a', score: 900, detail: { lines: 3 }, durationMs: 1000, viewCount: 0, watchMs: 0, trophies: null, createdAt: '2026-10-21T00:00:00.000Z' });
    });

    it.each([
      ['없거나 숨긴 기록', '/games/tetris/scores/41', 404, 'GAME_SCORE_NOT_FOUND'],
      ['모르는 게임', '/games/pacman/scores/41', 404, 'GAME_NOT_FOUND'],
      ['숫자가 아닌 ID', '/games/tetris/scores/abc', 400, 'BAD_REQUEST'],
    ])('%s → %i %s', async (_name, path, status, code) => {
      gameScoreRepository.findOne.mockResolvedValue(null);

      const res = await request(app.getHttpServer()).get(e2e.url(path)).expect(status);
      expect(res.body.code).toBe(code);
    });
  });

  describe('GET /games/:gameType/scores/:scoreId/replay', () => {
    it('없거나 숨긴 기록은 404 GAME_SCORE_NOT_FOUND', async () => {
      gameScoreRepository.findOne.mockResolvedValue(null);

      const res = await request(app.getHttpServer()).get(e2e.url('/games/tetris/scores/41/replay')).expect(404);
      expect(res.body.code).toBe('GAME_SCORE_NOT_FOUND');
    });

    it('보드 스킨은 기록 주인의 현재 장착(보드 슬롯만) — 화면 배경은 싣지 않는다, 익명 기록은 default (tetris-skins D-003)', async () => {
      const owned = { scoreId: 41, boardKey: 'default', playerName: 'a', score: 900, detail: '{}', durationMs: 1, crtdAt: new Date('2026-10-21T00:00:00.000Z'), userId: 7 } as GameScore;
      gameReplayRepository.findOneBy.mockResolvedValue({
        scoreId: 41,
        gameType: 'TETRIS',
        engineVersion: 1,
        seed: 5,
        replay: gzipSync(JSON.stringify({ das: 10, arr: 2, frames: 30, inputs: [] })),
        crtdAt: new Date(),
      } as GameReplay);
      skinEquipRepository.find.mockResolvedValue([
        { userId: 7, slot: 'TETRIS_BLOCK', skinId: 'gameboy' },
        { userId: 7, slot: 'TETRIS_BACKGROUND', skinId: 'neon' },
      ] as UserSkinEquip[]);

      gameScoreRepository.findOne.mockResolvedValue(owned);
      const res = await request(app.getHttpServer()).get(e2e.url('/games/tetris/scores/41/replay')).expect(200);
      expect(res.body.data.skins).toEqual({ block: 'gameboy', effect: 'default', board: 'default' });
      expect(res.body.data).not.toHaveProperty('userId');

      gameScoreRepository.findOne.mockResolvedValue({ ...owned, userId: null });
      const anonymous = await request(app.getHttpServer()).get(e2e.url('/games/tetris/scores/41/replay')).expect(200);
      expect(anonymous.body.data.skins).toEqual({ block: 'default', effect: 'default', board: 'default' });
    });
  });

  describe('GET /games/:gameType/skins (tetris-skins D-005)', () => {
    it('게스트도 200 — 슬롯별 전체 아이템·획득 방식, 보유·장착은 false', async () => {
      const res = await request(app.getHttpServer()).get(e2e.url('/games/tetris/skins')).expect(200);
      expect(res.body.code).toBe('SUCCESS');
      expect(res.body.data.signedIn).toBe(false);
      expect(res.body.data.slots.map((s: { slot: string }) => s.slot)).toEqual(['block', 'effect', 'board', 'background']);
      expect(res.body.data.slots[0].items[0]).toEqual({ id: 'default', unlock: 'default', owned: false, equipped: false });
      expect(skinEquipRepository.find).not.toHaveBeenCalled();
    });

    it('로그인 토큰이 있으면 보유·장착 표시 — 장착한 아이템만 equipped', async () => {
      env.JWT_SECRET = 'e2e-jwt';
      app.get<MockRepository<User>>(getRepositoryToken(User)).findOne.mockResolvedValue(createUser({ userId: 7 }));
      skinEquipRepository.find.mockResolvedValue([{ userId: 7, slot: 'TETRIS_EFFECT', skinId: 'neon' }] as UserSkinEquip[]);

      const res = await request(app.getHttpServer())
        .get(e2e.url('/games/tetris/skins'))
        .set('Authorization', `Bearer ${sign({ sub: 7 }, 'e2e-jwt')}`)
        .expect(200);

      expect(res.body.data.signedIn).toBe(true);
      const effect = res.body.data.slots.find((s: { slot: string }) => s.slot === 'effect');
      expect(effect.items.filter((item: { equipped: boolean }) => item.equipped).map((item: { id: string }) => item.id)).toEqual(['neon']);
      expect(effect.items.every((item: { owned: boolean }) => item.owned)).toBe(true);
    });

    it('스킨이 없는 게임은 빈 목록, 모르는 게임은 404', async () => {
      const defense = await request(app.getHttpServer()).get(e2e.url('/games/defense/skins')).expect(200);
      expect(defense.body.data).toEqual({ signedIn: false, slots: [] });
      const unknown = await request(app.getHttpServer()).get(e2e.url('/games/pacman/skins')).expect(404);
      expect(unknown.body.code).toBe('GAME_NOT_FOUND');
    });
  });

  describe('리플레이 조회수·시청시간·인기 목록 (replay-views)', () => {
    const visible = { scoreId: 41, boardKey: 'default', playerName: 'a', score: 900, detail: '{}', durationMs: 100_000, crtdAt: new Date('2026-10-21T00:00:00.000Z') } as GameScore;

    it('POST .../views — 본문 없이 200 + 누적 조회수 (201 아님)', async () => {
      gameScoreRepository.findOne.mockResolvedValue(visible);
      viewStatRepository.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getRawMany: [{ scoreId: '41', viewCount: '4', watchMs: '0' }] }) as never);

      const res = await request(app.getHttpServer()).post(e2e.url('/games/tetris/scores/41/views')).expect(200);

      expect(res.body).toEqual({ code: 'SUCCESS', data: { scoreId: 41, viewCount: 4, counted: true }, message: '' });
      expect(viewStatRepository.increment).toHaveBeenCalledWith(expect.objectContaining({ scoreId: 41 }), 'viewCount', 1);
    });

    it.each([
      ['없거나 숨긴 기록', '/games/tetris/scores/41/views', 404, 'GAME_SCORE_NOT_FOUND'],
      ['모르는 게임', '/games/pacman/scores/41/views', 404, 'GAME_NOT_FOUND'],
      ['숫자가 아닌 ID', '/games/tetris/scores/abc/views', 400, 'BAD_REQUEST'],
    ])('POST .../views: %s → %i %s', async (_name, path, status, code) => {
      gameScoreRepository.findOne.mockResolvedValue(null);

      const res = await request(app.getHttpServer()).post(e2e.url(path)).expect(status);
      expect(res.body.code).toBe(code);
    });

    it('POST .../watch?ms= — 본문 없는 요청(이탈 flush)으로 200 + 반영 몫', async () => {
      gameScoreRepository.findOne.mockResolvedValue(visible);

      const res = await request(app.getHttpServer()).post(e2e.url('/games/tetris/scores/41/watch?ms=30000')).expect(200);

      expect(res.body.data).toEqual({ scoreId: 41, watchMs: 0, countedMs: 30000 });
      expect(viewStatRepository.increment).toHaveBeenCalledWith(expect.objectContaining({ scoreId: 41 }), 'watchMs', 30000);
    });

    it.each([['ms 누락', ''], ['ms=0', '?ms=0'], ['ms 상한 초과', '?ms=120001'], ['소수', '?ms=1.5'], ['정의 외 쿼리', '?ms=10&x=1']])(
      'POST .../watch: %s → 422 VALIDATION_ERROR',
      async (_name, query) => {
        const res = await request(app.getHttpServer()).post(e2e.url(`/games/tetris/scores/41/watch${query}`)).expect(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(viewStatRepository.increment).not.toHaveBeenCalled();
      },
    );

    it('GET .../rankings?board= — 데일리(오늘)·도전장 보드도 랭킹 보드다', async () => {
      gameScoreRepository.find.mockResolvedValue([]);
      const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

      await request(app.getHttpServer()).get(e2e.url(`/games/tetris/rankings?board=daily-${today}`)).expect(200);
      await request(app.getHttpServer()).get(e2e.url('/games/tetris/rankings?board=challenge-41')).expect(200);
      await request(app.getHttpServer()).get(e2e.url('/games/tetris/rankings?board=daily-2999-01-01')).expect(422);
    });

    it('GET .../hall-of-fame — 기간별 시상대, 사용자 ID는 싣지 않는다', async () => {
      gameScoreRepository.find.mockResolvedValue([
        { scoreId: 41, boardKey: 'default', playerName: 'a', score: 900, detail: '{}', durationMs: 1, crtdAt: new Date('2026-10-12T00:00:00.000Z'), userId: 7 },
      ] as GameScore[]);

      const res = await request(app.getHttpServer()).get(e2e.url('/games/tetris/hall-of-fame')).expect(200);

      expect(res.body.data.periods.length).toBeGreaterThan(0);
      expect(res.body.data.periods[0]).toEqual(expect.objectContaining({ kind: 'weekly', boardKey: 'default' }));
      expect(res.body.data.periods[0].podium[0]).toEqual(
        expect.objectContaining({ rank: 1, scoreId: 41, trophies: expect.objectContaining({ gold: expect.any(Number) }) }),
      );
      expect(res.body.data.periods[0].podium[0]).not.toHaveProperty('userId');
    });

    it('GET .../popular-replays — 기본 주간·조회수순 빈 목록', async () => {
      const res = await request(app.getHttpServer()).get(e2e.url('/games/tetris/popular-replays')).expect(200);

      expect(res.body.data).toEqual(expect.objectContaining({ boardKey: 'default', period: 'weekly', sort: 'views', items: [] }));
    });

    it.each([['sort=likes'], ['period=monthly'], ['limit=0'], ['limit=101'], ['board=endless-s1']])('GET .../popular-replays?%s → 422', async (query) => {
      await request(app.getHttpServer()).get(e2e.url(`/games/tetris/popular-replays?${query}`)).expect(422);
    });
  });

  /**
   * 디펜스 — 실제 레지스트리 항목(보드·세션·형식 규칙)을 태운다.
   * 엔진 사본은 아직 캠페인만 재현하므로(무한·주간 데이터는 S1) 성공 경로는 검증기를 대역으로 바꿔 본다.
   */
  describe('DEFENSE', () => {
    const defenseVerified = {
      ok: true as const,
      score: 12_345_000,
      detail: { wave: 12, progress: 345, kills: 300, livesLeft: 4, goldEarned: 5000, engineVersion: DEFENSE_ENGINE_VERSION },
    };
    const issueDefenseSession = async (board?: string) => {
      const res = await request(app.getHttpServer())
        .post(e2e.url('/games/defense/sessions'))
        .send(board === undefined ? {} : { board })
        .expect(201);
      const key = `game:session:${res.body.data.sessionId}`;
      // 시간 검사를 넘기도록 1시간 전 발급으로 맞춘다
      redis.store.set(
        key,
        JSON.stringify({ ...JSON.parse(redis.store.get(key)!), startedAt: Date.now() - 3_600_000 }),
      );
      return res.body.data as { sessionId: string; seed: number; boardKey: string; mode: string };
    };
    const defenseBody = (sessionId: string, replay: Record<string, unknown> = {}) => ({
      sessionId,
      playerName: '수비왕',
      // 엔진 버전은 사본 값을 따른다 — 하드코딩하면 엔진 동기화 때 세션 버전과 어긋나 409로 깨진다
      replay: { engineVersion: DEFENSE_ENGINE_VERSION, frames: 9000, inputs: [0, 0], ...replay },
    });
    const submitDefense = (payload: object) =>
      request(app.getHttpServer()).post(e2e.url('/games/defense/scores')).send(payload);

    it('세션: 본문 없음·endless → 무한 보드, 무작위 seed, 4시간 TTL', async () => {
      const res = await request(app.getHttpServer()).post(e2e.url('/games/defense/sessions')).expect(201);

      expect(res.body.data).toEqual(
        expect.objectContaining({ boardKey: 'endless-s1', mode: 'endless', seed: expect.any(Number) }),
      );
      const ttlMs = new Date(res.body.data.expiresAt as string).getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(4 * 3600_000 - 60_000);
      expect(ttlMs).toBeLessThanOrEqual(4 * 3600_000);
    });

    it('세션: weekly → 이번 주 보드, 누구에게나 같은 seed(주간 HMAC)', async () => {
      const a = await issueDefenseSession('weekly');
      const b = await issueDefenseSession('weekly');

      expect(a.boardKey).toMatch(/^weekly-\d{4}-w\d{2}$/);
      expect(a.mode).toBe('weekly');
      expect(a.seed).toBe(weeklySeed('e2e-weekly', a.boardKey));
      expect(b.seed).toBe(a.seed);
    });

    it('세션: 주간 비밀값이 없으면 weekly만 503 GAME_WEEKLY_UNAVAILABLE — 세션을 만들지 않는다', async () => {
      env.GAME_WEEKLY_SEED_SECRET = undefined;

      const res = await request(app.getHttpServer())
        .post(e2e.url('/games/defense/sessions'))
        .send({ board: 'weekly' })
        .expect(503);
      expect(res.body.code).toBe('GAME_WEEKLY_UNAVAILABLE');
      expect(redis.store.size).toBe(0);
      await request(app.getHttpServer())
        .post(e2e.url('/games/defense/sessions'))
        .send({ board: 'endless' })
        .expect(201);
    });

    it('세션: 모르는 방식은 422 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .post(e2e.url('/games/defense/sessions'))
        .send({ board: 'campaign' })
        .expect(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('제출: 검증 성공이면 201 — 세션 보드로 저장, DURATION_MS는 30틱/초, 리플레이에 das·arr 없음', async () => {
      engines.DEFENSE = { ...engines.DEFENSE, verify: () => Promise.resolve(defenseVerified) };
      const session = await issueDefenseSession('weekly');

      const res = await submitDefense(defenseBody(session.sessionId)).expect(201);

      expect(res.body.data).toEqual(
        expect.objectContaining({ score: 12_345_000, detail: defenseVerified.detail }),
      );
      const score = saved.find(row => 'score' in row)!;
      expect(score).toEqual(
        expect.objectContaining({ gameType: 'DEFENSE', boardKey: session.boardKey, durationMs: 300_000 }),
      );
      const replay = saved.find(row => 'replay' in row)!;
      expect(replay).toEqual(expect.objectContaining({ gameType: 'DEFENSE', seed: session.seed }));
    });

    it.each([
      ['테트리스 설정(das·arr)', { das: 10, arr: 2 }],
      ['params에 키가 있음', { params: { speed: 3 } }],
      ['판 상한 초과', { frames: 162_001 }],
    ])('제출: %s → 422 VALIDATION_ERROR, 세션 미소모', async (_name, replay) => {
      const session = await issueDefenseSession();

      const res = await submitDefense(defenseBody(session.sessionId, replay)).expect(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(redis.store.has(`game:session:${session.sessionId}`)).toBe(true);
    });

    it('제출: 실제 엔진 재현 실패(무한 데이터는 S1 전이라 INVALID_HEADER)는 422 GAME_REPLAY_INVALID — 확정 결과라 세션 소모', async () => {
      const session = await issueDefenseSession();

      const res = await submitDefense(defenseBody(session.sessionId)).expect(422);
      expect(res.body.code).toBe('GAME_REPLAY_INVALID');
      expect(redis.store.has(`game:session:${session.sessionId}`)).toBe(false);
      expect(saved).toHaveLength(0);
    });

    it('보드 목록: 무한 시즌 + 이번 주·지난 주', async () => {
      const res = await request(app.getHttpServer()).get(e2e.url('/games/defense/boards')).expect(200);

      expect(
        res.body.data.items.map((b: { boardKey: string; current: boolean }) => [
          b.boardKey.replace(/\d{4}-w\d{2}$/, 'W'),
          b.current,
        ]),
      ).toEqual([
        ['endless-s1', true],
        ['weekly-W', true],
        ['weekly-W', false],
      ]);
    });

    it('랭킹: 기본 보드는 현재 무한 시즌, 주간 보드는 period를 무시한다', async () => {
      gameScoreRepository.find.mockResolvedValue([]);
      const { items } = (await request(app.getHttpServer()).get(e2e.url('/games/defense/boards')).expect(200))
        .body.data as { items: { boardKey: string }[] };

      const endless = await request(app.getHttpServer())
        .get(e2e.url('/games/defense/rankings?period=daily'))
        .expect(200);
      expect(endless.body.data.boardKey).toBe('endless-s1');
      expect(endless.body.data.periodStart).not.toBeNull();

      const weekly = await request(app.getHttpServer())
        .get(e2e.url(`/games/defense/rankings?board=${items[1].boardKey}&period=daily`))
        .expect(200);
      expect(weekly.body.data).toEqual({ boardKey: items[1].boardKey, items: [], periodStart: null });
      expect(gameScoreRepository.find).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { gameType: 'DEFENSE', boardKey: items[1].boardKey, isHidden: 0 } }),
      );
    });

    it('리플레이: 진행 중인 주간 보드 기록은 404, 지난 주·무한 보드는 공개', async () => {
      const { items } = (await request(app.getHttpServer()).get(e2e.url('/games/defense/boards')).expect(200))
        .body.data as { items: { boardKey: string }[] };
      const row = (boardKey: string) =>
        ({
          scoreId: 41,
          boardKey,
          playerName: 'a',
          score: 900,
          detail: '{}',
          durationMs: 1,
          crtdAt: new Date(),
        }) as GameScore;
      gameReplayRepository.findOneBy.mockResolvedValue({
        scoreId: 41,
        gameType: 'DEFENSE',
        engineVersion: 1,
        seed: 5,
        replay: gzipSync(JSON.stringify({ frames: 30, inputs: [] })),
        crtdAt: new Date(),
      } as GameReplay);

      gameScoreRepository.findOne.mockResolvedValue(row(items[1].boardKey));
      const current = await request(app.getHttpServer())
        .get(e2e.url('/games/defense/scores/41/replay'))
        .expect(404);
      expect(current.body.code).toBe('GAME_SCORE_NOT_FOUND');
      // 조회·시청 기록도 같은 공개 규칙 — 진행 중인 주간 보드는 집계하지 않는다 (replay-views)
      await request(app.getHttpServer()).post(e2e.url('/games/defense/scores/41/views')).expect(404);
      await request(app.getHttpServer()).post(e2e.url('/games/defense/scores/41/watch?ms=1000')).expect(404);
      expect(viewStatRepository.increment).not.toHaveBeenCalled();
      // 공개 전 404는 캐시하지 않는다 — 공개 시점이 지나면 바로 보여야 한다 (games-polish BD-06)
      expect(current.headers['cache-control']).toBeUndefined();

      for (const boardKey of [items[2].boardKey, 'endless-s1']) {
        gameScoreRepository.findOne.mockResolvedValue(row(boardKey));
        const res = await request(app.getHttpServer())
          .get(e2e.url('/games/defense/scores/41/replay'))
          .expect(200);
        expect(res.body.data).toEqual(expect.objectContaining({ boardKey, seed: 5, params: {}, frames: 30 }));
        expect(res.body.data).not.toHaveProperty('das');
        expect(res.headers['cache-control']).toBe('public, max-age=60');
      }
    });

    it.each([['board=default'], ['board=endless-s2'], ['board=weekly-2999-w01']])(
      '랭킹: %s → 422',
      async query => {
        await request(app.getHttpServer())
          .get(e2e.url(`/games/defense/rankings?${query}`))
          .expect(422);
      },
    );
  });
});

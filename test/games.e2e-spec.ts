import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GamesController } from '../src/modules/games/games.controller';
import { GamesService } from '../src/modules/games/games.service';
import { GameSessionService } from '../src/modules/games/game-session.service';
import { GAME_ENGINE_REGISTRY, GameEngine } from '../src/modules/games/game-engine.registry';
import { tetrisGameEngine } from '../src/modules/games/tetris-game-engine';
import golden from '../src/modules/games/tetris-engine/__fixtures__/golden-replays.json';
import { GameScore } from '../src/entities/GameScore';
import { GameReplay } from '../src/entities/GameReplay';
import { User } from '../src/entities/User';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

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
  let saved: Record<string, unknown>[];
  /** 레지스트리 — 테스트가 검증기를 바꿔 끼울 수 있게 매번 새 객체 */
  let engines: Record<string, GameEngine>;

  beforeEach(async () => {
    redis = new FakeRedis();
    gameScoreRepository = createMockRepository<GameScore>();
    gameReplayRepository = createMockRepository<GameReplay>();
    saved = [];
    engines = { TETRIS: tetrisGameEngine };
    const manager = {
      create: (_entity: unknown, data: Record<string, unknown>) => data,
      save: (data: Record<string, unknown>) => {
        const row = 'playerName' in data ? { ...data, scoreId: 41 } : data;
        saved.push(row);
        return Promise.resolve(row);
      },
    };

    e2e = await createE2eApp({
      controllers: [GamesController],
      providers: [
        GamesService,
        GameSessionService,
        { provide: GAME_ENGINE_REGISTRY, useValue: engines },
        { provide: getRepositoryToken(GameScore), useValue: gameScoreRepository },
        { provide: getRepositoryToken(GameReplay), useValue: gameReplayRepository },
        // OptionalJwtAuthGuard(JwtAuthGuard 상속)의 의존 — 토큰이 없으면 쓰지 않는다
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: ConfigService, useValue: { get: (key: string) => ({ GAME_IP_HASH_SECRET: 'e2e-secret' })[key] } },
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
        expect.objectContaining({ engineVersion: 1, seed: expect.any(Number), expiresAt: expect.any(String), boardKey: 'default', mode: null }),
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
      engines.TETRIS = { ...tetrisGameEngine, verify: () => Promise.reject(new Error('worker timeout')) };

      const res = await submit(body(sessionId, SUCCESS)).expect(503);
      expect(res.body.code).toBe('GAME_VERIFY_BUSY');
      expect(res.headers['retry-after']).toBe('2');
      expect(redis.store.has(`game:session:${sessionId}`)).toBe(true);

      engines.TETRIS = tetrisGameEngine;
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
    it('200 — 테트리스는 default 보드 하나', async () => {
      const res = await request(app.getHttpServer()).get(e2e.url('/games/tetris/boards')).expect(200);
      expect(res.body.data).toEqual({ items: [{ boardKey: 'default', mode: null, current: true, startsAt: null, endsAt: null }] });
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

      expect(res.body.data).toEqual({ rank: 3, scoreId: 41, playerName: 'a', score: 900, detail: { lines: 3 }, durationMs: 1000, createdAt: '2026-10-21T00:00:00.000Z' });
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
  });
});

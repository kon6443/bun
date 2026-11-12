import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { gzipSync } from 'node:zlib';
import { DataSource } from 'typeorm';
import { FortressMatch } from '../src/entities/FortressMatch';
import { FortressPlayer } from '../src/entities/FortressPlayer';
import { FortressReplay } from '../src/entities/FortressReplay';
import { User } from '../src/entities/User';
import { createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { FortressMatchService } from '../src/modules/fortress/fortress-match.service';
import { FortressResultController } from '../src/modules/fortress/fortress-result.controller';
import { FortressResultService } from '../src/modules/fortress/fortress-result.service';
import { FortressPointsService } from '../src/modules/fortress/fortress-points.service';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

const MATCH = 'AbCdEfGhIjKlMnOp';
const T0 = Date.UTC(2026, 9, 31, 1, 2, 3);
const CONFIG = { seed: 7, mapId: 'hills', mode: 'ffa', players: [{ slot: 0, team: 0, tankId: 0 }, { slot: 1, team: 0, tankId: 1 }] };

/**
 * 포트리스 결과·리플레이 REST를 HTTP 경계에서 검증한다 (DESIGN §12).
 * 실제 컨트롤러·서비스를 태우고 Repository·DataSource·경기 서비스(Redis)만 대역으로 바꾼다 — Redis가 없는 상태(lazy 저장 불가)다.
 * 여기서 보는 것: 상태코드(200/404/422) · 전역 ValidationPipe(암묵 변환·forbidNonWhitelisted) · 응답 `{ code, data, message }` · 시각 UTC ISO.
 * 라우트 스로틀은 E2E가 CustomThrottlerGuard를 조립하지 않아 보지 않는다(테트리스 대전 결과 E2E와 같음).
 */
describe('E2E 포트리스 결과', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let matchRepository: MockRepository<FortressMatch>;
  let playerRepository: MockRepository<FortressPlayer>;
  let replayRepository: MockRepository<FortressReplay>;
  const get = (path: string) => request(app.getHttpServer()).get(e2e.url(path));

  const row: FortressMatch = {
    matchId: MATCH,
    roomName: '한판',
    mode: 'ffa',
    mapId: 'hills',
    seed: 7,
    engineVersion: 1,
    playerCount: 2,
    turns: 9,
    resultKind: 'win',
    winnerTeam: null,
    startedAt: new Date(T0),
    endedAt: new Date(T0 + 60_000),
    isHidden: 0,
    crtdAt: new Date(T0 + 61_000),
  };

  beforeEach(async () => {
    matchRepository = createMockRepository<FortressMatch>();
    playerRepository = createMockRepository<FortressPlayer>();
    replayRepository = createMockRepository<FortressReplay>();
    e2e = await createE2eApp({
      controllers: [FortressResultController],
      providers: [
        FortressResultService,
        { provide: FortressMatchService, useValue: { setSaveHook: () => undefined, readyRedisClient: () => null } },
        { provide: getRepositoryToken(FortressMatch), useValue: matchRepository },
        { provide: getRepositoryToken(FortressPlayer), useValue: playerRepository },
        { provide: getRepositoryToken(FortressReplay), useValue: replayRepository },
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } as unknown as DataSource },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: FortressPointsService, useValue: { awardInTransaction: jest.fn(), pointsOf: jest.fn() } },
      ],
    });
    app = e2e.app;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /fortress/matches/:matchId', () => {
    it('200 — 참가자·결과, 시각은 UTC ISO, userId 없음', async () => {
      matchRepository.findOne.mockResolvedValue(row);
      playerRepository.find.mockResolvedValue([
        { matchId: MATCH, playerId: 'p1', slot: 0, name: '포병', userId: 3, team: null, tankId: 0, hp: 40, damage: 100, kos: 1, place: 1 },
      ]);
      const res = await get(`/fortress/matches/${MATCH}`).expect(200);
      expect(res.body).toEqual({
        code: 'SUCCESS',
        message: '',
        data: {
          matchId: MATCH,
          roomName: '한판',
          mode: 'ffa',
          mapId: 'hills',
          seed: 7,
          engineVersion: 1,
          playerCount: 2,
          turns: 9,
          result: { kind: 'win', team: null },
          startedAt: '2026-10-31T01:02:03.000Z',
          endedAt: '2026-10-31T01:03:03.000Z',
          players: [{ playerId: 'p1', name: '포병', slot: 0, team: null, tankId: 0, hp: 40, damage: 100, kos: 1, place: 1 }],
        },
      });
    });

    it('없음 → 404 FORTRESS_MATCH_NOT_FOUND · 형식 오류 id도 404', async () => {
      matchRepository.findOne.mockResolvedValue(null);
      expect((await get(`/fortress/matches/${MATCH}`).expect(404)).body).toMatchObject({ code: 'FORTRESS_MATCH_NOT_FOUND' });
      expect((await get('/fortress/matches/bad').expect(404)).body).toMatchObject({ code: 'FORTRESS_MATCH_NOT_FOUND' });
    });
  });

  describe('GET /fortress/matches/:matchId/points (F7)', () => {
    it('로그인 없으면 401 — 결과·리플레이와 달리 인증 필요', async () => {
      matchRepository.findOne.mockResolvedValue(row);
      expect((await get(`/fortress/matches/${MATCH}/points`).expect(401)).body).toMatchObject({ code: 'AUTH_UNAUTHORIZED' });
      expect(matchRepository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('GET /fortress/matches/:matchId/replay', () => {
    it('200 — config·actions·slots(+ F7 탱크 스킨)·stateHash', async () => {
      const slots = [{ slot: 0, playerId: 'p1', name: '포병', skin: { id: 'desert', level: 3 } }];
      const body = { config: CONFIG, actions: [{ kind: 'skip' }], slots, stateHash: '0badf00d' };
      matchRepository.findOne.mockResolvedValue(row);
      replayRepository.findOne.mockResolvedValue({ matchId: MATCH, engineVersion: 1, replay: gzipSync(JSON.stringify(body)), crtdAt: new Date(T0) });
      const res = await get(`/fortress/matches/${MATCH}/replay`).expect(200);
      expect(res.body).toEqual({ code: 'SUCCESS', message: '', data: { matchId: MATCH, engineVersion: 1, ...body } });
    });

    it('리플레이 행 없음 → 404 FORTRESS_REPLAY_NOT_FOUND', async () => {
      matchRepository.findOne.mockResolvedValue(row);
      replayRepository.findOne.mockResolvedValue(null);
      expect((await get(`/fortress/matches/${MATCH}/replay`).expect(404)).body).toMatchObject({ code: 'FORTRESS_REPLAY_NOT_FOUND' });
    });
  });

  describe('GET /fortress/matches', () => {
    it('200 — 쿼리 limit 암묵 변환(문자열 → 숫자), 마지막 페이지 nextCursor null', async () => {
      matchRepository.find.mockResolvedValue([row]);
      playerRepository.find.mockResolvedValue([]);
      const res = await get('/fortress/matches?limit=5').expect(200);
      expect(matchRepository.find).toHaveBeenCalledWith(expect.objectContaining({ take: 6 }));
      expect(res.body.data).toEqual({
        items: [
          {
            matchId: MATCH,
            roomName: '한판',
            mode: 'ffa',
            mapId: 'hills',
            playerCount: 2,
            turns: 9,
            result: { kind: 'win', team: null },
            endedAt: '2026-10-31T01:03:03.000Z',
            players: [],
          },
        ],
        nextCursor: null,
      });
    });

    it.each([
      ['limit 0', '/fortress/matches?limit=0'],
      ['limit 21', '/fortress/matches?limit=21'],
      ['limit 숫자 아님', '/fortress/matches?limit=abc'],
      ['모르는 쿼리', '/fortress/matches?foo=1'],
      ['잘못된 cursor', '/fortress/matches?cursor=nope'],
    ])('%s → 422 VALIDATION_ERROR', async (_label, path) => {
      matchRepository.find.mockResolvedValue([]);
      expect((await get(path).expect(422)).body).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });
});

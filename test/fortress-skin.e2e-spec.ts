import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createUser } from '../src/entities/__spec__/entity.factory';
import { FortressMatch } from '../src/entities/FortressMatch';
import { FortressPlayer } from '../src/entities/FortressPlayer';
import { FortressReplay } from '../src/entities/FortressReplay';
import { User } from '../src/entities/User';
import { FortressMatchService } from '../src/modules/fortress/fortress-match.service';
import { FortressPointsService } from '../src/modules/fortress/fortress-points.service';
import { FortressResultController } from '../src/modules/fortress/fortress-result.controller';
import { FortressResultService } from '../src/modules/fortress/fortress-result.service';
import { FortressSkinController } from '../src/modules/fortress/fortress-skin.controller';
import { FortressSkinService } from '../src/modules/fortress/fortress-skin.service';
import { UserPointService } from '../src/modules/users/user-point.service';
import { UserSkinService } from '../src/modules/users/user-skin.service';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

const MATCH = 'AbCdEfGhIjKlMnOp';
const ME = createUser({ userId: 7 });
const POINTS = { earned: 120_000, spent: 0, balance: 120_000 };

/**
 * 포트리스 탱크 스킨·경기 포인트 REST (DESIGN §13) — 실제 컨트롤러·FortressSkinService·결과 서비스를 태우고
 * UserSkinService·UserPointService·Repository만 대역. 인증(401)·전역 ValidationPipe(422)·도메인 에러 status·code·응답 모양을 본다
 */
describe('E2E 포트리스 탱크 스킨·경기 포인트', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let userSkin: { slotItemsOf: jest.Mock; equipItem: jest.Mock; upgradeItem: jest.Mock };
  let points: { pointsOf: jest.Mock };
  let matchRepository: MockRepository<FortressMatch>;

  const boot = async (authUser?: User) => {
    userSkin = {
      slotItemsOf: jest.fn().mockResolvedValue(new Map([[7, { equipped: 'desert', levels: new Map([['desert', 2]]) }]])),
      equipItem: jest.fn().mockResolvedValue(undefined),
      upgradeItem: jest.fn().mockResolvedValue(undefined),
    };
    points = { pointsOf: jest.fn() };
    matchRepository = createMockRepository<FortressMatch>();
    e2e = await createE2eApp({
      controllers: [FortressSkinController, FortressResultController],
      providers: [
        FortressSkinService,
        FortressResultService,
        { provide: UserSkinService, useValue: userSkin },
        { provide: UserPointService, useValue: { pointsOf: jest.fn().mockResolvedValue(POINTS) } },
        { provide: FortressPointsService, useValue: points },
        { provide: FortressMatchService, useValue: { setSaveHook: () => undefined, readyRedisClient: () => null } },
        { provide: getRepositoryToken(FortressMatch), useValue: matchRepository },
        { provide: getRepositoryToken(FortressPlayer), useValue: createMockRepository<FortressPlayer>() },
        { provide: getRepositoryToken(FortressReplay), useValue: createMockRepository<FortressReplay>() },
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } as unknown as DataSource },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
      authUser,
    });
    app = e2e.app;
  };
  const http = () => request(app.getHttpServer());

  afterEach(async () => {
    await app.close();
  });

  describe('비로그인', () => {
    beforeEach(() => boot());

    it('스킨 조회·장착·강화·경기 포인트 모두 401 AUTH_UNAUTHORIZED — 서비스까지 가지 않는다', async () => {
      for (const res of [
        await http().get(e2e.url('/fortress/skins/me')),
        await http().put(e2e.url('/fortress/skins/me')).send({ skinId: 'desert' }),
        await http().post(e2e.url('/fortress/skins/me/upgrade')).send({ skinId: 'desert', level: 2 }),
        await http().get(e2e.url(`/fortress/matches/${MATCH}/points`)),
      ]) {
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: 'AUTH_UNAUTHORIZED' });
      }
      expect(userSkin.slotItemsOf).not.toHaveBeenCalled();
      expect(userSkin.equipItem).not.toHaveBeenCalled();
      expect(points.pointsOf).not.toHaveBeenCalled();
    });
  });

  describe('로그인', () => {
    beforeEach(() => boot(ME));

    it('GET /fortress/skins/me 200 — 장착 { id, level }·포인트·아이템', async () => {
      const res = await http().get(e2e.url('/fortress/skins/me')).expect(200);
      expect(res.body).toMatchObject({ code: 'SUCCESS', message: '', data: { equipped: { id: 'desert', level: 2 }, points: POINTS, maxLevel: 5 } });
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual(['default', 'desert', 'arctic', 'neon']);
      expect(userSkin.slotItemsOf).toHaveBeenCalledWith([7], 'FORTRESS_TANK');
    });

    it('PUT /fortress/skins/me 200 — 내 userId·FORTRESS_TANK로 저장', async () => {
      await http().put(e2e.url('/fortress/skins/me')).send({ skinId: 'arctic' }).expect(200);
      expect(userSkin.equipItem).toHaveBeenCalledWith(7, 'FORTRESS_TANK', 'arctic');
    });

    it('PUT: 카탈로그에 없는 아이템 422 USER_SKIN_UNKNOWN · 본문 검증 실패 422 VALIDATION_ERROR(없는 필드·빈 id)', async () => {
      expect((await http().put(e2e.url('/fortress/skins/me')).send({ skinId: 'gameboy' }).expect(422)).body).toMatchObject({
        code: 'USER_SKIN_UNKNOWN',
        details: { slot: 'tank', id: 'gameboy' },
      });
      expect((await http().put(e2e.url('/fortress/skins/me')).send({ skinId: 'desert', level: 3 }).expect(422)).body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect((await http().put(e2e.url('/fortress/skins/me')).send({ skinId: '' }).expect(422)).body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(userSkin.equipItem).not.toHaveBeenCalled();
    });

    it('POST /fortress/skins/me/upgrade 200 · level 범위(2~5) 밖이면 422 VALIDATION_ERROR', async () => {
      await http().post(e2e.url('/fortress/skins/me/upgrade')).send({ skinId: 'desert', level: 3 }).expect(200);
      expect(userSkin.upgradeItem).toHaveBeenCalledWith(7, 'FORTRESS_TANK', 'desert', 3, '포트리스 탱크 desert Lv3 강화', 'tank');
      expect((await http().post(e2e.url('/fortress/skins/me/upgrade')).send({ skinId: 'desert', level: 1 }).expect(422)).body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect((await http().post(e2e.url('/fortress/skins/me/upgrade')).send({ skinId: 'desert', level: 6 }).expect(422)).body).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('GET /fortress/matches/:id/points 200 — 요청자 userId로 · 없는 경기 404 FORTRESS_MATCH_NOT_FOUND', async () => {
      matchRepository.findOne.mockResolvedValue({ matchId: MATCH } as FortressMatch);
      points.pointsOf.mockResolvedValue({ matchId: MATCH, participant: true, earned: 50_000, memo: 'm' });
      const res = await http().get(e2e.url(`/fortress/matches/${MATCH}/points`)).expect(200);
      expect(res.body).toEqual({ code: 'SUCCESS', message: '', data: { matchId: MATCH, participant: true, earned: 50_000, memo: 'm' } });
      expect(points.pointsOf).toHaveBeenCalledWith(MATCH, 7);
      matchRepository.findOne.mockResolvedValue(null);
      expect((await http().get(e2e.url(`/fortress/matches/${MATCH}/points`)).expect(404)).body).toMatchObject({ code: 'FORTRESS_MATCH_NOT_FOUND' });
    });
  });
});

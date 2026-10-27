import request from 'supertest';
import { MoreThan } from 'typeorm';
import { INestApplication } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { UsersController } from '../src/modules/users/users.controller';
import { UsersService } from '../src/modules/users/users.service';
import { UserSkinService } from '../src/modules/users/user-skin.service';
import { UserPointService } from '../src/modules/users/user-point.service';
import { User } from '../src/entities/User';
import { UserSkinEquip } from '../src/entities/UserSkinEquip';
import { UserSkinLevel } from '../src/entities/UserSkinLevel';
import { UserPointLedger } from '../src/entities/UserPointLedger';
import { createUser } from '../src/entities/__spec__/entity.factory';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

/** 스킨 장착·강화 API (docs/tasks/tetris-skins D-003 · skin-levels D-002) — 로그인 전용, 슬롯 부분 수정, 카탈로그·형식 검증, 포인트 강화 */
describe('E2E 사용자 스킨 /users/me/skins', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let skinEquipRepository: MockRepository<UserSkinEquip>;
  let skinLevelRepository: MockRepository<UserSkinLevel>;
  let ledgerRepository: MockRepository<UserPointLedger>;
  let historyQb: ReturnType<typeof createMockQueryBuilder>;
  /** 원장 적립 합계(소비 합계는 null — 강화 전) */
  let earned: number;

  const boot = async (authUser: User | undefined) => {
    skinEquipRepository = createMockRepository<UserSkinEquip>();
    skinEquipRepository.find.mockResolvedValue([]);
    skinEquipRepository.update.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });
    skinLevelRepository = createMockRepository<UserSkinLevel>();
    skinLevelRepository.find.mockResolvedValue([]);
    skinLevelRepository.findOneBy.mockResolvedValue(null);
    skinLevelRepository.create.mockImplementation((value) => value as UserSkinLevel);
    ledgerRepository = createMockRepository<UserPointLedger>();
    earned = 150_000;
    historyQb = createMockQueryBuilder({
      getMany: [{ ledgerId: 61, amount: -100_000, reason: 'SKIN_UPGRADE', refKey: 'TETRIS_BLOCK:chocolate:2', memo: 'block chocolate Lv2 강화', crtdAt: new Date('2026-10-27T01:00:00.000Z') }],
    });
    ledgerRepository.createQueryBuilder.mockReturnValue(historyQb as never);
    ledgerRepository.sum.mockImplementation(async (_column, where) =>
      JSON.stringify((where as { amount: unknown }).amount) === JSON.stringify(MoreThan(0)) ? earned : null,
    );
    const repositories = new Map<unknown, unknown>([
      [UserSkinEquip, skinEquipRepository],
      [UserSkinLevel, skinLevelRepository],
      [UserPointLedger, ledgerRepository],
    ]);
    // 트랜잭션 매니저 — 저장소는 같은 대역, 강화의 사용자 행 잠금은 토큰 사용자 1행
    const manager = {
      getRepository: (entity: unknown) => repositories.get(entity),
      createQueryBuilder: () => createMockQueryBuilder({ getMany: [{ userId: 7 }] }),
    };
    e2e = await createE2eApp({
      controllers: [UsersController],
      authUser,
      providers: [
        UsersService,
        UserSkinService,
        UserPointService,
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: getRepositoryToken(UserSkinEquip), useValue: skinEquipRepository },
        { provide: getRepositoryToken(UserSkinLevel), useValue: skinLevelRepository },
        { provide: getRepositoryToken(UserPointLedger), useValue: ledgerRepository },
        { provide: getDataSourceToken(), useValue: { transaction: (run: (m: unknown) => unknown) => run(manager) } },
      ],
    });
    app = e2e.app;
  };

  afterEach(async () => {
    await app.close();
  });

  it('토큰 없으면 GET·PUT 모두 401', async () => {
    await boot(undefined);
    await request(app.getHttpServer()).get(e2e.url('/users/me/skins')).expect(401);
    await request(app.getHttpServer()).put(e2e.url('/users/me/skins')).send({ block: 'gameboy' }).expect(401);
    await request(app.getHttpServer()).post(e2e.url('/users/me/skins/upgrade')).send({ slot: 'block', skinId: 'neon', level: 2 }).expect(401);
    await request(app.getHttpServer()).get(e2e.url('/users/me/points/history')).expect(401);
    expect(skinEquipRepository.insert).not.toHaveBeenCalled();
    expect(ledgerRepository.insert).not.toHaveBeenCalled();
  });

  describe('로그인 사용자', () => {
    beforeEach(() => boot(createUser({ userId: 7 })));

    it('GET — 장착이 없으면 모든 슬롯 default + 슬롯별 카탈로그(보유 여부)', async () => {
      const res = await request(app.getHttpServer()).get(e2e.url('/users/me/skins')).expect(200);
      expect(res.body.code).toBe('SUCCESS');
      expect(res.body.data.equipped).toEqual({ block: 'default', effect: 'default', board: 'default', background: 'default' });
      expect(Object.keys(res.body.data.catalog)).toEqual(['block', 'effect', 'board', 'background']);
      expect(res.body.data.catalog.block[0]).toEqual({ id: 'default', unlock: 'default', owned: true, level: 1, nextCost: 100_000 });
      expect(res.body.data.equippedLevels).toEqual({ block: 1, effect: 1, board: 1, background: 1 });
      expect(res.body.data.points).toEqual({ earned: 150_000, spent: 0, balance: 150_000 });
      expect(ledgerRepository.sum).toHaveBeenCalledWith('amount', { userId: 7, amount: MoreThan(0) });
    });

    it('PUT — 보낸 슬롯만 토큰 사용자에게 저장하고 장착 상태를 돌려준다', async () => {
      skinEquipRepository.find.mockResolvedValue([{ userId: 7, slot: 'TETRIS_BLOCK', skinId: 'gameboy' }] as UserSkinEquip[]);
      const res = await request(app.getHttpServer()).put(e2e.url('/users/me/skins')).send({ block: 'gameboy' }).expect(200);

      expect(skinEquipRepository.insert).toHaveBeenCalledTimes(1);
      expect(skinEquipRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, slot: 'TETRIS_BLOCK', skinId: 'gameboy' }));
      expect(res.body.data.equipped.block).toBe('gameboy');
    });

    it('PUT — 카탈로그에 없는 아이템 → 422 USER_SKIN_UNKNOWN + details, 저장 없음', async () => {
      const res = await request(app.getHttpServer()).put(e2e.url('/users/me/skins')).send({ block: 'gameboy', effect: 'rainbow' }).expect(422);
      expect(res.body.code).toBe('USER_SKIN_UNKNOWN');
      expect(res.body.details).toEqual({ slot: 'effect', id: 'rainbow' });
      expect(skinEquipRepository.insert).not.toHaveBeenCalled();
      expect(skinEquipRepository.update).not.toHaveBeenCalled();
    });

    it.each([
      ['정의 외 슬롯', { hat: 'neon' }],
      ['빈 문자열', { board: '' }],
    ])('PUT — %s → 422 VALIDATION_ERROR', async (_name, body) => {
      const res = await request(app.getHttpServer()).put(e2e.url('/users/me/skins')).send(body).expect(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(skinEquipRepository.update).not.toHaveBeenCalled();
    });

    describe('POST me/skins/upgrade (skin-levels D-002)', () => {
      const upgrade = (body: object) => request(app.getHttpServer()).post(e2e.url('/users/me/skins/upgrade')).send(body);

      it('200 — 토큰 사용자 포인트를 차감하고 레벨을 저장한 뒤 GET과 같은 형태를 돌려준다', async () => {
        const res = await upgrade({ slot: 'block', skinId: 'chocolate', level: 2 }).expect(200);
        expect(ledgerRepository.insert).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 7, amount: -100_000, reason: 'SKIN_UPGRADE', refKey: 'TETRIS_BLOCK:chocolate:2', memo: 'block chocolate Lv2 강화' }),
        );
        expect(skinLevelRepository.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, slot: 'TETRIS_BLOCK', skinId: 'chocolate', level: 2 }));
        expect(Object.keys(res.body.data)).toEqual(['equipped', 'equippedLevels', 'points', 'catalog']);
      });

      it('409 USER_POINTS_INSUFFICIENT — 잔액·비용 details, 차감 없음', async () => {
        earned = 99_999;
        const res = await upgrade({ slot: 'block', skinId: 'chocolate', level: 2 }).expect(409);
        expect(res.body).toMatchObject({ code: 'USER_POINTS_INSUFFICIENT', details: { balance: 99_999, cost: 100_000 } });
        expect(ledgerRepository.insert).not.toHaveBeenCalled();
      });

      it('409 USER_SKIN_LEVEL_MISMATCH — 한 단계를 건너뜀', async () => {
        const res = await upgrade({ slot: 'effect', skinId: 'neon', level: 3 }).expect(409);
        expect(res.body).toMatchObject({ code: 'USER_SKIN_LEVEL_MISMATCH', details: { slot: 'effect', id: 'neon', level: 1 } });
      });

      it('422 USER_SKIN_UNKNOWN — 카탈로그에 없는 아이템', async () => {
        const res = await upgrade({ slot: 'board', skinId: 'rainbow', level: 2 }).expect(422);
        expect(res.body.code).toBe('USER_SKIN_UNKNOWN');
      });

      it.each([
        ['레벨 1(강화 아님)', { slot: 'block', skinId: 'neon', level: 1 }],
        ['레벨 6(상한 초과)', { slot: 'block', skinId: 'neon', level: 6 }],
        ['소수 레벨', { slot: 'block', skinId: 'neon', level: 2.5 }],
        ['정의 외 슬롯', { slot: 'hat', skinId: 'neon', level: 2 }],
        ['정의 외 필드', { slot: 'block', skinId: 'neon', level: 2, cost: 0 }],
        ['레벨 누락', { slot: 'block', skinId: 'neon' }],
      ])('422 VALIDATION_ERROR — %s', async (_name, body) => {
        const res = await upgrade(body).expect(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(ledgerRepository.insert).not.toHaveBeenCalled();
      });
    });

    describe('GET me/points/history (skin-levels D-005)', () => {
      it('200 — 현재 포인트와 최신순 내역, hasMore', async () => {
        const res = await request(app.getHttpServer()).get(e2e.url('/users/me/points/history')).expect(200);
        expect(res.body.data).toEqual({
          points: { earned: 150_000, spent: 0, balance: 150_000 },
          items: [
            {
              id: 61,
              amount: -100_000,
              reason: 'SKIN_UPGRADE',
              refKey: 'TETRIS_BLOCK:chocolate:2',
              meta: { slot: 'block', skinId: 'chocolate', level: 2 },
              memo: 'block chocolate Lv2 강화',
              createdAt: '2026-10-27T01:00:00.000Z',
            },
          ],
          nextCursor: null,
        });
      });

      it('쿼리 문자열이 숫자로 바뀌어 서비스에 닿는다 — beforeId 줄을 내 것으로 찾고, limit+1·type 조건', async () => {
        ledgerRepository.findOne.mockResolvedValue({ ledgerId: 61, crtdAt: new Date('2026-10-27T01:00:00.000Z') } as UserPointLedger);
        await request(app.getHttpServer()).get(e2e.url('/users/me/points/history?beforeId=61&limit=5&type=earn')).expect(200);
        expect(ledgerRepository.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { ledgerId: 61, userId: 7 } }));
        expect(historyQb.take).toHaveBeenCalledWith(6);
        expect(historyQb.andWhere).toHaveBeenCalledWith('l.amount > 0');
      });

      it.each([
        ['limit 0', '?limit=0'],
        ['limit 51', '?limit=51'],
        ['beforeId 문자', '?beforeId=abc'],
        ['정의 외 쿼리', '?userId=1'],
        ['정의 외 type', '?type=all'],
      ])('422 VALIDATION_ERROR — %s', async (_name, qs) => {
        const res = await request(app.getHttpServer()).get(e2e.url('/users/me/points/history' + qs)).expect(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      });
    });

    it('PUT — 숫자는 전역 암묵 변환으로 문자열이 돼 카탈로그 검사에서 422 USER_SKIN_UNKNOWN', async () => {
      const res = await request(app.getHttpServer()).put(e2e.url('/users/me/skins')).send({ block: 3 }).expect(422);
      expect(res.body.code).toBe('USER_SKIN_UNKNOWN');
      expect(skinEquipRepository.update).not.toHaveBeenCalled();
    });
  });
});

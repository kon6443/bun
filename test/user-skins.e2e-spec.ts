import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { UsersController } from '../src/modules/users/users.controller';
import { UsersService } from '../src/modules/users/users.service';
import { UserSkinService } from '../src/modules/users/user-skin.service';
import { User } from '../src/entities/User';
import { UserSkinEquip } from '../src/entities/UserSkinEquip';
import { createUser } from '../src/entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

/** 스킨 장착 API (docs/tasks/tetris-skins D-003) — 로그인 전용, 슬롯 부분 수정, 카탈로그·형식 검증 */
describe('E2E 사용자 스킨 /users/me/skins', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let skinEquipRepository: MockRepository<UserSkinEquip>;

  const boot = async (authUser: User | undefined) => {
    skinEquipRepository = createMockRepository<UserSkinEquip>();
    skinEquipRepository.find.mockResolvedValue([]);
    skinEquipRepository.update.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });
    e2e = await createE2eApp({
      controllers: [UsersController],
      authUser,
      providers: [
        UsersService,
        UserSkinService,
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: getRepositoryToken(UserSkinEquip), useValue: skinEquipRepository },
        // 장착 저장 트랜잭션 — 매니저 저장소는 같은 대역
        { provide: getDataSourceToken(), useValue: { transaction: (run: (m: unknown) => unknown) => run({ getRepository: () => skinEquipRepository }) } },
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
    expect(skinEquipRepository.insert).not.toHaveBeenCalled();
  });

  describe('로그인 사용자', () => {
    beforeEach(() => boot(createUser({ userId: 7 })));

    it('GET — 장착이 없으면 모든 슬롯 default + 슬롯별 카탈로그(보유 여부)', async () => {
      const res = await request(app.getHttpServer()).get(e2e.url('/users/me/skins')).expect(200);
      expect(res.body.code).toBe('SUCCESS');
      expect(res.body.data.equipped).toEqual({ block: 'default', effect: 'default', board: 'default', background: 'default' });
      expect(Object.keys(res.body.data.catalog)).toEqual(['block', 'effect', 'board', 'background']);
      expect(res.body.data.catalog.block[0]).toEqual({ id: 'default', unlock: 'default', owned: true });
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

    it('PUT — 숫자는 전역 암묵 변환으로 문자열이 돼 카탈로그 검사에서 422 USER_SKIN_UNKNOWN', async () => {
      const res = await request(app.getHttpServer()).put(e2e.url('/users/me/skins')).send({ block: 3 }).expect(422);
      expect(res.body.code).toBe('USER_SKIN_UNKNOWN');
      expect(skinEquipRepository.update).not.toHaveBeenCalled();
    });
  });
});

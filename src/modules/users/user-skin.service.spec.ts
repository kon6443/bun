import { QueryFailedError } from 'typeorm';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { User } from '../../entities/User';
import { UserSkinEquip } from '../../entities/UserSkinEquip';
import { UserSkinLevel } from '../../entities/UserSkinLevel';
import { SKIN_LEVEL_COSTS, TETRIS_SKIN_CATALOG, TETRIS_SKIN_SLOTS } from './skin-catalog';
import { UserSkinService } from './user-skin.service';

const DEFAULT_SET = { block: 'default', effect: 'default', board: 'default', background: 'default' };
const LV1 = { block: 1, effect: 1, board: 1 };
const POINTS = { earned: 500_000, spent: 0, balance: 500_000 };

const updated = (affected: number) => ({ affected, raw: [], generatedMaps: [] });

const row = (userId: number, slot: string, skinId: string) => ({ userId, slot, skinId }) as UserSkinEquip;
const levelRow = (userId: number, slot: string, skinId: string, level: number) => ({ userId, slot, skinId, level }) as UserSkinLevel;

describe('UserSkinService (tetris-skins D-003)', () => {
  let repository: MockRepository<UserSkinEquip>;
  let service: UserSkinService;
  let transaction: jest.Mock;
  let txRepository: MockRepository<UserSkinEquip>;
  let levelRepository: MockRepository<UserSkinLevel>;
  let txLevelRepository: MockRepository<UserSkinLevel>;
  let lockQb: ReturnType<typeof createMockQueryBuilder>;
  let manager: { getRepository: jest.Mock; createQueryBuilder: jest.Mock };
  let pointService: { pointsOf: jest.Mock; record: jest.Mock };

  beforeEach(() => {
    repository = createMockRepository<UserSkinEquip>();
    repository.find.mockResolvedValue([]);
    repository.update.mockResolvedValue(updated(1));
    levelRepository = createMockRepository<UserSkinLevel>();
    levelRepository.find.mockResolvedValue([]);
    // 쓰기는 트랜잭션 매니저의 저장소로만 — 바깥 저장소와 다른 대역이라 트랜잭션 밖 쓰기를 잡아낸다
    txRepository = createMockRepository<UserSkinEquip>();
    txRepository.update.mockResolvedValue(updated(1));
    txLevelRepository = createMockRepository<UserSkinLevel>();
    txLevelRepository.findOneBy.mockResolvedValue(null);
    txLevelRepository.create.mockImplementation((value) => value as UserSkinLevel);
    lockQb = createMockQueryBuilder({ getMany: [{ userId: 1 }] });
    manager = {
      getRepository: jest.fn((entity: unknown) => (entity === UserSkinLevel ? txLevelRepository : txRepository)),
      createQueryBuilder: jest.fn(() => lockQb),
    };
    transaction = jest.fn(async (run: (manager: unknown) => unknown) => run(manager));
    pointService = { pointsOf: jest.fn().mockResolvedValue(POINTS), record: jest.fn().mockResolvedValue(undefined) };
    service = new UserSkinService(repository as never, levelRepository as never, { transaction } as never, pointService as never);
  });

  describe('조회', () => {
    it('장착이 없으면 모든 슬롯 default, 카탈로그는 슬롯마다 서버 순서대로 보유 여부와 함께', async () => {
      const skins = await service.getSkins(1);
      expect(skins.equipped).toEqual(DEFAULT_SET);
      expect(Object.keys(skins.catalog)).toEqual([...TETRIS_SKIN_SLOTS]);
      expect(skins.catalog.block.map((item) => item.id)).toEqual(TETRIS_SKIN_CATALOG.block.map((item) => item.id));
      expect(skins.catalog.block.every((item) => item.owned)).toBe(true);
    });

    it('DB 슬롯 키를 API 슬롯으로 바꾸고, 카탈로그에서 빠진 아이템·모르는 슬롯은 default로 본다', async () => {
      repository.find.mockResolvedValue([
        row(1, 'TETRIS_BLOCK', 'gameboy'),
        row(1, 'TETRIS_BACKGROUND', 'retired-item'),
        row(1, 'OTHER_GAME_SLOT', 'neon'),
      ]);
      expect((await service.getSkins(1)).equipped).toEqual({ ...DEFAULT_SET, block: 'gameboy' });
    });

    it('보드 스킨은 보드 슬롯만 — 화면 배경은 보는 사람 것이라 싣지 않는다. 게스트(null)는 DB를 읽지 않고 default', async () => {
      repository.find.mockResolvedValue([row(5, 'TETRIS_EFFECT', 'neon'), row(5, 'TETRIS_BACKGROUND', 'gameboy')]);
      expect(await service.boardSkinsOf(5)).toEqual({ block: 'default', effect: 'neon', board: 'default', levels: LV1 });

      repository.find.mockClear();
      expect(await service.boardSkinsOf(null)).toEqual({ block: 'default', effect: 'default', board: 'default', levels: LV1 });
      expect(repository.find).not.toHaveBeenCalled();
    });

    it('여러 주인을 한 번에 읽고(중복·null 제외), 장착이 없는 사용자도 default로 채운다', async () => {
      repository.find.mockResolvedValue([row(2, 'TETRIS_BOARD', 'high-contrast')]);
      const skins = await service.boardSkinsOfMany([2, null, 3, 2]);
      expect(repository.find).toHaveBeenCalledTimes(1);
      expect(skins.get(2)).toEqual({ block: 'default', effect: 'default', board: 'high-contrast', levels: LV1 });
      expect(skins.get(3)).toEqual({ block: 'default', effect: 'default', board: 'default', levels: LV1 });
      expect(skins.has(null as never)).toBe(false);
    });
  });

  describe('레벨 (skin-levels D-002)', () => {
    it('보드 스킨 레벨은 장착한 아이템의 레벨 — 장착하지 않은 아이템의 레벨은 싣지 않는다', async () => {
      repository.find.mockResolvedValue([row(2, 'TETRIS_BLOCK', 'chocolate')]);
      levelRepository.find.mockResolvedValue([levelRow(2, 'TETRIS_BLOCK', 'chocolate', 4), levelRow(2, 'TETRIS_BOARD', 'neon', 3), levelRow(2, 'TETRIS_EFFECT', 'default', 2)]);
      const skins = await service.boardSkinsOfMany([2, 3]);
      expect(skins.get(2)).toEqual({ block: 'chocolate', effect: 'default', board: 'default', levels: { block: 4, effect: 2, board: 1 } });
      expect(skins.get(3)?.levels).toEqual(LV1);
      expect(levelRepository.find).toHaveBeenCalledTimes(1);
    });

    it('내 스킨 — 카탈로그 항목마다 레벨·다음 비용(만렙 null), 장착 레벨, 포인트', async () => {
      repository.find.mockResolvedValue([row(1, 'TETRIS_BACKGROUND', 'clear')]);
      levelRepository.find.mockResolvedValue([levelRow(1, 'TETRIS_BACKGROUND', 'clear', 2), levelRow(1, 'TETRIS_BLOCK', 'neon', 5)]);
      const skins = await service.getSkins(1);
      expect(skins.equippedLevels).toEqual({ block: 1, effect: 1, board: 1, background: 2 });
      expect(skins.points).toEqual(POINTS);
      expect(skins.catalog.block.find((item) => item.id === 'neon')).toMatchObject({ level: 5, nextCost: null });
      expect(skins.catalog.block.find((item) => item.id === 'default')).toMatchObject({ level: 1, nextCost: SKIN_LEVEL_COSTS[0] });
      expect(skins.catalog.background.find((item) => item.id === 'clear')).toMatchObject({ level: 2, nextCost: SKIN_LEVEL_COSTS[1] });
    });

    it('새 아이템 clear·chocolate는 모든 슬롯에 무료로 있다', () => {
      for (const slot of TETRIS_SKIN_SLOTS) {
        expect(TETRIS_SKIN_CATALOG[slot]).toEqual(expect.arrayContaining([{ id: 'clear', unlock: 'free' }, { id: 'chocolate', unlock: 'free' }]));
      }
    });
  });

  describe('강화 (skin-levels D-002)', () => {
    it('사용자 행을 잠근 뒤 잔액을 확인하고, 원장 차감과 레벨 저장을 같은 트랜잭션에서 한다', async () => {
      const result = await service.upgrade(1, 'block', 'chocolate', 2);

      expect(manager.createQueryBuilder).toHaveBeenCalledWith(User, 'user');
      expect(lockQb.setLock).toHaveBeenCalledWith('pessimistic_write');
      // take/limit이 붙으면 Oracle이 FOR UPDATE를 거부한다(ORA-02014)
      expect(lockQb.take).not.toHaveBeenCalled();
      expect(lockQb.limit).not.toHaveBeenCalled();
      expect(lockQb.getMany.mock.invocationCallOrder[0]).toBeLessThan(pointService.pointsOf.mock.invocationCallOrder[0]);
      // 현재 레벨도 잠근 뒤 같은 트랜잭션에서 읽는다 — 앞서 커밋된 강화를 보고 같은 단계를 두 번 사지 않게
      expect(lockQb.getMany.mock.invocationCallOrder[0]).toBeLessThan(txLevelRepository.findOneBy.mock.invocationCallOrder[0]);
      expect(levelRepository.findOneBy).not.toHaveBeenCalled();
      expect(pointService.pointsOf).toHaveBeenCalledWith(1, manager);
      expect(pointService.record).toHaveBeenCalledWith(manager, {
        userId: 1,
        amount: -SKIN_LEVEL_COSTS[0],
        reason: 'SKIN_UPGRADE',
        refKey: 'TETRIS_BLOCK:chocolate:2',
        memo: 'block chocolate Lv2 강화',
      });
      expect(txLevelRepository.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, slot: 'TETRIS_BLOCK', skinId: 'chocolate', level: 2 }));
      expect(levelRepository.save).not.toHaveBeenCalled();
      expect(result.points).toEqual(POINTS);
    });

    it('다음 단계 비용은 현재 레벨 기준 — Lv4 → Lv5는 마지막 비용', async () => {
      txLevelRepository.findOneBy.mockResolvedValue(levelRow(1, 'TETRIS_EFFECT', 'neon', 4));
      pointService.pointsOf.mockResolvedValue({ earned: 3_000_000, spent: 0, balance: 3_000_000 });
      await service.upgrade(1, 'effect', 'neon', 5);
      expect(pointService.record).toHaveBeenCalledWith(manager, expect.objectContaining({ amount: -SKIN_LEVEL_COSTS[3], refKey: 'TETRIS_EFFECT:neon:5' }));
    });

    it('이미 목표 레벨 이상이면 차감 없이 지금 상태(중복 클릭)', async () => {
      txLevelRepository.findOneBy.mockResolvedValue(levelRow(1, 'TETRIS_BLOCK', 'chocolate', 3));
      await expect(service.upgrade(1, 'block', 'chocolate', 2)).resolves.toBeDefined();
      expect(pointService.record).not.toHaveBeenCalled();
      expect(txLevelRepository.save).not.toHaveBeenCalled();
    });

    it('한 단계를 건너뛰면 409 USER_SKIN_LEVEL_MISMATCH(현재 레벨 포함) — 차감 없음', async () => {
      await expect(service.upgrade(1, 'block', 'chocolate', 3)).rejects.toMatchObject({
        status: 409,
        code: 'USER_SKIN_LEVEL_MISMATCH',
        details: { slot: 'block', id: 'chocolate', level: 1 },
      });
      expect(pointService.record).not.toHaveBeenCalled();
    });

    it('잔액이 비용보다 적으면 409 USER_POINTS_INSUFFICIENT — 차감·저장 없음', async () => {
      pointService.pointsOf.mockResolvedValue({ earned: 99_999, spent: 0, balance: 99_999 });
      await expect(service.upgrade(1, 'block', 'chocolate', 2)).rejects.toMatchObject({
        status: 409,
        code: 'USER_POINTS_INSUFFICIENT',
        details: { balance: 99_999, cost: SKIN_LEVEL_COSTS[0] },
      });
      expect(pointService.record).not.toHaveBeenCalled();
      expect(txLevelRepository.save).not.toHaveBeenCalled();
    });

    it('잔액이 비용과 같으면 강화된다', async () => {
      pointService.pointsOf.mockResolvedValue({ earned: SKIN_LEVEL_COSTS[0], spent: 0, balance: SKIN_LEVEL_COSTS[0] });
      await service.upgrade(1, 'block', 'chocolate', 2);
      expect(pointService.record).toHaveBeenCalled();
    });

    it('카탈로그에 없는 아이템은 422 USER_SKIN_UNKNOWN — 트랜잭션을 열지 않는다', async () => {
      await expect(service.upgrade(1, 'block', 'rainbow', 2)).rejects.toMatchObject({ status: 422, code: 'USER_SKIN_UNKNOWN', details: { slot: 'block', id: 'rainbow' } });
      expect(transaction).not.toHaveBeenCalled();
    });

    it('잠글 사용자 행이 없으면(탈퇴) 404 USER_NOT_FOUND', async () => {
      lockQb.getMany.mockResolvedValue([]);
      await expect(service.upgrade(1, 'block', 'chocolate', 2)).rejects.toMatchObject({ status: 404, code: 'USER_NOT_FOUND' });
      expect(pointService.record).not.toHaveBeenCalled();
    });
  });

  describe('도감 (D-005)', () => {
    it('게스트 — 전체 슬롯·아이템을 보이고 보유·장착은 모두 false, DB는 읽지 않는다', async () => {
      const collection = await service.collection(null);
      expect(collection.signedIn).toBe(false);
      expect(collection.slots.map((s) => s.slot)).toEqual([...TETRIS_SKIN_SLOTS]);
      expect(collection.slots[0].items.map((item) => item.id)).toEqual(TETRIS_SKIN_CATALOG.block.map((item) => item.id));
      expect(collection.slots.flatMap((s) => s.items).every((item) => !item.owned && !item.equipped && item.level === 1)).toBe(true);
      expect(collection).toMatchObject({ maxLevel: 5, levelCosts: SKIN_LEVEL_COSTS, points: null });
      expect(repository.find).not.toHaveBeenCalled();
      expect(levelRepository.find).not.toHaveBeenCalled();
      expect(pointService.pointsOf).not.toHaveBeenCalled();
    });

    it('로그인 — 보유 표시, 슬롯마다 장착한 아이템 하나만 equipped(장착 없는 슬롯은 default)', async () => {
      repository.find.mockResolvedValue([row(1, 'TETRIS_BLOCK', 'neon')]);
      const collection = await service.collection(1);
      expect(collection.signedIn).toBe(true);
      const block = collection.slots.find((s) => s.slot === 'block')!;
      expect(block.items.filter((item) => item.equipped).map((item) => item.id)).toEqual(['neon']);
      const effect = collection.slots.find((s) => s.slot === 'effect')!;
      expect(effect.items.filter((item) => item.equipped).map((item) => item.id)).toEqual(['default']);
      expect(block.items.every((item) => item.owned)).toBe(true);
      expect(collection.points).toEqual(POINTS);
    });

    it('로그인 — 아이템마다 내 레벨', async () => {
      levelRepository.find.mockResolvedValue([levelRow(1, 'TETRIS_EFFECT', 'chocolate', 3)]);
      const collection = await service.collection(1);
      const effect = collection.slots.find((s) => s.slot === 'effect')!;
      expect(effect.items.find((item) => item.id === 'chocolate')?.level).toBe(3);
      expect(collection.slots.find((s) => s.slot === 'block')!.items.find((item) => item.id === 'chocolate')?.level).toBe(1);
    });
  });

  describe('장착', () => {
    it('보낸 슬롯만 DB 슬롯 키로 저장한다', async () => {
      await service.equip(1, { block: 'gameboy', background: 'neon' });
      expect(txRepository.update).toHaveBeenCalledTimes(2);
      expect(txRepository.update).toHaveBeenCalledWith({ userId: 1, slot: 'TETRIS_BLOCK' }, expect.objectContaining({ skinId: 'gameboy' }));
      expect(txRepository.update).toHaveBeenCalledWith({ userId: 1, slot: 'TETRIS_BACKGROUND' }, expect.objectContaining({ skinId: 'neon' }));
      expect(txRepository.insert).not.toHaveBeenCalled();
    });

    it('여러 슬롯은 한 트랜잭션으로 저장한다', async () => {
      await service.equip(1, { block: 'gameboy', effect: 'neon' });
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(txRepository.update).toHaveBeenCalledTimes(2);
      // 트랜잭션 밖(기본 저장소)으로는 쓰지 않는다
      expect(repository.update).not.toHaveBeenCalled();
      expect(repository.insert).not.toHaveBeenCalled();
    });

    it('처음 장착하는 슬롯은 INSERT', async () => {
      txRepository.update.mockResolvedValue(updated(0));
      await service.equip(1, { effect: 'neon' });
      expect(txRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, slot: 'TETRIS_EFFECT', skinId: 'neon' }));
    });

    it('같은 슬롯 첫 장착이 동시에 와 INSERT가 PK 충돌(ORA-00001)하면 UPDATE로 다시 한다', async () => {
      txRepository.update.mockResolvedValueOnce(updated(0)).mockResolvedValueOnce(updated(1));
      txRepository.insert.mockRejectedValue(new QueryFailedError('INSERT', [], new Error('ORA-00001: unique constraint violated')));
      await expect(service.equip(1, { board: 'gameboy' })).resolves.toBeDefined();
      expect(txRepository.update).toHaveBeenCalledTimes(2);
    });

    it('PK 충돌이 아닌 INSERT 오류는 그대로 던진다', async () => {
      txRepository.update.mockResolvedValue(updated(0));
      txRepository.insert.mockRejectedValue(new QueryFailedError('INSERT', [], new Error('ORA-02291: integrity constraint violated')));
      await expect(service.equip(1, { board: 'gameboy' })).rejects.toThrow('ORA-02291');
    });

    it('카탈로그에 없는 아이템이 하나라도 있으면 422 USER_SKIN_UNKNOWN — 어떤 슬롯도 바꾸지 않는다', async () => {
      await expect(service.equip(1, { block: 'gameboy', effect: 'rainbow' })).rejects.toMatchObject({
        status: 422,
        code: 'USER_SKIN_UNKNOWN',
        details: { slot: 'effect', id: 'rainbow' },
      });
      expect(txRepository.update).not.toHaveBeenCalled();
      expect(txRepository.insert).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('다른 슬롯의 아이템 id는 그 슬롯 카탈로그 기준으로 본다(빈 문자열 포함 거부)', async () => {
      await expect(service.equip(1, { background: '' })).rejects.toMatchObject({ status: 422, code: 'USER_SKIN_UNKNOWN' });
    });
  });
});

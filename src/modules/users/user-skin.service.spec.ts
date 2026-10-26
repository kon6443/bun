import { QueryFailedError } from 'typeorm';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { UserSkinEquip } from '../../entities/UserSkinEquip';
import { TETRIS_SKIN_CATALOG, TETRIS_SKIN_SLOTS } from './skin-catalog';
import { UserSkinService } from './user-skin.service';

const DEFAULT_SET = { block: 'default', effect: 'default', board: 'default', background: 'default' };

const updated = (affected: number) => ({ affected, raw: [], generatedMaps: [] });

const row = (userId: number, slot: string, skinId: string) => ({ userId, slot, skinId }) as UserSkinEquip;

describe('UserSkinService (tetris-skins D-003)', () => {
  let repository: MockRepository<UserSkinEquip>;
  let service: UserSkinService;

  beforeEach(() => {
    repository = createMockRepository<UserSkinEquip>();
    repository.find.mockResolvedValue([]);
    repository.update.mockResolvedValue(updated(1));
    service = new UserSkinService(repository as never);
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
      expect(await service.boardSkinsOf(5)).toEqual({ block: 'default', effect: 'neon', board: 'default' });

      repository.find.mockClear();
      expect(await service.boardSkinsOf(null)).toEqual({ block: 'default', effect: 'default', board: 'default' });
      expect(repository.find).not.toHaveBeenCalled();
    });

    it('여러 주인을 한 번에 읽고(중복·null 제외), 장착이 없는 사용자도 default로 채운다', async () => {
      repository.find.mockResolvedValue([row(2, 'TETRIS_BOARD', 'high-contrast')]);
      const skins = await service.boardSkinsOfMany([2, null, 3, 2]);
      expect(repository.find).toHaveBeenCalledTimes(1);
      expect(skins.get(2)).toEqual({ block: 'default', effect: 'default', board: 'high-contrast' });
      expect(skins.get(3)).toEqual({ block: 'default', effect: 'default', board: 'default' });
      expect(skins.has(null as never)).toBe(false);
    });
  });

  describe('장착', () => {
    it('보낸 슬롯만 DB 슬롯 키로 저장한다', async () => {
      await service.equip(1, { block: 'gameboy', background: 'neon' });
      expect(repository.update).toHaveBeenCalledTimes(2);
      expect(repository.update).toHaveBeenCalledWith({ userId: 1, slot: 'TETRIS_BLOCK' }, expect.objectContaining({ skinId: 'gameboy' }));
      expect(repository.update).toHaveBeenCalledWith({ userId: 1, slot: 'TETRIS_BACKGROUND' }, expect.objectContaining({ skinId: 'neon' }));
      expect(repository.insert).not.toHaveBeenCalled();
    });

    it('처음 장착하는 슬롯은 INSERT', async () => {
      repository.update.mockResolvedValue(updated(0));
      await service.equip(1, { effect: 'neon' });
      expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, slot: 'TETRIS_EFFECT', skinId: 'neon' }));
    });

    it('같은 슬롯 첫 장착이 동시에 와 INSERT가 PK 충돌(ORA-00001)하면 UPDATE로 다시 한다', async () => {
      repository.update.mockResolvedValueOnce(updated(0)).mockResolvedValueOnce(updated(1));
      repository.insert.mockRejectedValue(new QueryFailedError('INSERT', [], new Error('ORA-00001: unique constraint violated')));
      await expect(service.equip(1, { board: 'gameboy' })).resolves.toBeDefined();
      expect(repository.update).toHaveBeenCalledTimes(2);
    });

    it('PK 충돌이 아닌 INSERT 오류는 그대로 던진다', async () => {
      repository.update.mockResolvedValue(updated(0));
      repository.insert.mockRejectedValue(new QueryFailedError('INSERT', [], new Error('ORA-02291: integrity constraint violated')));
      await expect(service.equip(1, { board: 'gameboy' })).rejects.toThrow('ORA-02291');
    });

    it('카탈로그에 없는 아이템이 하나라도 있으면 422 USER_SKIN_UNKNOWN — 어떤 슬롯도 바꾸지 않는다', async () => {
      await expect(service.equip(1, { block: 'gameboy', effect: 'rainbow' })).rejects.toMatchObject({
        status: 422,
        code: 'USER_SKIN_UNKNOWN',
        details: { slot: 'effect', id: 'rainbow' },
      });
      expect(repository.update).not.toHaveBeenCalled();
      expect(repository.insert).not.toHaveBeenCalled();
    });

    it('다른 슬롯의 아이템 id는 그 슬롯 카탈로그 기준으로 본다(빈 문자열 포함 거부)', async () => {
      await expect(service.equip(1, { background: '' })).rejects.toMatchObject({ status: 422, code: 'USER_SKIN_UNKNOWN' });
    });
  });
});

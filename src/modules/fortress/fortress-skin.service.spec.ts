import { UserPointService } from '../users/user-point.service';
import { UserSkinService } from '../users/user-skin.service';
import { FortressSkinService } from './fortress-skin.service';

const POINTS = { earned: 300_000, spent: 100_000, balance: 200_000 };

/** 포트리스 탱크 스킨 (DESIGN §13) — 카탈로그 검증·슬롯 키·장착 해석(default 폴백). 저장·강화 트랜잭션은 UserSkinService spec */
describe('FortressSkinService', () => {
  let userSkin: { slotItemsOf: jest.Mock; equipItem: jest.Mock; upgradeItem: jest.Mock };
  let service: FortressSkinService;
  const state = (equipped: string | null, levels: [string, number][] = []) =>
    new Map([[7, { equipped, levels: new Map(levels) }]]);

  beforeEach(() => {
    userSkin = { slotItemsOf: jest.fn().mockResolvedValue(state(null)), equipItem: jest.fn(), upgradeItem: jest.fn() };
    service = new FortressSkinService(
      userSkin as unknown as UserSkinService,
      { pointsOf: jest.fn().mockResolvedValue(POINTS) } as unknown as UserPointService,
    );
  });

  it('getSkins: 장착 없음 → default Lv1, 아이템별 보유·장착·레벨·다음 비용, 슬롯 키 FORTRESS_TANK', async () => {
    userSkin.slotItemsOf.mockResolvedValue(state(null, [['desert', 5]]));
    const view = await service.getSkins(7);
    expect(userSkin.slotItemsOf).toHaveBeenCalledWith([7], 'FORTRESS_TANK');
    expect(view.equipped).toEqual({ id: 'default', level: 1 });
    expect(view.points).toEqual(POINTS);
    expect(view.maxLevel).toBe(5);
    expect(view.items[0]).toEqual({ id: 'default', unlock: 'default', owned: true, equipped: true, level: 1, nextCost: 100_000 });
    expect(view.items.find((i) => i.id === 'desert')).toEqual({ id: 'desert', unlock: 'free', owned: true, equipped: false, level: 5, nextCost: null });
  });

  it('tankSkinOf: 게스트는 조회 없이 default · 장착 아이템과 그 레벨 · 카탈로그에서 빠진 id는 default', async () => {
    await expect(service.tankSkinOf(null)).resolves.toEqual({ id: 'default', level: 1 });
    expect(userSkin.slotItemsOf).not.toHaveBeenCalled();
    userSkin.slotItemsOf.mockResolvedValue(state('neon', [['neon', 3]]));
    await expect(service.tankSkinOf(7)).resolves.toEqual({ id: 'neon', level: 3 });
    userSkin.slotItemsOf.mockResolvedValue(state('retired'));
    await expect(service.tankSkinOf(7)).resolves.toEqual({ id: 'default', level: 1 });
  });

  it('equip: 카탈로그 아이템이면 FORTRESS_TANK 슬롯에 저장 · 모르는 아이템은 422 USER_SKIN_UNKNOWN(저장 안 함)', async () => {
    await service.equip(7, 'desert');
    expect(userSkin.equipItem).toHaveBeenCalledWith(7, 'FORTRESS_TANK', 'desert');
    await expect(service.equip(7, 'gameboy')).rejects.toMatchObject({ status: 422, code: 'USER_SKIN_UNKNOWN' });
    expect(userSkin.equipItem).toHaveBeenCalledTimes(1);
  });

  it('upgrade: 공용 강화(사용자 잠금·원장 SKIN_UPGRADE)에 슬롯 키·메모·에러 slot tank로 위임 · 모르는 아이템 422', async () => {
    await service.upgrade(7, 'arctic', 2);
    expect(userSkin.upgradeItem).toHaveBeenCalledWith(7, 'FORTRESS_TANK', 'arctic', 2, '포트리스 탱크 arctic Lv2 강화', 'tank');
    await expect(service.upgrade(7, 'nope', 2)).rejects.toMatchObject({ status: 422, code: 'USER_SKIN_UNKNOWN' });
    expect(userSkin.upgradeItem).toHaveBeenCalledTimes(1);
  });
});

import { Injectable } from '@nestjs/common';
import { SKIN_LEVEL_COSTS, SKIN_MAX_LEVEL, SKIN_MIN_LEVEL, type SkinItem, nextLevelCost } from '../users/skin-catalog';
import { UserPointService, type UserPoints } from '../users/user-point.service';
import { UserSkinService } from '../users/user-skin.service';
import { UserSkinNotOwnedErrorResponseDto, UserSkinUnknownErrorResponseDto } from '../users/users-error.dto';
import { FORTRESS_TANK_SKINS, FORTRESS_TANK_SLOT, FORTRESS_TANK_SLOT_KEY, defaultTankSkin, findTankSkin } from './fortress-skins';
import type { FortressTankSkin } from './fortress.events';

/** 내 탱크 스킨 — 장착·포인트·아이템별 보유·레벨·다음 비용 (테트리스 `users/me/skins`와 같은 의미, 슬롯 1개) */
export interface FortressSkinsView {
  equipped: FortressTankSkin;
  points: UserPoints;
  maxLevel: number;
  /** [i] = Lv(i+1) → Lv(i+2) 비용 */
  levelCosts: readonly number[];
  items: { id: string; unlock: SkinItem['unlock']; owned: boolean; equipped: boolean; level: number; nextCost: number | null }[];
}

/**
 * 포트리스 탱크 스킨 (docs/tasks/fortress DESIGN §13) — 카탈로그는 fortress-skins.ts, 저장·강화 트랜잭션은 UserSkinService의
 * 슬롯 공용 메서드(테트리스와 같은 코드: 사용자 행 잠금·원장 SKIN_UPGRADE·레벨 행). 장착은 남의 화면(대기실·경기·리플레이)에도 보인다
 */
@Injectable()
export class FortressSkinService {
  constructor(
    private readonly userSkinService: UserSkinService,
    private readonly userPointService: UserPointService,
  ) {}

  async getSkins(userId: number): Promise<FortressSkinsView> {
    const state = (await this.userSkinService.slotItemsOf([userId], FORTRESS_TANK_SLOT_KEY)).get(userId);
    const levels = state?.levels ?? new Map<string, number>();
    const equipped = this.toTankSkin(state?.equipped ?? null, levels);
    return {
      equipped,
      points: await this.userPointService.pointsOf(userId),
      maxLevel: SKIN_MAX_LEVEL,
      levelCosts: SKIN_LEVEL_COSTS,
      items: FORTRESS_TANK_SKINS.map((item) => {
        const level = levels.get(item.id) ?? SKIN_MIN_LEVEL;
        return { id: item.id, unlock: item.unlock, owned: this.isOwned(item), equipped: equipped.id === item.id, level, nextCost: nextLevelCost(level) };
      }),
    };
  }

  /** 장착 — 모르는 아이템 422, 얻지 않은 아이템 403. 진행 중인 경기 자리는 바뀌지 않고 다음 입장·재연결 때 방에 반영된다 */
  async equip(userId: number, skinId: string): Promise<FortressSkinsView> {
    this.requireOwned(skinId);
    await this.userSkinService.equipItem(userId, FORTRESS_TANK_SLOT_KEY, skinId);
    return this.getSkins(userId);
  }

  /** 한 단계 강화 — level은 목표 레벨. 이미 그 레벨 이상이면 차감 없이 지금 상태(중복 클릭 안전) */
  async upgrade(userId: number, skinId: string, level: number): Promise<FortressSkinsView> {
    this.requireOwned(skinId);
    await this.userSkinService.upgradeItem(
      userId,
      FORTRESS_TANK_SLOT_KEY,
      skinId,
      level,
      `포트리스 탱크 ${skinId} Lv${level} 강화`,
      FORTRESS_TANK_SLOT,
    );
    return this.getSkins(userId);
  }

  /** 방 입장용 — 계정 장착 탱크 스킨과 그 레벨. 게스트(null)·장착 없음·카탈로그에서 빠진 아이템은 default Lv1 */
  async tankSkinOf(userId: number | null): Promise<FortressTankSkin> {
    if (userId === null) return defaultTankSkin();
    const state = (await this.userSkinService.slotItemsOf([userId], FORTRESS_TANK_SLOT_KEY)).get(userId);
    return this.toTankSkin(state?.equipped ?? null, state?.levels ?? new Map<string, number>());
  }

  private toTankSkin(equippedId: string | null, levels: Map<string, number>): FortressTankSkin {
    const item = equippedId === null ? undefined : findTankSkin(equippedId);
    if (!item) return defaultTankSkin();
    return { id: item.id, level: levels.get(item.id) ?? SKIN_MIN_LEVEL };
  }

  private requireOwned(skinId: string): void {
    const item = findTankSkin(skinId);
    if (!item) throw new UserSkinUnknownErrorResponseDto({ details: { slot: FORTRESS_TANK_SLOT, id: skinId } });
    if (!this.isOwned(item)) throw new UserSkinNotOwnedErrorResponseDto({ details: { slot: FORTRESS_TANK_SLOT, id: skinId } });
  }

  /** 지금은 default·free뿐이라 모두 보유 — 획득 방식이 생기면 획득 기록과 함께 여기서 판정 */
  private isOwned(item: SkinItem): boolean {
    return item.unlock === 'default' || item.unlock === 'free';
  }
}

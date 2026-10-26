import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError, Repository } from 'typeorm';
import { UserSkinEquip } from '../../entities/UserSkinEquip';
import {
  SkinItem,
  TETRIS_SKIN_CATALOG,
  TETRIS_SKIN_SLOTS,
  TETRIS_SKIN_SLOT_KEYS,
  TetrisBoardSkins,
  TetrisSkinSet,
  TetrisSkinSlot,
  defaultSkinSet,
  findSkinItem,
  toBoardSkins,
} from './skin-catalog';
import { UserSkinNotOwnedErrorResponseDto, UserSkinUnknownErrorResponseDto } from './users-error.dto';

export interface SkinCatalogEntry {
  id: string;
  unlock: SkinItem['unlock'];
  owned: boolean;
}

export interface UserSkins {
  equipped: TetrisSkinSet;
  catalog: Record<TetrisSkinSlot, SkinCatalogEntry[]>;
}

const SLOT_BY_KEY = new Map(TETRIS_SKIN_SLOTS.map((slot) => [TETRIS_SKIN_SLOT_KEYS[slot], slot]));

/** ORA-00001 — 같은 슬롯을 동시에 처음 장착한 두 요청 중 늦은 쪽의 INSERT */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof QueryFailedError && /ORA-00001/.test(error.message);
}

/**
 * 스킨 장착 (docs/tasks/tetris-skins D-003) — 카탈로그(skin-catalog.ts)는 코드, 장착은 USER_SKIN_EQUIPS.
 * 행이 없거나 카탈로그에서 빠진 아이템은 default로 본다(아이템을 내려도 저장된 사용자가 깨지지 않게).
 * 남의 보드를 그릴 때도 쓴다(대전 상대·리플레이 — 보드 슬롯만, 게스트·익명은 default)
 */
@Injectable()
export class UserSkinService {
  constructor(
    @InjectRepository(UserSkinEquip)
    private readonly equipRepository: Repository<UserSkinEquip>,
  ) {}

  async getSkins(userId: number): Promise<UserSkins> {
    return { equipped: await this.equippedOf(userId), catalog: this.catalogFor(userId) };
  }

  /** 슬롯 일부만 바꾼다 — 모르는 아이템은 422, 획득하지 않은 아이템은 403. 하나라도 거절되면 아무것도 바꾸지 않는다 */
  async equip(userId: number, changes: Partial<TetrisSkinSet>): Promise<UserSkins> {
    const entries = TETRIS_SKIN_SLOTS.flatMap((slot) => {
      const id = changes[slot];
      return id === undefined ? [] : [{ slot, id }];
    });
    for (const { slot, id } of entries) {
      const item = findSkinItem(slot, id);
      if (!item) throw new UserSkinUnknownErrorResponseDto({ details: { slot, id } });
      if (!this.isOwned(userId, item)) throw new UserSkinNotOwnedErrorResponseDto({ details: { slot, id } });
    }
    for (const { slot, id } of entries) {
      await this.saveEquip(userId, TETRIS_SKIN_SLOT_KEYS[slot], id);
    }
    return this.getSkins(userId);
  }

  /** 장착 세트 — 행 없는 슬롯·카탈로그에서 빠진 아이템은 default */
  async equippedOf(userId: number | null): Promise<TetrisSkinSet> {
    if (userId === null) return defaultSkinSet();
    return (await this.equippedOfMany([userId])).get(userId) ?? defaultSkinSet();
  }

  /** 보드 주인 스킨 — 보드 슬롯(block·effect·board)만. null(게스트·익명 기록)은 default */
  async boardSkinsOf(userId: number | null): Promise<TetrisBoardSkins> {
    return toBoardSkins(await this.equippedOf(userId));
  }

  /** 여러 보드 주인의 보드 스킨을 한 번에 — 결과에 없는 userId(게스트 포함)는 호출 쪽이 default로 본다 */
  async boardSkinsOfMany(userIds: readonly (number | null)[]): Promise<Map<number, TetrisBoardSkins>> {
    const sets = await this.equippedOfMany(userIds);
    return new Map([...sets].map(([userId, set]) => [userId, toBoardSkins(set)]));
  }

  private async equippedOfMany(userIds: readonly (number | null)[]): Promise<Map<number, TetrisSkinSet>> {
    const ids = [...new Set(userIds.filter((id): id is number => id !== null))];
    const result = new Map(ids.map((id) => [id, defaultSkinSet()]));
    if (ids.length === 0) return result;
    const rows = await this.equipRepository.find({ select: { userId: true, slot: true, skinId: true }, where: { userId: In(ids) } });
    for (const row of rows) {
      const slot = SLOT_BY_KEY.get(row.slot);
      if (slot && findSkinItem(slot, row.skinId)) result.get(row.userId)![slot] = row.skinId;
    }
    return result;
  }

  private catalogFor(userId: number): Record<TetrisSkinSlot, SkinCatalogEntry[]> {
    const entries = (slot: TetrisSkinSlot) =>
      TETRIS_SKIN_CATALOG[slot].map((item) => ({ id: item.id, unlock: item.unlock, owned: this.isOwned(userId, item) }));
    return { block: entries('block'), effect: entries('effect'), board: entries('board'), background: entries('background') };
  }

  /** 지금은 default·free뿐이라 모두 보유 — 업적·출석 아이템은 획득 기록 테이블과 함께 여기서 판정한다 */
  private isOwned(_userId: number, item: SkinItem): boolean {
    return item.unlock === 'default' || item.unlock === 'free';
  }

  /** 행이 없으면 만들고 있으면 바꾼다 — 같은 슬롯의 첫 장착이 동시에 오면 늦은 INSERT가 PK 충돌하므로 UPDATE로 다시 한다 */
  private async saveEquip(userId: number, slot: string, skinId: string): Promise<void> {
    const values = { skinId, updatedAt: new Date() };
    const { affected } = await this.equipRepository.update({ userId, slot }, values);
    if (affected) return;
    try {
      await this.equipRepository.insert({ userId, slot, ...values });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await this.equipRepository.update({ userId, slot }, values);
    }
  }
}

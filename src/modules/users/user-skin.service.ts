import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, QueryFailedError, Repository } from 'typeorm';
import { User } from '../../entities/User';
import { UserSkinEquip } from '../../entities/UserSkinEquip';
import { UserSkinLevel } from '../../entities/UserSkinLevel';
import {
  SKIN_LEVEL_COSTS,
  SKIN_MAX_LEVEL,
  SKIN_MIN_LEVEL,
  SkinItem,
  TETRIS_SKIN_CATALOG,
  TETRIS_SKIN_SLOTS,
  TETRIS_SKIN_SLOT_KEYS,
  TetrisBoardSkins,
  TetrisSkinLevels,
  TetrisSkinSet,
  TetrisSkinSlot,
  defaultSkinLevels,
  defaultSkinSet,
  findSkinItem,
  nextLevelCost,
  toBoardSkins,
} from './skin-catalog';
import { USER_POINT_REASONS, UserPointService, UserPoints } from './user-point.service';
import {
  UserNotFoundErrorResponseDto,
  UserPointsInsufficientErrorResponseDto,
  UserSkinLevelMismatchErrorResponseDto,
  UserSkinNotOwnedErrorResponseDto,
  UserSkinUnknownErrorResponseDto,
} from './users-error.dto';

export interface SkinCatalogEntry {
  id: string;
  unlock: SkinItem['unlock'];
  owned: boolean;
  /** 이 사용자의 레벨(1~5) */
  level: number;
  /** 한 단계 올리는 비용 — 만렙이면 null */
  nextCost: number | null;
}

/** 도감 — 누구나 보는 전체 목록 + 로그인이면 보유·장착·레벨·포인트 표시 (tetris-skins D-005 · skin-levels D-002) */
export interface SkinCollection {
  signedIn: boolean;
  maxLevel: number;
  /** [i] = Lv(i+1) → Lv(i+2) 비용 */
  levelCosts: readonly number[];
  /** 게스트는 null */
  points: UserPoints | null;
  slots: { slot: TetrisSkinSlot; items: { id: string; unlock: SkinItem['unlock']; owned: boolean; equipped: boolean; level: number }[] }[];
}

export interface UserSkins {
  equipped: TetrisSkinSet;
  /** 장착한 아이템의 레벨 — 화면 배경은 이 값으로, 보드 슬롯은 남의 화면에도 이 값으로 그린다 */
  equippedLevels: TetrisSkinLevels;
  points: UserPoints;
  catalog: Record<TetrisSkinSlot, SkinCatalogEntry[]>;
}

/** 사용자 한 명의 강화 레벨 — 키 `${슬롯 키}:${아이템 id}`, 없는 키는 Lv1 */
type LevelBook = Map<string, number>;

const levelKey = (slot: TetrisSkinSlot, skinId: string) => `${TETRIS_SKIN_SLOT_KEYS[slot]}:${skinId}`;
const levelIn = (book: LevelBook | undefined, slot: TetrisSkinSlot, skinId: string) => book?.get(levelKey(slot, skinId)) ?? SKIN_MIN_LEVEL;

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
    @InjectRepository(UserSkinLevel)
    private readonly levelRepository: Repository<UserSkinLevel>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly userPointService: UserPointService,
  ) {}

  async getSkins(userId: number): Promise<UserSkins> {
    const equipped = await this.equippedOf(userId);
    const book = (await this.levelBooksOf([userId])).get(userId);
    return {
      equipped,
      equippedLevels: this.levelsOfSet(equipped, book),
      points: await this.userPointService.pointsOf(userId),
      catalog: this.catalogFor(userId, book),
    };
  }

  /**
   * 한 단계 강화 (docs/tasks/skin-levels D-002) — level은 목표 레벨. 이미 그 레벨 이상이면 차감 없이 지금 상태를 돌려준다(중복 클릭).
   * 사용자 행을 잠가 같은 사용자의 강화를 줄 세운다 — 다른 아이템을 동시에 강화해도 잔액을 넘겨 쓰지 않는다
   */
  async upgrade(userId: number, slot: TetrisSkinSlot, skinId: string, level: number): Promise<UserSkins> {
    const item = findSkinItem(slot, skinId);
    if (!item) throw new UserSkinUnknownErrorResponseDto({ details: { slot, id: skinId } });
    if (!this.isOwned(userId, item)) throw new UserSkinNotOwnedErrorResponseDto({ details: { slot, id: skinId } });

    await this.dataSource.transaction(async (manager) => {
      // findOne/take를 쓰지 않는다 — Oracle은 row-limit 절과 FOR UPDATE를 함께 쓸 수 없다(ORA-02014)
      const locked = await manager
        .createQueryBuilder(User, 'user')
        .select('user.userId')
        .setLock('pessimistic_write')
        .where('user.userId = :userId', { userId })
        .getMany();
      if (locked.length === 0) throw new UserNotFoundErrorResponseDto();

      const slotKey = TETRIS_SKIN_SLOT_KEYS[slot];
      const levels = manager.getRepository(UserSkinLevel);
      const current = (await levels.findOneBy({ userId, slot: slotKey, skinId }))?.level ?? SKIN_MIN_LEVEL;
      if (level <= current) return;
      const cost = level === current + 1 ? nextLevelCost(current) : null;
      if (cost === null) throw new UserSkinLevelMismatchErrorResponseDto({ details: { slot, id: skinId, level: current } });

      const { balance } = await this.userPointService.pointsOf(userId, manager);
      if (balance < cost) throw new UserPointsInsufficientErrorResponseDto({ details: { balance, cost } });

      await this.userPointService.record(manager, {
        userId,
        amount: -cost,
        reason: USER_POINT_REASONS.SKIN_UPGRADE,
        refKey: `${slotKey}:${skinId}:${level}`,
        memo: `${slot} ${skinId} Lv${level} 강화`,
      });
      await levels.save(levels.create({ userId, slot: slotKey, skinId, level, updatedAt: new Date() }));
    });
    return this.getSkins(userId);
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
    // 여러 슬롯을 한 번에 바꾸면 전부 반영되거나 하나도 반영되지 않게
    await this.dataSource.transaction(async (manager) => {
      for (const { slot, id } of entries) {
        await this.saveEquip(manager, userId, TETRIS_SKIN_SLOT_KEYS[slot], id);
      }
    });
    return this.getSkins(userId);
  }

  /** 도감 — 게스트(null)는 보유·장착 false, 레벨 1, 포인트 null(보유·레벨은 계정 기준). 로그인이면 장착·레벨·포인트를 읽는다 */
  async collection(userId: number | null): Promise<SkinCollection> {
    const equipped = userId === null ? null : await this.equippedOf(userId);
    const book = userId === null ? undefined : (await this.levelBooksOf([userId])).get(userId);
    return {
      signedIn: userId !== null,
      maxLevel: SKIN_MAX_LEVEL,
      levelCosts: SKIN_LEVEL_COSTS,
      points: userId === null ? null : await this.userPointService.pointsOf(userId),
      slots: TETRIS_SKIN_SLOTS.map((slot) => ({
        slot,
        items: TETRIS_SKIN_CATALOG[slot].map((item) => ({
          id: item.id,
          unlock: item.unlock,
          owned: userId !== null && this.isOwned(userId, item),
          equipped: equipped?.[slot] === item.id,
          level: levelIn(book, slot, item.id),
        })),
      })),
    };
  }

  /** 장착 세트 — 행 없는 슬롯·카탈로그에서 빠진 아이템은 default */
  async equippedOf(userId: number | null): Promise<TetrisSkinSet> {
    if (userId === null) return defaultSkinSet();
    return (await this.equippedOfMany([userId])).get(userId) ?? defaultSkinSet();
  }

  /** 보드 주인 스킨 — 보드 슬롯(block·effect·board)과 그 레벨. null(게스트·익명 기록)은 default Lv1 */
  async boardSkinsOf(userId: number | null): Promise<TetrisBoardSkins> {
    if (userId === null) return toBoardSkins(defaultSkinSet());
    return (await this.boardSkinsOfMany([userId])).get(userId) ?? toBoardSkins(defaultSkinSet());
  }

  /** 여러 보드 주인의 보드 스킨을 한 번에 — 결과에 없는 userId(게스트 포함)는 호출 쪽이 default로 본다 */
  async boardSkinsOfMany(userIds: readonly (number | null)[]): Promise<Map<number, TetrisBoardSkins>> {
    const sets = await this.equippedOfMany(userIds);
    const books = await this.levelBooksOf([...sets.keys()]);
    return new Map([...sets].map(([userId, set]) => [userId, toBoardSkins(set, this.levelsOfSet(set, books.get(userId)))]));
  }

  /** 장착 세트의 슬롯별 레벨 */
  private levelsOfSet(set: TetrisSkinSet, book: LevelBook | undefined): TetrisSkinLevels {
    const levels = defaultSkinLevels();
    for (const slot of TETRIS_SKIN_SLOTS) levels[slot] = levelIn(book, slot, set[slot]);
    return levels;
  }

  /** 사용자별 강화 레벨 — 강화하지 않은 사용자는 결과에 없다(모두 Lv1) */
  private async levelBooksOf(userIds: readonly number[]): Promise<Map<number, LevelBook>> {
    const books = new Map<number, LevelBook>();
    if (userIds.length === 0) return books;
    const rows = await this.levelRepository.find({
      select: { userId: true, slot: true, skinId: true, level: true },
      where: { userId: In([...userIds]) },
    });
    for (const row of rows) {
      const book = books.get(row.userId) ?? new Map<string, number>();
      book.set(`${row.slot}:${row.skinId}`, row.level);
      books.set(row.userId, book);
    }
    return books;
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

  private catalogFor(userId: number, book: LevelBook | undefined): Record<TetrisSkinSlot, SkinCatalogEntry[]> {
    const entries = (slot: TetrisSkinSlot) =>
      TETRIS_SKIN_CATALOG[slot].map((item) => {
        const level = levelIn(book, slot, item.id);
        return { id: item.id, unlock: item.unlock, owned: this.isOwned(userId, item), level, nextCost: nextLevelCost(level) };
      });
    return { block: entries('block'), effect: entries('effect'), board: entries('board'), background: entries('background') };
  }

  /** 지금은 default·free뿐이라 모두 보유 — 업적·출석 아이템은 획득 기록 테이블과 함께 여기서 판정한다 */
  private isOwned(_userId: number, item: SkinItem): boolean {
    return item.unlock === 'default' || item.unlock === 'free';
  }

  /**
   * 행이 없으면 만들고 있으면 바꾼다 — 같은 슬롯의 첫 장착이 동시에 오면 늦은 INSERT가 PK 충돌하므로 UPDATE로 다시 한다.
   * Oracle은 실패한 문장만 되돌리고 트랜잭션은 이어 가므로 같은 트랜잭션에서 다시 UPDATE할 수 있다
   */
  private async saveEquip(manager: EntityManager, userId: number, slot: string, skinId: string): Promise<void> {
    const repository = manager.getRepository(UserSkinEquip);
    const values = { skinId, updatedAt: new Date() };
    const { affected } = await repository.update({ userId, slot }, values);
    if (affected) return;
    try {
      await repository.insert({ userId, slot, ...values });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await repository.update({ userId, slot }, values);
    }
  }
}

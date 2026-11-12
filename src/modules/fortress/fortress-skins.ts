import { DEFAULT_SKIN_ID, SKIN_MAX_LEVEL, SKIN_MIN_LEVEL, type SkinItem } from '../users/skin-catalog';
import type { FortressTankSkin } from './fortress.events';

/**
 * 포트리스 탱크 스킨 카탈로그 — 서버가 SSOT (docs/tasks/fortress DESIGN §13, D-003).
 * 저장은 테트리스 스킨과 같은 표(USER_SKIN_EQUIPS·USER_SKIN_LEVELS)에 슬롯 키 `FORTRESS_TANK`로 — 아이템을 늘려도 DB 변경이 없다.
 * 레벨(Lv1~5)·강화 비용은 테트리스와 같은 `SKIN_LEVEL_COSTS`. 프론트는 id별 시각 자료만 갖고 모르는 id는 default로 그린다(계약 FortressTankSkin)
 */

/** API 슬롯 이름(에러 details·메모) */
export const FORTRESS_TANK_SLOT = 'tank';
/** DB `USER_SKIN_EQUIPS.SLOT`·`USER_SKIN_LEVELS.SLOT` 값 — 게임 접두로 테트리스 슬롯과 섞이지 않게 */
export const FORTRESS_TANK_SLOT_KEY = 'FORTRESS_TANK';

/** default = 출시 때 모습. 나머지는 누구나 장착(획득 방식이 생기면 SkinUnlock과 함께) */
export const FORTRESS_TANK_SKINS: readonly SkinItem[] = [
  { id: DEFAULT_SKIN_ID, unlock: 'default' },
  { id: 'desert', unlock: 'free' },
  { id: 'arctic', unlock: 'free' },
  { id: 'neon', unlock: 'free' },
];

export function findTankSkin(id: string): SkinItem | undefined {
  return FORTRESS_TANK_SKINS.find((item) => item.id === id);
}

/** 기본 탱크 스킨 — 게스트·장착 없음·카탈로그에서 빠진 아이템 */
export function defaultTankSkin(): FortressTankSkin {
  return { id: DEFAULT_SKIN_ID, level: SKIN_MIN_LEVEL };
}

/**
 * 저장해 둔 탱크 스킨(Redis 방·경기, 리플레이 본문) — 없거나 형식이 다르면 default(F7 전에 저장된 값).
 * 아이템 id는 카탈로그와 대조하지 않는다: 당시 장착을 그대로 보여 주고, 모르는 id는 프론트가 default로 그린다
 */
export function storedTankSkin(value: unknown): FortressTankSkin {
  if (typeof value !== 'object' || value === null) return defaultTankSkin();
  const { id, level } = value as Partial<Record<keyof FortressTankSkin, unknown>>;
  if (typeof id !== 'string' || id.length === 0) return defaultTankSkin();
  const validLevel = typeof level === 'number' && Number.isInteger(level) && level >= SKIN_MIN_LEVEL && level <= SKIN_MAX_LEVEL;
  return { id, level: validLevel ? level : SKIN_MIN_LEVEL };
}

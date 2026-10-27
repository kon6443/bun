/**
 * 테트리스 스킨 카탈로그 — 서버가 SSOT (docs/tasks/tetris-skins D-003).
 * 아이템 id·슬롯·획득 방식을 여기서 정하고, 프론트는 id별 시각 자료만 가진다(모르는 id는 default로 그린다).
 *
 * 슬롯은 따로 장착한다. 보드 슬롯(block·effect·board)은 그 보드 주인의 것으로, background는 보는 사람 자신의 것으로 그린다.
 * 아이템을 추가할 때 DB 변경은 없다(USER_SKIN_EQUIPS는 문자열 id를 저장). 업적·출석 획득은 획득 기록 테이블과 함께
 * `SkinUnlock`에 종류를 더하고 `UserSkinService.isOwned`에서 판정한다
 */

/** API 키 순서 = 장착 화면 탭 순서 */
export const TETRIS_SKIN_SLOTS = ['block', 'effect', 'board', 'background'] as const;
export type TetrisSkinSlot = (typeof TETRIS_SKIN_SLOTS)[number];

/** 보드에 그려지는 슬롯 — 남의 화면에서도 보드 주인 것으로 그린다 */
export const TETRIS_BOARD_SKIN_SLOTS = ['block', 'effect', 'board'] as const satisfies readonly TetrisSkinSlot[];
export type TetrisBoardSkinSlot = (typeof TETRIS_BOARD_SKIN_SLOTS)[number];

/** DB `USER_SKIN_EQUIPS.SLOT` 값 — 게임 접두를 붙여 다른 게임 슬롯과 섞이지 않게 */
export const TETRIS_SKIN_SLOT_KEYS: Record<TetrisSkinSlot, string> = {
  block: 'TETRIS_BLOCK',
  effect: 'TETRIS_EFFECT',
  board: 'TETRIS_BOARD',
  background: 'TETRIS_BACKGROUND',
};

/** 획득 방식 — default: 처음부터 장착, free: 누구나 장착. 업적·출석은 그 기능과 함께 추가 */
export type SkinUnlock = 'default' | 'free';

export interface SkinItem {
  id: string;
  unlock: SkinUnlock;
}

export const DEFAULT_SKIN_ID = 'default';

/** 처음 아이템 — 슬롯마다 같은 테마 4종(섞어 쓰기 가능). default = 출시 때의 인게임 UI */
const STARTER_ITEMS: readonly SkinItem[] = [
  { id: DEFAULT_SKIN_ID, unlock: 'default' },
  { id: 'gameboy', unlock: 'free' },
  { id: 'neon', unlock: 'free' },
  { id: 'high-contrast', unlock: 'free' },
  // 투명·초콜릿 (docs/tasks/skin-levels D-001)
  { id: 'clear', unlock: 'free' },
  { id: 'chocolate', unlock: 'free' },
];

export const TETRIS_SKIN_CATALOG: Record<TetrisSkinSlot, readonly SkinItem[]> = {
  block: STARTER_ITEMS,
  effect: STARTER_ITEMS,
  board: STARTER_ITEMS,
  background: STARTER_ITEMS,
};

/**
 * 레벨 (docs/tasks/skin-levels D-001·D-002) — 모든 아이템 Lv1~Lv5, Lv1 = 처음 모습. 포인트를 써서 한 단계씩 올린다.
 * 비용을 바꾸면 이후 강화에만 적용된다(이미 쓴 포인트는 원장에 남은 그대로)
 */
export const SKIN_MIN_LEVEL = 1;
export const SKIN_MAX_LEVEL = 5;
/** [i] = Lv(i+1) → Lv(i+2) 비용. 누적 Lv2 10만 · Lv3 30만 · Lv4 100만 · Lv5 300만 */
export const SKIN_LEVEL_COSTS: readonly number[] = [100_000, 200_000, 700_000, 2_000_000];

/** 지금 레벨에서 한 단계 올리는 비용 — 만렙이면 null */
export function nextLevelCost(level: number): number | null {
  return SKIN_LEVEL_COSTS[level - SKIN_MIN_LEVEL] ?? null;
}

export type TetrisSkinSet = Record<TetrisSkinSlot, string>;
export type TetrisSkinLevels = Record<TetrisSkinSlot, number>;
export type TetrisBoardSkinLevels = Record<TetrisBoardSkinSlot, number>;
/** 보드를 그릴 스킨 — 슬롯별 아이템 id + 그 아이템의 레벨 */
export type TetrisBoardSkins = Record<TetrisBoardSkinSlot, string> & { levels: TetrisBoardSkinLevels };

export function findSkinItem(slot: TetrisSkinSlot, id: string): SkinItem | undefined {
  return TETRIS_SKIN_CATALOG[slot].find((item) => item.id === id);
}

/** 모든 슬롯 default — 게스트·익명 기록·장착하지 않은 슬롯 */
export function defaultSkinSet(): TetrisSkinSet {
  return { block: DEFAULT_SKIN_ID, effect: DEFAULT_SKIN_ID, board: DEFAULT_SKIN_ID, background: DEFAULT_SKIN_ID };
}

/** 모든 슬롯 Lv1 */
export function defaultSkinLevels(): TetrisSkinLevels {
  return { block: SKIN_MIN_LEVEL, effect: SKIN_MIN_LEVEL, board: SKIN_MIN_LEVEL, background: SKIN_MIN_LEVEL };
}

export function toBoardSkins(set: TetrisSkinSet, levels: TetrisSkinLevels = defaultSkinLevels()): TetrisBoardSkins {
  return {
    block: set.block,
    effect: set.effect,
    board: set.board,
    levels: { block: levels.block, effect: levels.effect, board: levels.board },
  };
}

/**
 * 방 상태(Redis)에 저장해 둔 보드 스킨 — 없으면(스킨 기능 전 자리) default, 레벨 기능 전에 저장된 값(levels 없음)은 Lv1로 채운다.
 * 배포 순간 열려 있던 방도 계약대로 levels를 싣게
 */
export function storedBoardSkins(skins: TetrisBoardSkins | undefined): TetrisBoardSkins {
  if (!skins) return toBoardSkins(defaultSkinSet());
  // 타입은 levels를 갖지만 배포 전 저장값에는 없다
  const { levels } = skins as Partial<TetrisBoardSkins>;
  return levels ? skins : { ...skins, levels: toBoardSkins(defaultSkinSet()).levels };
}

/** 저장해 둔 레벨 하나 — 정수 1~5가 아니면(레벨 기능 전 기록 포함) Lv1 */
function parseLevel(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= SKIN_MIN_LEVEL && value <= SKIN_MAX_LEVEL ? value : SKIN_MIN_LEVEL;
}

/**
 * 저장해 둔 보드 스킨(JSON 문자열) → 객체. 비었거나 형식이 다르면 null — 호출 쪽이 default로 본다. 레벨이 없으면 Lv1.
 * 아이템 id는 카탈로그와 대조하지 않는다: 당시 장착을 그대로 보여 주고, 모르는 id는 프론트가 default로 그린다
 */
export function parseBoardSkins(json: string | null | undefined): TetrisBoardSkins | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<Record<TetrisBoardSkinSlot | 'levels', unknown>>;
    const { block, effect, board } = value;
    if (typeof block !== 'string' || typeof effect !== 'string' || typeof board !== 'string') return null;
    // 레벨은 skin-levels 이후 기록부터 있다 — 없거나 깨졌으면 Lv1
    const levels = (typeof value.levels === 'object' && value.levels !== null ? value.levels : {}) as Partial<Record<TetrisBoardSkinSlot, unknown>>;
    return { block, effect, board, levels: { block: parseLevel(levels.block), effect: parseLevel(levels.effect), board: parseLevel(levels.board) } };
  } catch {
    return null;
  }
}

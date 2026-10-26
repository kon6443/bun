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
];

export const TETRIS_SKIN_CATALOG: Record<TetrisSkinSlot, readonly SkinItem[]> = {
  block: STARTER_ITEMS,
  effect: STARTER_ITEMS,
  board: STARTER_ITEMS,
  background: STARTER_ITEMS,
};

export type TetrisSkinSet = Record<TetrisSkinSlot, string>;
export type TetrisBoardSkins = Record<TetrisBoardSkinSlot, string>;

export function findSkinItem(slot: TetrisSkinSlot, id: string): SkinItem | undefined {
  return TETRIS_SKIN_CATALOG[slot].find((item) => item.id === id);
}

/** 모든 슬롯 default — 게스트·익명 기록·장착하지 않은 슬롯 */
export function defaultSkinSet(): TetrisSkinSet {
  return { block: DEFAULT_SKIN_ID, effect: DEFAULT_SKIN_ID, board: DEFAULT_SKIN_ID, background: DEFAULT_SKIN_ID };
}

export function toBoardSkins(set: TetrisSkinSet): TetrisBoardSkins {
  return { block: set.block, effect: set.effect, board: set.board };
}

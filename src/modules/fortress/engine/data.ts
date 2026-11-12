/**
 * 탱크·무기 데이터 (§2 — 1차 3종, 기본 무기 2 + 필살기 1). 수치는 F1 플레이 테스트로 조정한다(바꾸면 ENGINE_VERSION)
 */

/**
 * 무기 동작
 * - shell: 탄 count발을 spreadDeg 간격으로 부채꼴 발사, 닿으면 폭발
 * - split: 최고점(위로 가다 내려오기 시작한 틱)에서 자탄 count발로 갈라진다. 갈라지기 전에 닿으면 자탄 하나 크기(radius·damage)로 터진다
 * - strike: 닿은 자리 위 월드 꼭대기에서 폭탄 count발을 spacingPx 간격으로 떨어뜨린다
 */
export type WeaponKind = 'shell' | 'split' | 'strike';

export type Weapon = {
  id: number;
  name: string;
  kind: WeaponKind;
  /** 폭발 반지름(px) */
  radius: number;
  /** 중심 피해 — 거리 비례로 줄어든다 */
  damage: number;
  /** 발사 속도 ‰ (무거운 탄은 느리다) */
  speedPermille: number;
  count: number;
  /** shell: 부채꼴 간격(도) */
  spreadDeg: number;
  /** split: 자탄 가로 속도 간격(SUB/틱) · strike: 폭탄 간격(px) */
  spacing: number;
  /** 자탄·폭탄 폭발 */
  childRadius: number;
  childDamage: number;
  /** 0이면 기본 무기, 아니면 필살기 — 쓰고 나서 자기 턴 이 횟수 동안 못 쓴다 */
  cooldown: number;
};

const weapon = (w: Omit<Weapon, 'spreadDeg' | 'spacing' | 'childRadius' | 'childDamage' | 'count' | 'cooldown'> & Partial<Weapon>): Weapon => ({
  count: 1,
  spreadDeg: 0,
  spacing: 0,
  childRadius: 0,
  childDamage: 0,
  cooldown: 0,
  ...w,
});

export const WEAPONS: readonly Weapon[] = [
  weapon({ id: 0, name: '포탄', kind: 'shell', radius: 36, damage: 30, speedPermille: 1000 }),
  weapon({ id: 1, name: '3연발', kind: 'shell', radius: 28, damage: 18, speedPermille: 1000, count: 3, spreadDeg: 2 }),
  weapon({ id: 2, name: '대형탄', kind: 'shell', radius: 56, damage: 40, speedPermille: 880 }),
  weapon({ id: 3, name: '분열탄', kind: 'split', radius: 30, damage: 16, speedPermille: 1000, count: 5, spacing: 700, childRadius: 30, childDamage: 16, cooldown: 3 }),
  weapon({ id: 4, name: '메가탄', kind: 'shell', radius: 90, damage: 50, speedPermille: 800, cooldown: 4 }),
  weapon({ id: 5, name: '폭격', kind: 'strike', radius: 20, damage: 10, speedPermille: 1000, count: 5, spacing: 40, childRadius: 32, childDamage: 20, cooldown: 4 }),
];

export type TankKind = {
  id: number;
  name: string;
  hp: number;
  /** 턴마다 다시 채우는 이동 연료(px) */
  fuel: number;
  /** [기본 무기, 기본 무기, 필살기] */
  weapons: readonly [number, number, number];
};

export const TANKS: readonly TankKind[] = [
  { id: 0, name: '캐논', hp: 120, fuel: 100, weapons: [0, 2, 4] },
  { id: 1, name: '미사일', hp: 100, fuel: 120, weapons: [0, 1, 3] },
  { id: 2, name: '정찰', hp: 90, fuel: 160, weapons: [0, 1, 5] },
];

export const MAP_IDS = ['hills', 'canyon'] as const;
export type MapId = (typeof MAP_IDS)[number];

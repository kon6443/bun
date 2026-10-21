/**
 * 맵 데이터 — 세로 9×15칸 고정(D-021), 1칸 = 1000 밀리타일, 좌표는 왼쪽 위 원점·y 아래로 증가
 * 경로는 정수 웨이포인트 폴리라인 + 구간 길이(정수, 사전 계산 — 런타임 sqrt 없음, §E1). 슬롯 중심 간격 ≥ 1.1칸(§F10)
 * 원본·동기화 규칙은 ../constants.ts 머리 주석
 */

export type MapPath = {
  /** [x0, y0, x1, y1, ...] 밀리타일 */
  points: readonly number[];
  /** 구간 i(점 i → i+1) 길이 — 데이터 테스트가 점 좌표와 맞는지 확인한다 */
  segmentLengths: readonly number[];
  total: number;
};

export type MapSlot = { x: number; y: number };

export type GameMap = {
  id: string;
  width: number;
  height: number;
  groundPaths: readonly MapPath[];
  /** 공중 경로 — E1은 자리만(S4부터) */
  airPaths: readonly MapPath[];
  /** 인덱스 = slotId */
  slots: readonly MapSlot[];
};

/** E1 시험 맵 — 위에서 들어와 지그재그로 아래로 나간다. 축 정렬 구간이라 길이 = |dx| + |dy| */
export const MAP_E1: GameMap = {
  id: 'e1',
  width: 9000,
  height: 15000,
  groundPaths: [
    {
      points: [1500, 0, 1500, 4500, 7500, 4500, 7500, 9500, 1500, 9500, 1500, 13000, 4500, 13000, 4500, 15000],
      segmentLengths: [4500, 6000, 5000, 6000, 3500, 3000, 2000],
      total: 30000,
    },
  ],
  airPaths: [],
  slots: [
    { x: 3500, y: 3000 },
    { x: 5500, y: 3000 },
    { x: 3000, y: 7000 },
    { x: 4500, y: 6500 },
    { x: 6000, y: 7000 },
    { x: 3000, y: 11500 },
    { x: 6000, y: 11500 },
    { x: 6000, y: 14000 },
  ],
};

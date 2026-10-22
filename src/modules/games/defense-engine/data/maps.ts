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

/** locked = 처음엔 막힌 슬롯 — 증강 "개척"으로 연다(무한 맵 2개, §L10) */
export type MapSlot = { x: number; y: number; locked?: boolean };

export type GameMap = {
  id: string;
  width: number;
  height: number;
  groundPaths: readonly MapPath[];
  /** 공중 경로 — 없으면 공중 적도 지상 경로를 쓴다 */
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

/**
 * E2 시험 맵 — 지상 경로 2갈래(좌·우 대칭 지그재그, 아래에서 합류) + 공중 직선 경로 + 슬롯 14개(잠긴 2개)
 * 다중 경로 타게팅("선두" = 출구까지 남은 거리가 짧은 적, D-025)과 공중·잠긴 슬롯을 시험한다. 캠페인·무한 맵은 S1
 */
export const MAP_E2: GameMap = {
  id: 'e2',
  width: 9000,
  height: 15000,
  groundPaths: [
    {
      points: [1500, 0, 1500, 6000, 3500, 6000, 3500, 12000, 4500, 12000, 4500, 15000],
      segmentLengths: [6000, 2000, 6000, 1000, 3000],
      total: 18000,
    },
    {
      points: [7500, 0, 7500, 6000, 5500, 6000, 5500, 12000, 4500, 12000, 4500, 15000],
      segmentLengths: [6000, 2000, 6000, 1000, 3000],
      total: 18000,
    },
  ],
  airPaths: [{ points: [4500, 0, 4500, 15000], segmentLengths: [15000], total: 15000 }],
  slots: [
    { x: 3000, y: 2500 },
    { x: 6000, y: 2500 },
    { x: 3000, y: 4500 },
    { x: 6000, y: 4500 },
    { x: 2000, y: 8000 },
    { x: 7000, y: 8000 },
    { x: 4500, y: 8000 },
    { x: 2000, y: 10500 },
    { x: 7000, y: 10500 },
    { x: 4500, y: 10000 },
    { x: 2500, y: 13500 },
    { x: 6500, y: 13500 },
    { x: 4500, y: 4000, locked: true },
    { x: 4500, y: 1500, locked: true },
  ],
};

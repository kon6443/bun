/**
 * 낚시 소켓 이벤트 빈도 제한 — 소켓 단위 고정 윈도 (docs/tasks/refactor-perf-survey-2026-11 A2)
 *
 * 이동·상태 이벤트는 같은 맵 전원에게 팬아웃되므로 클라이언트 스로틀만 믿으면 한 소켓이 맵 전체를 흔들 수 있다.
 * 소켓은 한 레플리카에 붙어 있으므로 윈도 상태를 소켓 데이터에 둔다(레플리카 간 공유 상태가 아니다).
 * Redis 카운터를 쓰지 않는 이유: 이동은 초당 수십 건이라 이벤트마다 왕복을 더하면 제한 자체가 비용이 된다.
 *
 * 한도는 프론트 정상 입력의 2배 이상으로 잡는다(초과분은 조용히 버린다 — 정상 사용자는 닿지 않는다).
 */
export type FishingRateAction = 'move' | 'state' | 'chat' | 'catch';

export type FishingRateWindows = Partial<Record<FishingRateAction, { start: number; count: number }>>;

export const FISHING_RATE_LIMITS: Readonly<Record<FishingRateAction, { readonly limit: number; readonly windowMs: number }>> = {
  /** 프론트 50ms 스로틀(최대 20회/초)의 2배 */
  move: { limit: 40, windowMs: 1_000 },
  /** 한 판에 최대 4회(casting → challenge → success/fail → idle), 캐스팅 취소 반복도 사람 클릭 속도 안 */
  state: { limit: 10, windowMs: 1_000 },
  /** 프론트 제한 없음 — 사람 입력 속도 기준 */
  chat: { limit: 10, windowMs: 10_000 },
  /** 한 판(캐스팅 0.8초 + 대기 최소 2초)에 1회 */
  catch: { limit: 5, windowMs: 10_000 },
};

/** 한도 안이면 true. windows는 소켓마다 하나 — 호출자가 소켓 데이터에 보관한다 */
export function consumeFishingRate(windows: FishingRateWindows, action: FishingRateAction, now: number): boolean {
  const { limit, windowMs } = FISHING_RATE_LIMITS[action];
  const current = windows[action];
  if (!current || now - current.start >= windowMs) {
    windows[action] = { start: now, count: 1 };
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

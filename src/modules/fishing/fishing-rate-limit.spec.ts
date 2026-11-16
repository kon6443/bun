import { consumeFishingRate, FISHING_RATE_LIMITS, FishingRateWindows } from './fishing-rate-limit';

describe('consumeFishingRate', () => {
  it('윈도 안에서 한도까지 통과하고 넘으면 거부한다', () => {
    const windows: FishingRateWindows = {};
    const { limit } = FISHING_RATE_LIMITS.move;
    for (let i = 0; i < limit; i++) {
      expect(consumeFishingRate(windows, 'move', 1_000)).toBe(true);
    }
    expect(consumeFishingRate(windows, 'move', 1_500)).toBe(false);
  });

  it('윈도가 지나면 다시 센다', () => {
    const windows: FishingRateWindows = {};
    const { limit, windowMs } = FISHING_RATE_LIMITS.chat;
    for (let i = 0; i <= limit; i++) consumeFishingRate(windows, 'chat', 0);
    expect(consumeFishingRate(windows, 'chat', windowMs - 1)).toBe(false);
    expect(consumeFishingRate(windows, 'chat', windowMs)).toBe(true);
  });

  it('액션마다 따로 센다', () => {
    const windows: FishingRateWindows = {};
    for (let i = 0; i <= FISHING_RATE_LIMITS.catch.limit; i++) consumeFishingRate(windows, 'catch', 0);
    expect(consumeFishingRate(windows, 'catch', 0)).toBe(false);
    expect(consumeFishingRate(windows, 'move', 0)).toBe(true);
  });

  it('프론트 정상 이동 빈도(50ms 스로틀 = 20회/초)는 거부되지 않는다', () => {
    const windows: FishingRateWindows = {};
    for (let t = 0; t < 5_000; t += 50) {
      expect(consumeFishingRate(windows, 'move', t)).toBe(true);
    }
  });
});

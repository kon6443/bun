import { LocalGateHold } from './game-room-presence';

describe('LocalGateHold', () => {
  it('잡은 게이트는 간격에서 여유(기본 500ms)를 뺀 동안 살아 있다고 본다', () => {
    const hold = new LocalGateHold(5_000);
    hold.markAcquired('ROOM1', 0);
    expect(hold.isHeld('ROOM1', 4_499)).toBe(true);
    expect(hold.isHeld('ROOM1', 4_500)).toBe(false);
  });

  it('잡지 않은 키는 막지 않는다 — 실패한 시도는 기억하지 않으므로 다음 하트비트에 다시 시도한다', () => {
    const hold = new LocalGateHold(5_000);
    expect(hold.isHeld('ROOM1', 0)).toBe(false);
  });

  it('키마다 따로 센다', () => {
    const hold = new LocalGateHold(5_000);
    hold.markAcquired('ROOM1', 0);
    expect(hold.isHeld('ROOM2', 0)).toBe(false);
  });

  it('항목이 상한을 넘으면 간격이 지난 키만 지운다 (끝난 방이 쌓이지 않게, 살아 있는 기억은 유지)', () => {
    const hold = new LocalGateHold(1_000, 2);
    hold.markAcquired('OLD', 0);
    hold.markAcquired('LIVE', 1_500);
    hold.markAcquired('NEW', 2_000);
    const keys = [...(hold as unknown as { acquiredAt: Map<string, number> }).acquiredAt.keys()];
    expect(keys.sort()).toEqual(['LIVE', 'NEW']);
    expect(hold.isHeld('LIVE', 1_900)).toBe(true);
  });
});

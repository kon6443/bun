import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createGameRoomKeys } from './game-room-keys';
import { GameRoomRateLimiter } from './game-room-rate-limit';
import { acquireIntervalGate, touchHeartbeat } from './game-room-presence';

describe('GameRoomRateLimiter', () => {
  const counters = new Map<string, number>();
  const expire = jest.fn();
  const redis = {
    multi: jest.fn(() => {
      let key = '';
      const chain = {
        incr: (k: string) => ((key = k), chain),
        expire: (k: string, sec: number, mode: string) => (expire(k, sec, mode), chain),
        exec: async () => {
          counters.set(key, (counters.get(key) ?? 0) + 1);
          return [[null, counters.get(key)], [null, 1]];
        },
      };
      return chain;
    }),
  };
  const limiter = new GameRoomRateLimiter(createGameRoomKeys('tetris-battle:'), { chat: { limit: 2, windowSec: 5 } }, new Logger('test'));

  beforeEach(() => {
    counters.clear();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('키 {prefix}rl:{action}:{subject}로 세고, 한도까지 true 그 뒤 false', async () => {
    const r = redis as unknown as Redis;
    await expect(limiter.consume(r, 'chat', 'ABC234:p1')).resolves.toBe(true);
    await expect(limiter.consume(r, 'chat', 'ABC234:p1')).resolves.toBe(true);
    await expect(limiter.consume(r, 'chat', 'ABC234:p1')).resolves.toBe(false);
    expect(counters.get('tetris-battle:rl:chat:ABC234:p1')).toBe(3);
    expect(expire).toHaveBeenCalledWith('tetris-battle:rl:chat:ABC234:p1', 5, 'NX');
  });

  it('Redis 명령이 실패하면 통과(fail-open)', async () => {
    const broken = {
      multi: () => {
        const chain = { incr: () => chain, expire: () => chain, exec: async () => Promise.reject(new Error('down')) };
        return chain;
      },
    } as unknown as Redis;
    await expect(limiter.consume(broken, 'chat', 'x')).resolves.toBe(true);
    expect(Logger.prototype.warn).toHaveBeenCalledWith('빈도 제한 확인 실패 — 통과: action=chat, down');
  });
});

describe('game-room-presence', () => {
  it('acquireIntervalGate: SET NX PX, OK일 때만 true', async () => {
    const set = jest.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const redis = { set } as unknown as Redis;
    await expect(acquireIntervalGate(redis, 'tetris-battle:probe:ABC234', 15_000)).resolves.toBe(true);
    await expect(acquireIntervalGate(redis, 'tetris-battle:probe:ABC234', 15_000)).resolves.toBe(false);
    expect(set).toHaveBeenCalledWith('tetris-battle:probe:ABC234', '1', 'PX', 15_000, 'NX');
  });

  it('touchHeartbeat: SET PX (NX 없음 — 매번 갱신)', async () => {
    const set = jest.fn().mockResolvedValue('OK');
    await touchHeartbeat({ set } as unknown as Redis, 'tetris-battle:hb:ABC234:s', 10_000);
    expect(set).toHaveBeenCalledWith('tetris-battle:hb:ABC234:s', '1', 'PX', 10_000);
  });
});

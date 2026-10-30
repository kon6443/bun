import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createGameRoomKeys } from './game-room-keys';
import {
  generateRoomCode,
  hashPlayerToken,
  hashRoomPassword,
  issuePlayerToken,
  playerTokenMatches,
  roomPasswordCheck,
  verifyRoomPassword,
} from './game-room-secrets';

/** INCR/DECR 카운터만 흉내 내는 MULTI 대역 */
const createRedis = () => {
  const counters = new Map<string, number>();
  const expires: [string, number][] = [];
  /** EXPIRE 모드 인자 — 'NX'가 빠지면 고정 윈도가 시도마다 늘어나는 윈도로 바뀐다 */
  const expireModes: (string | undefined)[] = [];
  const multi = () => {
    const ops: (() => [null, number])[] = [];
    const chain = {
      incr: (key: string) => (ops.push(() => { counters.set(key, (counters.get(key) ?? 0) + 1); return [null, counters.get(key) as number]; }), chain),
      decr: (key: string) => (ops.push(() => { counters.set(key, (counters.get(key) ?? 0) - 1); return [null, counters.get(key) as number]; }), chain),
      expire: (key: string, sec: number, mode?: string) => (ops.push(() => { expires.push([key, sec]); expireModes.push(mode); return [null, 1]; }), chain),
      exec: async () => ops.map((op) => op()),
    };
    return chain;
  };
  return { counters, expires, expireModes, redis: { multi: jest.fn(multi) } as unknown as Redis };
};

describe('game-room-secrets', () => {
  const keys = createGameRoomKeys('fortress:');
  const limits = { socket: { maxFailures: 2, windowSec: 60 }, ip: { maxFailures: 3, windowSec: 30 } };
  const logger = new Logger('test');

  afterEach(() => jest.restoreAllMocks());

  it('generateRoomCode: 받은 문자표·길이로 만든다', () => {
    const code = generateRoomCode('AB', 8);
    expect(code).toMatch(/^[AB]{8}$/);
  });

  it('issuePlayerToken: 바이트 수대로 base64url, 해시는 sha256 hex이고 대조된다', () => {
    const { token, tokenHash } = issuePlayerToken(24);
    expect(Buffer.from(token, 'base64url')).toHaveLength(24);
    expect(tokenHash).toBe(hashPlayerToken(token));
    expect(playerTokenMatches(tokenHash, hashPlayerToken(token))).toBe(true);
    expect(playerTokenMatches(tokenHash, hashPlayerToken('other'))).toBe(false);
    expect(playerTokenMatches(tokenHash, 'abcd')).toBe(false); // 길이가 다르면 false(throw 없음)
  });

  it('hashRoomPassword → roomPasswordCheck 왕복, 형식이 다르면 false', async () => {
    const stored = await hashRoomPassword('pw', { saltBytes: 16, keyLength: 64 });
    expect(stored).toMatch(/^scrypt\$[^$]+\$[^$]+$/);
    await expect(roomPasswordCheck.matches('pw', stored)).resolves.toBe(true);
    await expect(roomPasswordCheck.matches('nope', stored)).resolves.toBe(false);
    await expect(roomPasswordCheck.matches('pw', 'plain')).resolves.toBe(false);
  });

  describe('verifyRoomPassword', () => {
    const who = { socketId: 'sock-1', ip: '203.0.113.50' };

    it('정답이면 OK + 예약한 시도를 되돌린다(접두사 키, 윈도는 한도 표 값)', async () => {
      const { redis, counters, expires } = createRedis();
      const stored = await hashRoomPassword('pw', { saltBytes: 16, keyLength: 64 });
      await expect(verifyRoomPassword(redis, keys, limits, 'ABC234', stored, 'pw', who, logger)).resolves.toBe('OK');
      expect(counters.get('fortress:pwfail:ABC234:sock-1')).toBe(0);
      expect(counters.get('fortress:pwfail-ip:ABC234:203.0.113.50')).toBe(0);
      expect(expires).toContainEqual(['fortress:pwfail:ABC234:sock-1', 60]);
      expect(expires).toContainEqual(['fortress:pwfail-ip:ABC234:203.0.113.50', 30]);
    });

    it('시도 예약·복원의 EXPIRE는 모두 NX — 윈도 시작 때만 TTL을 건다', async () => {
      const { redis, expireModes } = createRedis();
      const stored = await hashRoomPassword('pw', { saltBytes: 16, keyLength: 64 });
      await verifyRoomPassword(redis, keys, limits, 'ABC234', stored, 'pw', who, logger);
      expect(expireModes).toEqual(['NX', 'NX', 'NX', 'NX']);
    });

    it('정답인데 시도 복원이 실패해도 OK — 경고만 남긴다', async () => {
      const { redis } = createRedis();
      const reserve = createRedis().redis.multi.bind(null);
      const stored = await hashRoomPassword('pw', { saltBytes: 16, keyLength: 64 });
      // 첫 MULTI(시도 예약)는 정상 대역, 두 번째(복원)만 실패
      const failingRestore = { decr: () => failingRestore, expire: () => failingRestore, exec: () => Promise.reject(new Error('down')) };
      (redis.multi as jest.Mock).mockImplementationOnce(reserve).mockImplementationOnce(() => failingRestore);
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await expect(verifyRoomPassword(redis, keys, limits, 'ABC234', stored, 'pw', who, logger)).resolves.toBe('OK');
      expect(warn).toHaveBeenCalledWith('비밀번호 시도 카운터 복원 실패: code=ABC234, down');
      warn.mockRestore();
    });

    it('오답·비밀번호 없음은 WRONG, 소켓 한도를 넘으면 검증 없이 LOCKED', async () => {
      const { redis } = createRedis();
      const stored = await hashRoomPassword('pw', { saltBytes: 16, keyLength: 64 });
      await expect(verifyRoomPassword(redis, keys, limits, 'ABC234', stored, 'x', who, logger)).resolves.toBe('WRONG');
      await expect(verifyRoomPassword(redis, keys, limits, 'ABC234', stored, undefined, who, logger)).resolves.toBe('WRONG');
      const verify = jest.spyOn(roomPasswordCheck, 'matches');
      await expect(verifyRoomPassword(redis, keys, limits, 'ABC234', stored, 'pw', who, logger)).resolves.toBe('LOCKED');
      expect(verify).not.toHaveBeenCalled();
    });

    it('IP 한도는 소켓을 바꿔도 이어서 센다', async () => {
      const { redis } = createRedis();
      for (let i = 0; i < 3; i++) {
        await expect(verifyRoomPassword(redis, keys, limits, 'ABC234', null, 'x', { socketId: `s${i}`, ip: who.ip }, logger)).resolves.toBe('WRONG');
      }
      await expect(verifyRoomPassword(redis, keys, limits, 'ABC234', null, 'x', { socketId: 's9', ip: who.ip }, logger)).resolves.toBe('LOCKED');
    });
  });
});

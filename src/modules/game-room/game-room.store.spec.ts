import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createGameRoomKeys } from './game-room-keys';
import { GameRoomStore, ROOM_CAS_SCRIPT } from './game-room.store';

interface TestRoom {
  code: string;
  createdAt: number;
  name: string;
}

/** 이 저장소가 쓰는 명령만 흉내 내는 최소 Redis 대역 — 인자 모양 검증용 */
const createRedis = (hashes: Record<string, Record<string, string>> = {}, zset: string[] = []) => {
  interface PipelineChain {
    hget(key: string): PipelineChain;
    exists(key: string): PipelineChain;
    exec(): Promise<[null, unknown][]>;
  }
  const pipeline = (): PipelineChain => {
    const ops: (() => unknown)[] = [];
    const chain: PipelineChain = {
      hget: (key) => (ops.push(() => hashes[key]?.json ?? null), chain),
      exists: (key) => (ops.push(() => (hashes[key] ? 1 : 0)), chain),
      exec: async () => ops.map((op): [null, unknown] => [null, op()]),
    };
    return chain;
  };
  const redis = {
    hgetall: jest.fn(async (key: string) => ({ ...(hashes[key] ?? {}) })),
    eval: jest.fn(async () => 1),
    // 최근 생성 순 = 배열 순서 그대로, 오래된 순 = 역순
    zrevrange: jest.fn(async (_key: string, start: number, stop: number) => zset.slice(start, stop + 1)),
    zrange: jest.fn(async (_key: string, start: number, stop: number) => [...zset].reverse().slice(start, stop + 1)),
    zrem: jest.fn(async (_key: string, ...codes: string[]) => codes.length),
    pipeline: jest.fn(pipeline),
    get: jest.fn(async (): Promise<string | null> => null),
    set: jest.fn(async () => 'OK'),
  };
  return redis;
};
const asRedis = (r: ReturnType<typeof createRedis>) => r as unknown as Redis;
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('GameRoomStore', () => {
  const keys = createGameRoomKeys('tetris-battle:');
  const logger = new Logger('test');
  const store = new GameRoomStore<TestRoom>(keys, 7200, logger);

  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('ROOM_CAS_SCRIPT 본문은 추출 전과 바이트 단위로 같다(옛·새 레플리카가 같은 규칙으로 쓴다)', () => {
    // 기대 해시 = 추출 전 tetris-battle-room.service.ts의 ROOM_CAS_SCRIPT 템플릿 본문(461바이트)의 sha256
    expect(ROOM_CAS_SCRIPT.length).toBe(461);
    expect(createHash('sha256').update(ROOM_CAS_SCRIPT).digest('hex')).toBe(
      'a5aa589db74d55f0d308d3119527a8aa789d07b2505ffa2aed460e63dc06341d',
    );
  });

  describe('load', () => {
    it('버전과 JSON이 있으면 둘 다 돌려준다', async () => {
      const room: TestRoom = { code: 'AAAAAA', createdAt: 1, name: 'n' };
      const redis = createRedis({ 'tetris-battle:room:AAAAAA': { v: '3', json: JSON.stringify(room) } });
      await expect(store.load(asRedis(redis), 'AAAAAA')).resolves.toEqual({ version: '3', room });
      expect(redis.hgetall).toHaveBeenCalledWith('tetris-battle:room:AAAAAA');
    });

    it('없거나 필드가 빠졌으면 null', async () => {
      const redis = createRedis({ 'tetris-battle:room:BBBBBB': { v: '1' } });
      await expect(store.load(asRedis(redis), 'AAAAAA')).resolves.toBeNull();
      await expect(store.load(asRedis(redis), 'BBBBBB')).resolves.toBeNull();
    });
  });

  describe('compareAndSet', () => {
    it('KEYS·ARGV 순서가 추출 전과 같다: 방 키, 로비 키, 기대 버전, JSON, TTL, 코드, 생성 시각', async () => {
      const redis = createRedis();
      const room: TestRoom = { code: 'AAAAAA', createdAt: 1234, name: 'n' };
      await expect(store.compareAndSet(asRedis(redis), 'AAAAAA', '0', room)).resolves.toBe(true);
      expect(redis.eval).toHaveBeenCalledWith(
        ROOM_CAS_SCRIPT,
        2,
        'tetris-battle:room:AAAAAA',
        'tetris-battle:rooms',
        '0',
        JSON.stringify(room),
        '7200',
        'AAAAAA',
        '1234',
      );
    });

    it('삭제(room=null)는 빈 JSON·점수 0, 스크립트가 0이면 false', async () => {
      const redis = createRedis();
      redis.eval.mockResolvedValueOnce(0);
      await expect(store.compareAndSet(asRedis(redis), 'AAAAAA', '5', null)).resolves.toBe(false);
      expect(redis.eval).toHaveBeenCalledWith(ROOM_CAS_SCRIPT, 2, 'tetris-battle:room:AAAAAA', 'tetris-battle:rooms', '5', '', '7200', 'AAAAAA', '0');
    });
  });

  describe('scanLobby', () => {
    const roomOf = (code: string): TestRoom => ({ code, createdAt: 1, name: code });

    it('인덱스 순서대로 방 JSON을 돌려주고, 사라진 방은 인덱스에서 뺀다', async () => {
      const redis = createRedis(
        { 'tetris-battle:room:AAAAAA': { v: '1', json: JSON.stringify(roomOf('AAAAAA')) }, 'tetris-battle:room:CCCCCC': { v: '1', json: JSON.stringify(roomOf('CCCCCC')) } },
        ['CCCCCC', 'BBBBBB', 'AAAAAA'],
      );
      await expect(store.scanLobby(asRedis(redis), 200, 20)).resolves.toEqual([roomOf('CCCCCC'), roomOf('AAAAAA')]);
      expect(redis.zrevrange).toHaveBeenCalledWith('tetris-battle:rooms', 0, 199);
      expect(redis.zrem).toHaveBeenCalledWith('tetris-battle:rooms', 'BBBBBB');
      expect(redis.zrange).not.toHaveBeenCalled(); // 범위보다 작으면 끝 정리 없음
    });

    it('인덱스가 비었으면 파이프라인 없이 빈 배열', async () => {
      const redis = createRedis();
      await expect(store.scanLobby(asRedis(redis), 200, 20)).resolves.toEqual([]);
      expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it('읽은 수가 상한과 같으면 가장 오래된 batch개의 존재를 확인해 사라진 것만 지운다', async () => {
      const redis = createRedis({ 'tetris-battle:room:BBBBBB': { v: '1', json: JSON.stringify(roomOf('BBBBBB')) } }, ['BBBBBB', 'AAAAAA']);
      await store.scanLobby(asRedis(redis), 1, 5);
      await flush();
      expect(redis.zrange).toHaveBeenCalledWith('tetris-battle:rooms', 0, 4);
      expect(redis.zrem).toHaveBeenCalledWith('tetris-battle:rooms', 'AAAAAA');
    });

    it('인덱스 정리 실패는 로그만 남긴다', async () => {
      const redis = createRedis({}, ['AAAAAA']);
      redis.zrem.mockRejectedValueOnce(new Error('down'));
      await expect(store.scanLobby(asRedis(redis), 200, 20)).resolves.toEqual([]);
      await flush();
      expect(Logger.prototype.warn).toHaveBeenCalledWith('로비 인덱스 정리 실패: down');
    });
  });

  describe('로비 요약 캐시', () => {
    it('키 lobby-summary에 PX TTL로 쓰고 JSON으로 읽는다', async () => {
      const redis = createRedis();
      await store.writeLobbySummary(asRedis(redis), { waitingRooms: 1 }, 2000);
      expect(redis.set).toHaveBeenCalledWith('tetris-battle:lobby-summary', JSON.stringify({ waitingRooms: 1 }), 'PX', 2000);

      redis.get.mockResolvedValueOnce(JSON.stringify({ waitingRooms: 2 }));
      await expect(store.readLobbySummary<{ waitingRooms: number }>(asRedis(redis))).resolves.toEqual({ waitingRooms: 2 });
      expect(redis.get).toHaveBeenCalledWith('tetris-battle:lobby-summary');
      await expect(store.readLobbySummary(asRedis(redis))).resolves.toBeNull();
    });
  });
});

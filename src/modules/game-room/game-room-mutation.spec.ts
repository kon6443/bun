import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RoomMutationDeps, mutateGameRoom, notifyRoomChange, socketClientIp } from './game-room-mutation';
import { pruneDisconnectedSeats } from './game-room.rules';
import type { GameRoomStore } from './game-room.store';

type Seat = { playerId: string; connected: boolean; socketId: string | null; disconnectedAt: number | null };
type Room = {
  code: string;
  createdAt: number;
  hostId: string;
  status: 'WAITING' | 'PLAYING' | 'RESULT';
  players: Seat[];
  note?: string;
};

const NOW = 1_800_000_000_000;
const GRACE = 10_000;
class Rejected extends Error {}

/** 버전 문자열을 올리는 메모리 저장소 — casFailures만큼 CAS를 실패시켜 경합을 흉내 낸다 */
const memoryStore = (initial: Room | null, casFailures = 0) => {
  let room = initial;
  let version = 1;
  let failures = casFailures;
  const store = {
    load: jest.fn(async () =>
      room ? { version: String(version), room: JSON.parse(JSON.stringify(room)) as Room } : null,
    ),
    compareAndSet: jest.fn(async (_r: Redis, _c: string, expected: string, next: Room | null) => {
      if (failures > 0) {
        failures -= 1;
        return false;
      }
      if (expected !== String(version)) return false;
      room = next;
      version += 1;
      return true;
    }),
  };
  return { store, current: () => room };
};

const setup = (initial: Room | null, casFailures = 0) => {
  const mem = memoryStore(initial, casFailures);
  const notified: { room: Room | null; lobbyChanged: boolean }[] = [];
  const deps: RoomMutationDeps<Room, Room> = {
    store: mem.store as unknown as GameRoomStore<Room>,
    logger: new Logger('test'),
    maxAttempts: 3,
    prune: (room, now) => pruneDisconnectedSeats(room, now, GRACE),
    changeOf: room => ({ room, lobbyChanged: true }),
    notify: (_code, room, lobbyChanged) => notified.push({ room, lobbyChanged }),
    isRejection: error => error instanceof Rejected,
    roomNotFound: () => new Error('ROOM_NOT_FOUND'),
    roomBusy: () => new Error('ROOM_BUSY'),
  };
  return { ...mem, deps, notified };
};
const room = (players: Seat[]): Room => ({
  code: 'C',
  createdAt: NOW,
  hostId: 'p1',
  status: 'WAITING',
  players,
});
const seat = (id: string, over: Partial<Seat> = {}): Seat => ({
  playerId: id,
  connected: true,
  socketId: `s-${id}`,
  disconnectedAt: null,
  ...over,
});
const redis = {} as Redis;

describe('mutateGameRoom', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('변경을 CAS로 쓰고 결과를 돌려준다 · 바뀐 게 없으면 쓰지 않는다', async () => {
    const t = setup(room([seat('p1')]));
    await expect(
      mutateGameRoom(t.deps, redis, 'C', NOW, r => ((r.note = 'x'), { result: 'ok' })),
    ).resolves.toBe('ok');
    expect(t.current()?.note).toBe('x');
    t.store.compareAndSet.mockClear();
    await mutateGameRoom(t.deps, redis, 'C', NOW, () => ({ result: 'same' }));
    expect(t.store.compareAndSet).not.toHaveBeenCalled();
  });

  it('버전 경합이면 다시 읽어 재시도, maxAttempts를 넘으면 roomBusy', async () => {
    const retried = setup(room([seat('p1')]), 2);
    await expect(
      mutateGameRoom(retried.deps, redis, 'C', NOW, r => ((r.note = 'y'), { result: 1 })),
    ).resolves.toBe(1);
    expect(retried.store.load).toHaveBeenCalledTimes(3);

    const busy = setup(room([seat('p1')]), 3);
    await expect(
      mutateGameRoom(busy.deps, redis, 'C', NOW, r => ((r.note = 'z'), { result: 1 })),
    ).rejects.toThrow('ROOM_BUSY');
  });

  it('방이 없으면 roomNotFound · 정리로 아무도 안 남으면 지우고 삭제 방송 뒤 roomNotFound', async () => {
    await expect(mutateGameRoom(setup(null).deps, redis, 'C', NOW, () => ({ result: 1 }))).rejects.toThrow(
      'ROOM_NOT_FOUND',
    );
    const t = setup(room([seat('p1', { connected: false, socketId: null, disconnectedAt: NOW - GRACE })]));
    await expect(mutateGameRoom(t.deps, redis, 'C', NOW, () => ({ result: 1 }))).rejects.toThrow(
      'ROOM_NOT_FOUND',
    );
    expect(t.current()).toBeNull();
    expect(t.notified).toEqual([{ room: null, lobbyChanged: true }]);
  });

  it('요청이 거부돼도 정리분은 반영·방송하고 거부를 그대로 던진다 — 도메인 거부가 아닌 오류는 정리도 쓰지 않는다', async () => {
    const gone = seat('p2', { connected: false, socketId: null, disconnectedAt: NOW - GRACE });
    const t = setup(room([seat('p1'), gone]));
    await expect(
      mutateGameRoom(t.deps, redis, 'C', NOW, () => {
        throw new Rejected('NOT_HOST');
      }),
    ).rejects.toThrow('NOT_HOST');
    expect(t.current()?.players.map(p => p.playerId)).toEqual(['p1']);
    expect(t.notified).toHaveLength(1);

    const u = setup(room([seat('p1'), gone]));
    await expect(
      mutateGameRoom(u.deps, redis, 'C', NOW, () => {
        throw new Error('bug');
      }),
    ).rejects.toThrow('bug');
    expect(u.current()?.players).toHaveLength(2);
  });

  it('결과가 null인데 정리로 바뀌었으면 코어가 방송한다(호출자는 방송하지 않는 경로)', async () => {
    const t = setup(
      room([seat('p1'), seat('p2', { connected: false, socketId: null, disconnectedAt: NOW - GRACE })]),
    );
    await expect(mutateGameRoom(t.deps, redis, 'C', NOW, () => ({ result: null }))).resolves.toBeNull();
    expect(t.notified).toHaveLength(1);
  });

  it('deleteRoom이면 지운다', async () => {
    const t = setup(room([seat('p1')]));
    await mutateGameRoom(t.deps, redis, 'C', NOW, () => ({ result: 1, deleteRoom: true }));
    expect(t.current()).toBeNull();
  });
});

describe('notifyRoomChange · socketClientIp', () => {
  it('리스너가 던져도 삼키고 로그만 남긴다', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(() =>
      notifyRoomChange(
        () => {
          throw new Error('emit fail');
        },
        new Logger('t'),
        'C',
        null,
        true,
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('X-Forwarded-For의 마지막 값(위조 가능한 첫 값이 아니라) → 없으면 소켓 주소 → unknown', () => {
    expect(socketClientIp({ headers: { 'x-forwarded-for': '6.6.6.6, 10.9.9.9' }, address: '10.0.0.1' })).toBe(
      '10.9.9.9',
    );
    expect(
      socketClientIp({ headers: { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2, 3.3.3.3'] }, address: 'x' }),
    ).toBe('3.3.3.3');
    expect(socketClientIp({ headers: {}, address: '10.0.0.1' })).toBe('10.0.0.1');
    expect(socketClientIp({ headers: {} })).toBe('unknown');
  });
});

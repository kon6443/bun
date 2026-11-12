import { ROOM_CAS_SCRIPT } from '../../game-room/game-room.store';
import { MATCH_ACTIVATE_SCRIPT, MATCH_CAS_SCRIPT, StoredMatch } from '../fortress-match.store';
import { FortressError } from '../fortress.errors';
import { FortressErrorCode } from '../fortress.events';
import { StoredRoom } from '../fortress-room.service';

export const roomKey = (code: string) => `fortress:room:${code}`;
export const matchKey = (matchId: string) => `fortress:match:${matchId}`;
export const LOBBY_KEY = 'fortress:rooms';
export const DEADLINES_KEY = 'fortress:deadlines';
export const PENDING_SAVES_KEY = 'fortress:pending-saves';

/**
 * Redis 대역 — 포트리스 방·경기 서비스가 쓰는 명령만, 실제 의미대로 상태를 가진다(테트리스 __spec__/redis-mock과 같은 방식).
 * `eval`은 ROOM_CAS_SCRIPT·MATCH_CAS_SCRIPT의 의미(버전이 같을 때만 쓰기 + ZSET 갱신)를 흉내 낸다 —
 * Lua 본문 자체는 실제 Redis 스펙(test/fortress-match.redis.e2e-spec.ts)이 검증한다.
 * 여러 서비스 인스턴스(레플리카)가 같은 대역을 공유하면 같은 Redis를 보는 것과 같다.
 */
export const createRedisMock = () => {
  const hashes = new Map<string, Record<string, string>>();
  const strings = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  /** 로비 채팅 최근 대화(List) — lpush·ltrim·lrange만 */
  const lists = new Map<string, string[]>();
  const state = { forceCasConflicts: 0, status: 'ready' };
  const zsetOf = (key: string) => {
    let z = zsets.get(key);
    if (!z) zsets.set(key, (z = new Map()));
    return z;
  };

  const eval_ = jest.fn(async (script: string, _n: number, hKey: string, zKey: string, ...argv: string[]) => {
    // 첫 마감 걸기 — 경기가 아직 버전 1일 때만 ZSET에 넣는다(ARGV: matchId, 점수, TTL)
    if (script === MATCH_ACTIVATE_SCRIPT) {
      if (hashes.get(hKey)?.v !== '1') return 0;
      zsetOf(zKey).set(argv[0], Number(argv[1]));
      return 1;
    }
    const [expected, json, , member, score] = argv;
    if (state.forceCasConflicts > 0) {
      state.forceCasConflicts -= 1;
      return 0;
    }
    const cur = hashes.get(hKey)?.v;
    if (expected === '0' ? cur !== undefined : cur !== expected) return 0;
    if (script === ROOM_CAS_SCRIPT) {
      if (json === '') {
        hashes.delete(hKey);
        zsetOf(zKey).delete(member);
      } else {
        hashes.set(hKey, { v: String(Number(expected) + 1), json });
        zsetOf(zKey).set(member, Number(score));
      }
      return 1;
    }
    if (script === MATCH_CAS_SCRIPT) {
      hashes.set(hKey, { v: String(Number(expected) + 1), json });
      if (score === '') zsetOf(zKey).delete(member);
      else zsetOf(zKey).set(member, Number(score));
      return 1;
    }
    throw new Error('알 수 없는 스크립트');
  });

  const multi = () => {
    const ops: { kind: 'incr' | 'decr' | 'expire' | 'lpush' | 'ltrim'; key: string; value?: string; stop?: number }[] = [];
    const chain = {
      incr: (key: string) => (ops.push({ kind: 'incr', key }), chain),
      decr: (key: string) => (ops.push({ kind: 'decr', key }), chain),
      expire: (key: string) => (ops.push({ kind: 'expire', key }), chain),
      lpush: (key: string, value: string) => (ops.push({ kind: 'lpush', key, value }), chain),
      ltrim: (key: string, _start: number, stop: number) => (ops.push({ kind: 'ltrim', key, stop }), chain),
      exec: async () =>
        ops.map(({ kind, key, value, stop }) => {
          if (kind === 'expire') return [null, 1];
          if (kind === 'lpush') {
            lists.set(key, [value as string, ...(lists.get(key) ?? [])]);
            return [null, lists.get(key)?.length];
          }
          if (kind === 'ltrim') {
            lists.set(key, (lists.get(key) ?? []).slice(0, (stop as number) + 1));
            return [null, 'OK'];
          }
          const next = Number(strings.get(key) ?? 0) + (kind === 'incr' ? 1 : -1);
          strings.set(key, String(next));
          return [null, next];
        }),
    };
    return chain;
  };

  const sliceRange = (list: string[], start: number, stop: number) => list.slice(start, stop < 0 ? list.length + stop + 1 : stop + 1);
  const sorted = (key: string, desc: boolean) =>
    [...zsetOf(key).entries()].sort((a, b) => (desc ? b[1] - a[1] : a[1] - b[1])).map(([m]) => m);

  const redis = {
    get status() {
      return state.status;
    },
    hgetall: jest.fn(async (key: string) => ({ ...(hashes.get(key) ?? {}) })),
    eval: eval_,
    del: jest.fn(async (key: string) => (hashes.delete(key) || strings.delete(key) ? 1 : 0)),
    zadd: jest.fn(async (key: string, score: number, member: string) => {
      const added = zsetOf(key).has(member) ? 0 : 1;
      zsetOf(key).set(member, Number(score));
      return added;
    }),
    expire: jest.fn(async () => 1),
    zrevrange: jest.fn(async (key: string, start = 0, stop = -1) => sliceRange(sorted(key, true), start, stop)),
    zrange: jest.fn(async (key: string, start = 0, stop = -1) => sliceRange(sorted(key, false), start, stop)),
    zrangebyscore: jest.fn(async (key: string, _min: string, max: number, _limit: string, offset: number, count: number) =>
      [...zsetOf(key).entries()]
        .filter(([, s]) => s <= max)
        .sort((a, b) => a[1] - b[1])
        .map(([m]) => m)
        .slice(offset, offset + count),
    ),
    zrem: jest.fn(async (key: string, ...members: string[]) => {
      members.forEach((m) => zsetOf(key).delete(m));
      return members.length;
    }),
    lrange: jest.fn(async (key: string, start: number, stop: number) => sliceRange(lists.get(key) ?? [], start, stop)),
    get: jest.fn(async (key: string) => strings.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, ..._opts: unknown[]) => {
      if (strings.has(key)) return null; // NX
      strings.set(key, value);
      return 'OK';
    }),
    mget: jest.fn(async (...keys: string[]) => keys.map((key) => strings.get(key) ?? null)),
    multi: jest.fn(multi),
    pipeline: jest.fn(() => {
      const ops: (() => unknown)[] = [];
      const chain = {
        hget: (key: string) => (ops.push(() => hashes.get(key)?.json ?? null), chain),
        exists: (key: string) => (ops.push(() => (hashes.has(key) ? 1 : 0)), chain),
        exec: async () => ops.map((op) => [null, op()]),
      };
      return chain;
    }),
  };

  const readRoom = (code: string): StoredRoom | null => {
    const json = hashes.get(roomKey(code))?.json;
    return json ? (JSON.parse(json) as StoredRoom) : null;
  };
  const patchRoom = (code: string, patch: (room: StoredRoom) => void) => {
    const h = hashes.get(roomKey(code));
    if (!h) throw new Error('no room');
    const room = JSON.parse(h.json) as StoredRoom;
    patch(room);
    hashes.set(roomKey(code), { v: String(Number(h.v) + 1), json: JSON.stringify(room) });
  };
  const readMatch = (matchId: string): StoredMatch | null => {
    const json = hashes.get(matchKey(matchId))?.json;
    return json ? (JSON.parse(json) as StoredMatch) : null;
  };
  const deadlineOf = (matchId: string): number | undefined => zsetOf(DEADLINES_KEY).get(matchId);
  const pendingSaveOf = (matchId: string): number | undefined => zsetOf(PENDING_SAVES_KEY).get(matchId);

  return { redis, state, hashes, strings, zsets, lists, readRoom, patchRoom, readMatch, deadlineOf, pendingSaveOf };
};

export const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'OK',
    (e: unknown) => (e instanceof FortressError ? e.code : 'UNEXPECTED'),
  );

export const expectCode = async (promise: Promise<unknown>, code: FortressErrorCode, message?: string) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FortressError);
  expect((error as FortressError).code).toBe(code);
  if (message !== undefined) expect((error as FortressError).message).toBe(message);
};

import { TetrisBattleError } from '../tetris-battle.errors';
import { TetrisBattleErrorCode } from '../tetris-battle.events';
import { StoredRoom } from '../tetris-battle-room.service';

export const roomKey = (code: string) => `tetris-battle:room:${code}`;

/**
 * Redis 대역 — 이 서비스가 쓰는 명령만, 실제 의미대로 상태를 가진다.
 * `eval`은 ROOM_CAS_SCRIPT의 의미(버전이 같을 때만 쓰기)를 그대로 흉내 낸다 — Lua 본문 자체는
 * 실제 Redis 스펙(test/tetris-battle-room.redis.e2e-spec.ts)이 검증한다.
 * `forceCasConflicts`만큼 eval이 "다른 레플리카가 먼저 바꿈"(0)을 돌려준다.
 */
export const createRedisMock = () => {
  const hashes = new Map<string, Record<string, string>>();
  const strings = new Map<string, string>();
  const zset = new Map<string, number>();
  const state = { forceCasConflicts: 0, status: 'ready' };

  const eval_ = jest.fn(async (_script: string, _n: number, rKey: string, _lobby: string, ...argv: string[]) => {
    const [expected, json, , code, score] = argv;
    if (state.forceCasConflicts > 0) {
      state.forceCasConflicts -= 1;
      return 0;
    }
    const cur = hashes.get(rKey)?.v;
    if (expected === '0' ? cur !== undefined : cur !== expected) return 0;
    if (json === '') {
      hashes.delete(rKey);
      zset.delete(code);
    } else {
      hashes.set(rKey, { v: String(Number(expected) + 1), json });
      zset.set(code, Number(score));
    }
    return 1;
  });

  const multi = () => {
    // 실제 exec처럼 명령마다 결과 1개 (expire 결과 자리도 차지한다 — 인덱스 계산 검증)
    const ops: { kind: 'incr' | 'decr' | 'expire'; key: string }[] = [];
    const chain = {
      incr: (key: string) => (ops.push({ kind: 'incr', key }), chain),
      decr: (key: string) => (ops.push({ kind: 'decr', key }), chain),
      expire: (key: string) => (ops.push({ kind: 'expire', key }), chain),
      exec: async () =>
        ops.map(({ kind, key }) => {
          if (kind === 'expire') return [null, 1];
          const next = Number(strings.get(key) ?? 0) + (kind === 'incr' ? 1 : -1);
          strings.set(key, String(next));
          return [null, next];
        }),
    };
    return chain;
  };

  /** Redis 범위 규칙(stop 포함, 음수는 끝에서) */
  const sliceRange = (list: string[], start: number, stop: number) => list.slice(start, stop < 0 ? list.length + stop + 1 : stop + 1);

  const redis = {
    get status() {
      return state.status;
    },
    hgetall: jest.fn(async (key: string) => ({ ...(hashes.get(key) ?? {}) })),
    eval: eval_,
    zrevrange: jest.fn(async (_key: string, start = 0, stop = -1) =>
      sliceRange([...zset.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code), start, stop),
    ),
    zrange: jest.fn(async (_key: string, start = 0, stop = -1) =>
      sliceRange([...zset.entries()].sort((a, b) => a[1] - b[1]).map(([code]) => code), start, stop),
    ),
    zrem: jest.fn(async (_key: string, ...codes: string[]) => {
      codes.forEach((c) => zset.delete(c));
      return codes.length;
    }),
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

  /** 저장된 방을 직접 읽고 고친다 (P2 상태 등 시나리오 준비용) */
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

  return { redis, state, hashes, zset, strings, readRoom, patchRoom };
};

export const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'OK',
    (e: unknown) => (e instanceof TetrisBattleError ? e.code : 'UNEXPECTED'),
  );

export const expectCode = async (promise: Promise<unknown>, code: TetrisBattleErrorCode) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TetrisBattleError);
  expect((error as TetrisBattleError).code).toBe(code);
};

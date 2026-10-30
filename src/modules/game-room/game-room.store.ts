import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { GameRoomKeys } from './game-room-keys';

/**
 * 방 단위 원자 변경 — 버전 비교 후 쓰기(CAS) Lua.
 *
 * 왜 CAS인가(락 `SET NX PX` 대신):
 *  - 변경 로직(입장·이탈·방장 이양·정리)을 전부 TypeScript에 두고 Lua는 "버전이 같으면 쓴다" 한 가지만 한다
 *    → 규칙은 단위 테스트로, 원자성은 이 짧은 스크립트로 검증한다. Lua에 JSON 조작을 넣으면 둘 다 어려워진다.
 *  - 락은 보유자가 PX보다 오래 멈추면(GC·Redis 지연) 두 쓰기가 겹치고, 해제 토큰 검증·대기 재시도까지 필요하다.
 *    CAS는 멈춘 쪽이 늦게 쓰려 할 때 버전이 달라 실패하고 다시 읽을 뿐이라 그런 창이 없다.
 *  - WATCH/MULTI는 어댑터 pub 클라이언트(여러 서비스가 공유하는 한 연결)에서 쓰면 다른 요청의 명령과 섞여 깨진다.
 *
 * KEYS[1] 방 Hash, KEYS[2] 로비 ZSET
 * ARGV[1] 기대 버전('0' = 아직 없어야 함 — 생성), ARGV[2] 새 JSON(''이면 삭제), ARGV[3] TTL(초), ARGV[4] 코드, ARGV[5] 로비 점수
 * 반환: 1 성공 · 0 버전 불일치(다른 레플리카가 먼저 바꿈 또는 방이 사라짐)
 *
 * 본문을 바꾸면 배포 중 옛·새 레플리카가 다른 규칙으로 쓴다 — 바이트 그대로 유지한다(game-room.store.spec.ts가 고정)
 */
export const ROOM_CAS_SCRIPT = `
local cur = redis.call('HGET', KEYS[1], 'v')
if ARGV[1] == '0' then
  if cur then return 0 end
elseif cur ~= ARGV[1] then
  return 0
end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[4])
else
  redis.call('HSET', KEYS[1], 'v', tostring(tonumber(ARGV[1]) + 1), 'json', ARGV[2])
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  redis.call('ZADD', KEYS[2], ARGV[5], ARGV[4])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return 1
`;

/** 저장소가 알아야 하는 방 JSON의 최소 모양 — 나머지는 게임마다 다르다 */
export interface GameRoomRecord {
  code: string;
  /** 로비 ZSET 점수(ms) */
  createdAt: number;
}

export interface LoadedRoom<TRoom> {
  version: string;
  room: TRoom;
}

/**
 * 방 Hash + 로비 ZSET 인덱스 + 로비 요약 캐시 저장소 (게임 공용). 규칙(정리·방장 이양·요약)은 모르고 읽기·CAS 쓰기만 한다.
 * TetrisBattleMatchStore처럼 Redis 연결을 메서드 인자로 받는다 — 방 서비스가 연결 준비 여부를 판단한다.
 */
export class GameRoomStore<TRoom extends GameRoomRecord> {
  constructor(
    private readonly keys: Pick<GameRoomKeys, 'room' | 'lobbyIndex' | 'lobbySummary'>,
    private readonly ttlSeconds: number,
    /** 방 서비스의 Logger를 넘긴다 — 로그 출처를 그대로 두려고 */
    private readonly logger: Logger,
  ) {}

  async load(redis: Redis, code: string): Promise<LoadedRoom<TRoom> | null> {
    const hash = await redis.hgetall(this.keys.room(code));
    if (!hash.v || !hash.json) return null;
    return { version: hash.v, room: JSON.parse(hash.json) as TRoom };
  }

  /** 기대 버전과 같을 때만 쓴다(room=null이면 삭제). 성공 여부 */
  async compareAndSet(redis: Redis, code: string, expectedVersion: string, room: TRoom | null): Promise<boolean> {
    const result = await redis.eval(
      ROOM_CAS_SCRIPT,
      2,
      this.keys.room(code),
      this.keys.lobbyIndex,
      expectedVersion,
      room ? JSON.stringify(room) : '',
      String(this.ttlSeconds),
      code,
      String(room?.createdAt ?? 0),
    );
    return Number(result) === 1;
  }

  /**
   * 로비 인덱스 최근 `scanLimit`개 방을 최근 생성 순으로 읽는다(방 JSON 그대로 — 정리 규칙은 호출 쪽).
   * TTL로 사라진 방은 빼고 인덱스에서 정리한다. 인덱스가 읽는 범위보다 크면 가장 오래된 쪽 `tailSweepBatch`개도 정리한다
   */
  async scanLobby(redis: Redis, scanLimit: number, tailSweepBatch: number): Promise<TRoom[]> {
    const codes = await redis.zrevrange(this.keys.lobbyIndex, 0, scanLimit - 1);
    if (codes.length === 0) return [];

    const pipeline = redis.pipeline();
    for (const code of codes) pipeline.hget(this.keys.room(code), 'json');
    const results = (await pipeline.exec()) ?? [];

    const rooms: TRoom[] = [];
    const vanished: string[] = [];
    codes.forEach((code, i) => {
      const json = results[i]?.[1];
      if (typeof json !== 'string') {
        vanished.push(code);
        return;
      }
      rooms.push(JSON.parse(json) as TRoom);
    });

    if (vanished.length > 0) {
      // TTL로 사라진 방을 인덱스에서 정리 — 실패해도 다음 조회에서 다시 시도된다
      redis.zrem(this.keys.lobbyIndex, ...vanished).catch((error: unknown) => {
        this.logger.warn(`로비 인덱스 정리 실패: ${(error as Error).message}`);
      });
    }
    // 인덱스가 읽는 범위(최근 scanLimit개)보다 크면 가장 오래된 쪽도 조금씩 정리한다 — 범위 밖으로 밀린 사라진 방 코드가
    // 영영 남아 인덱스가 끝없이 커지지 않게(tetris-audit BE-03). 인덱스 점수는 생성 시각이라 오래 살아 있는 방도 있어 존재 확인으로 지운다
    if (codes.length === scanLimit) void this.sweepLobbyTail(redis, tailSweepBatch);

    return rooms;
  }

  private async sweepLobbyTail(redis: Redis, batch: number): Promise<void> {
    try {
      const oldest = await redis.zrange(this.keys.lobbyIndex, 0, batch - 1);
      if (oldest.length === 0) return;
      const pipeline = redis.pipeline();
      for (const code of oldest) pipeline.exists(this.keys.room(code));
      const results = (await pipeline.exec()) ?? [];
      const gone = oldest.filter((_, i) => results[i]?.[1] === 0);
      if (gone.length > 0) await redis.zrem(this.keys.lobbyIndex, ...gone);
    } catch (error) {
      this.logger.warn(`로비 인덱스 끝 정리 실패: ${(error as Error).message}`);
    }
  }

  /** 로비 요약 캐시(레플리카 공통) — 없으면 null */
  async readLobbySummary<TSummary>(redis: Redis): Promise<TSummary | null> {
    const cached = await redis.get(this.keys.lobbySummary);
    return cached ? (JSON.parse(cached) as TSummary) : null;
  }

  async writeLobbySummary<TSummary>(redis: Redis, summary: TSummary, ttlMs: number): Promise<void> {
    await redis.set(this.keys.lobbySummary, JSON.stringify(summary), 'PX', ttlMs);
  }
}

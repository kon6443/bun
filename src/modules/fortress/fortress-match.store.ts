import type { Redis } from 'ioredis';
import type { Action, MatchConfig, MatchState } from './engine';
import type { MatchTally } from './fortress-match.rules';
import type { FortressTankSkin, MatchSlot } from './fortress.events';
import { FORTRESS_MATCH_KEYS, MATCH_TTL_SECONDS, SAVE_GUARD_TTL_SECONDS } from './fortress.constants';

/**
 * 경기 CAS Lua — 방 CAS(game-room.store.ts ROOM_CAS_SCRIPT)와 같은 "버전이 같으면 쓴다" 한 가지 + 마감 ZSET 갱신.
 *
 * 버전은 쓰기마다 1 오른다. 경기 JSON을 바꾸는 쓰기는 행동 추가(seq·마감이 함께 바뀜)와 끊김 표시뿐이라,
 * "읽은 버전 그대로"면 seq·마감도 읽은 그대로다 — 마감 처리·제출을 여러 레플리카가 동시에 해도 하나만 적용된다(DESIGN §11 타이머).
 * 규칙(마감 판정·엔진 적용)은 TypeScript에 두고 Lua는 원자 쓰기만 한다(방 CAS와 같은 이유).
 *
 * KEYS[1] 경기 Hash, KEYS[2] 마감 ZSET
 * ARGV[1] 기대 버전('0' = 아직 없어야 함 — 생성), ARGV[2] 새 JSON, ARGV[3] TTL(초), ARGV[4] matchId,
 * ARGV[5] 마감 ZSET 점수(ms, ''이면 ZSET에서 뺀다 — 경기 끝)
 * 반환: 1 성공 · 0 버전 불일치
 *
 * 본문을 바꾸면 배포 중 옛·새 레플리카가 다른 규칙으로 쓴다 — 바꿀 때는 키도 새로 둔다
 */
export const MATCH_CAS_SCRIPT = `
local cur = redis.call('HGET', KEYS[1], 'v')
if ARGV[1] == '0' then
  if cur then return 0 end
elseif cur ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'v', tostring(tonumber(ARGV[1]) + 1), 'json', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if ARGV[5] == '' then
  redis.call('ZREM', KEYS[2], ARGV[4])
else
  redis.call('ZADD', KEYS[2], ARGV[5], ARGV[4])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return 1
`;

/**
 * 첫 마감 걸기 Lua(리뷰 B1·2차) — 경기가 아직 생성 직후(버전 1)일 때만 마감 ZSET에 넣는다.
 * 방 CAS와 activate 사이에 다른 레플리카가 행동(이탈 resign 등)을 먼저 적용했으면 그 CAS가 이미 마감을 썼다 —
 * 생성 때 값으로 덮으면 끝난 경기를 ZSET에 되살리거나 끊김 유예 마감을 늦춘다.
 *
 * KEYS[1] 경기 Hash, KEYS[2] 마감 ZSET · ARGV[1] matchId, ARGV[2] 점수(ms), ARGV[3] TTL(초)
 * 반환: 1 넣음 · 0 이미 진행됨(건너뜀)
 */
export const MATCH_ACTIVATE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'v') ~= '1' then return 0 end
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`;

/** 경기 참가자 — 계약 MatchSlot + 서버만 아는 값. skin은 F7 전 경기에 없어 선택(내보낼 때 default로 채운다) */
export interface StoredMatchSlot extends Omit<MatchSlot, 'skin'> {
  /** 경기 중 끊긴 시각(ms) — MATCH_DISCONNECT_GRACE_MS가 지나면 resign(cause disconnect). 연결 중이면 null */
  disconnectedAt: number | null;
  /** 로그인 참가자 userId, 게스트 null — 결과 저장용(F6). 기능 배포 전에 시작한 경기에는 없다(= null) */
  userId?: number | null;
  /** 경기 시작 때 고정한 탱크 스킨(F7) — 리플레이 저장용. 기능 배포 전에 시작한 경기에는 없다(= default) */
  skin?: FortressTankSkin;
}

/**
 * Redis에 두는 경기 — 엔진 state는 순수 JSON이라 그대로 둔다(행동마다 처음부터 재적용하지 않게, DESIGN §10).
 * actions·config는 resync·재연결 복원(MatchSnapshot)과 F6 리플레이 저장의 원본이다
 */
export interface StoredMatch {
  matchId: string;
  /** 방 코드 — 백그라운드 처리(타이머·스위퍼)가 방송할 방 */
  code: string;
  config: MatchConfig;
  slots: StoredMatchSlot[];
  actions: Action[];
  state: MatchState;
  /** 마지막 행동 적용 후 stateHash(행동 전이면 첫 state) */
  stateHash: string;
  tally: MatchTally;
  status: 'PLAYING' | 'ENDED';
  /** 지금 턴 마감(ms) — 끝났으면 null */
  deadlineAt: number | null;
  /** 지금 턴 길이(ms) — TurnInfo.turnMs */
  turnMs: number;
  startedAt: number;
  /** 아래 셋은 결과 저장용(F6, DESIGN §12) — 기능 배포 전에 시작한 경기에는 없을 수 있다 */
  /** 방 이름(시작 때) */
  roomName?: string;
  /** 시작 때 엔진 버전 */
  engineVersion?: number;
  /** 경기를 끝낸 행동이 확정된 시각(ms) — 진행 중이면 null */
  endedAt?: number | null;
}

export interface LoadedMatch {
  version: string;
  match: StoredMatch;
}

/**
 * 경기 Hash + 마감 ZSET 저장소. 규칙은 모르고 읽기·CAS 쓰기·마감 조회만 한다(GameRoomStore처럼 연결은 인자로 받는다).
 */
export class FortressMatchStore {
  async load(redis: Redis, matchId: string): Promise<LoadedMatch | null> {
    const hash = await redis.hgetall(FORTRESS_MATCH_KEYS.match(matchId));
    if (!hash.v || !hash.json) return null;
    return { version: hash.v, match: JSON.parse(hash.json) as StoredMatch };
  }

  /** 기대 버전과 같을 때만 쓴다. 마감 ZSET 점수 = dueAt(null이면 ZSET에서 뺀다). 성공 여부 */
  async compareAndSet(redis: Redis, expectedVersion: string, match: StoredMatch, dueAt: number | null): Promise<boolean> {
    const result = await redis.eval(
      MATCH_CAS_SCRIPT,
      2,
      FORTRESS_MATCH_KEYS.match(match.matchId),
      FORTRESS_MATCH_KEYS.deadlines,
      expectedVersion,
      JSON.stringify(match),
      String(MATCH_TTL_SECONDS),
      match.matchId,
      dueAt === null ? '' : String(dueAt),
    );
    return Number(result) === 1;
  }

  /** 시작 실패 정리 — 경기 키와 마감 항목을 지운다(남아도 TTL로 사라지고, 스위퍼는 키가 없으면 ZSET에서 뺀다) */
  async remove(redis: Redis, matchId: string): Promise<void> {
    await redis.del(FORTRESS_MATCH_KEYS.match(matchId));
    await redis.zrem(FORTRESS_MATCH_KEYS.deadlines, matchId);
  }

  /** 처리 시각이 지난 경기 id (이른 순, 최대 limit개) */
  async dueMatchIds(redis: Redis, now: number, limit: number): Promise<string[]> {
    return redis.zrangebyscore(FORTRESS_MATCH_KEYS.deadlines, '-inf', now, 'LIMIT', 0, limit);
  }

  /** 첫 마감을 마감 ZSET에 넣는다 — 경기 시작 확정(방 CAS 성공) 뒤 한 번, 경기가 아직 버전 1일 때만(MATCH_ACTIVATE_SCRIPT). forgetDue의 짝 */
  async addDue(redis: Redis, matchId: string, dueAt: number): Promise<boolean> {
    const result = await redis.eval(
      MATCH_ACTIVATE_SCRIPT,
      2,
      FORTRESS_MATCH_KEYS.match(matchId),
      FORTRESS_MATCH_KEYS.deadlines,
      matchId,
      String(dueAt),
      String(MATCH_TTL_SECONDS),
    );
    return Number(result) === 1;
  }

  /** 키가 사라진(TTL) 경기를 마감 ZSET에서 뺀다 */
  async forgetDue(redis: Redis, matchId: string): Promise<void> {
    await redis.zrem(FORTRESS_MATCH_KEYS.deadlines, matchId);
  }

  // ==================== 결과 저장 (F6, DESIGN §12) ====================

  /** 저장 대기에 넣는다(이미 있으면 처리 시각만 바꾼다) */
  async markPendingSave(redis: Redis, matchId: string, dueAt: number): Promise<void> {
    await redis.zadd(FORTRESS_MATCH_KEYS.pendingSaves, dueAt, matchId);
    await redis.expire(FORTRESS_MATCH_KEYS.pendingSaves, MATCH_TTL_SECONDS);
  }

  /** 처리 시각이 지난 저장 대기 (이른 순, 최대 limit개) */
  async duePendingSaves(redis: Redis, now: number, limit: number): Promise<string[]> {
    return redis.zrangebyscore(FORTRESS_MATCH_KEYS.pendingSaves, '-inf', now, 'LIMIT', 0, limit);
  }

  async clearPendingSave(redis: Redis, matchId: string): Promise<void> {
    await redis.zrem(FORTRESS_MATCH_KEYS.pendingSaves, matchId);
  }

  async isSaved(redis: Redis, matchId: string): Promise<boolean> {
    return (await redis.get(FORTRESS_MATCH_KEYS.saved(matchId))) === '1';
  }

  /** DB 저장 완료 표시 — 경기 키와 같은 수명(그 뒤로는 DB 행이 기준) */
  async markSaved(redis: Redis, matchId: string): Promise<void> {
    await redis.set(FORTRESS_MATCH_KEYS.saved(matchId), '1', 'EX', MATCH_TTL_SECONDS);
  }

  /** 저장 진행 가드 — 잡았으면 true. 저장 중 죽어도 SAVE_GUARD_TTL_SECONDS 뒤 풀린다 */
  async claimSave(redis: Redis, matchId: string): Promise<boolean> {
    return (await redis.set(FORTRESS_MATCH_KEYS.saving(matchId), '1', 'EX', SAVE_GUARD_TTL_SECONDS, 'NX')) === 'OK';
  }

  async releaseSave(redis: Redis, matchId: string): Promise<void> {
    await redis.del(FORTRESS_MATCH_KEYS.saving(matchId));
  }
}

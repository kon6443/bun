import type { Redis } from 'ioredis';
import { FRAMES_PER_SECOND, SPAWN_DELAY_FRAMES } from '../games/tetris-engine';
import { DISCONNECT_GRACE_MS, LOCK_FRAME_SLACK, MATCH_START_DELAY_MS, MATCH_TTL_SECONDS } from './tetris-battle.constants';
import { MAX_GARBAGE_EVENTS } from './battle-engine';
import { GarbagePayload, KoReason } from './tetris-battle.events';

/**
 * 매치 상태 저장소 — 방 JSON과 **분리된** Redis Hash + Lua (DESIGN §8, 리뷰 P2 동시성 요구)
 *
 * 왜 방 JSON CAS를 쓰지 않는가:
 *  - lock은 4인 × 초당 1~3회가 같은 매치에 몰린다. "읽기 → 계산 → 버전 CAS"는 경합할 때마다 재시도하고,
 *    여러 플레이어가 계속 이기면 한 플레이어가 재시도 한도(ROOM_BUSY)를 넘을 수 있다(기아).
 *  - Lua 스크립트는 Redis 안에서 한 번에 실행된다 → 재시도 자체가 없다. 대상 순환·가비지 id 증가·
 *    통계·생존·KO·종료 판정을 한 스크립트로 원자 처리한다. 왕복도 lock당 EVAL 1번.
 *  - 방 JSON(멤버·방장·상태)은 드물게 바뀌므로 기존 CAS 그대로. 매치 → 방 전이(PLAYING → RESULT)는 종료 판정을
 *    받은 **한 요청만**(Lua가 정확히 1번 ended=true를 돌려준다) 방 CAS로 반영한다.
 *
 * 키 (모두 TTL — MATCH_TTL_SECONDS, 쓰기마다 갱신. 경기 종료 후에도 TTL 동안 남아 P5 검증에 쓴다)
 *  - tetris-battle:match:{matchId}            Hash — 아래 필드
 *  - tetris-battle:match:{matchId}:garbage:{playerId}  List — 받는 플레이어별 가비지 로그 JSON {id, lines, hole, from, at}
 *      at = 보낸 시각(Redis TIME ms, 내부 필드 — 재연결 missedGarbage에는 싣지 않는다). 경기 후 검증의 누락 허용 경계(P5)
 *  - tetris-battle:match:{matchId}:sent:{playerId}     List — 보낸 lock별 "seq:sent"(sent > 0만, 상한 MAX_GARBAGE_EVENTS) — 경기 후 검증(P5)
 *  - tetris-battle:match:{matchId}:subs                Hash — 리플레이 제출 playerId → JSON (P5, 1회) + 예약 필드
 *      __closed(제출 닫힘 — 저장이 읽을 목록을 확정한 시각) · __saved(DB 저장 완료). 제출·닫힘은 Lua로 원자 처리
 *  - tetris-battle:match:{matchId}:saved               String — 저장 진행 중 가드(SET NX, 짧은 TTL — 저장 중 죽어도 다음 계기에 재시도)
 *
 * Hash 필드
 *  - code·seed·startedAt·status('PLAYING'|'ENDED')·endedAt·aliveCount·pids(입장 순서, 쉼표 구분)
 *  - clockStart: 서버 기준 경기 0프레임 시각(ms) = 생성 시각(Redis TIME) + MATCH_START_DELAY_MS — lock 프레임 상한의 기준
 *  - endedClock: 종료 시각(Redis TIME, ms) — 생존자 리플레이 frames 상한(P5)의 기준 · roomName: 방 이름(P5 저장)
 *  - p:{pid}:tokenHash: 시작 시점의 재연결 토큰 해시 — 리플레이 제출 인증(P5, rematch·이탈 뒤에도 그 경기 기준)
 *  - p:{pid}:name·userId·alive('1'|'0')·seq·frame·pieces·sent·recv·maxCombo·kos·combo·b2b·board·pending
 *  - p:{pid}:cursor(이 공격자가 마지막으로 공격한 대상)·gid(이 플레이어가 받은 마지막 가비지 id)·lastFrom(마지막 공격자)
 *  - p:{pid}:discAt(끊긴 시각 ms, ''면 연결)·place·koReason·koBy·frames(탈락/종료 프레임)·koClock(탈락 Redis 시각 ms, P5)
 *
 * 대상 순환(D-006 자동 순환)은 **공격자별 커서**: 각 공격자가 자기 마지막 대상 다음 생존자부터 돌아간다.
 * 방 단위 커서보다 단순하다 — 공격자마다 독립이라 "다른 사람의 공격 때문에 내 순서가 건너뛰어지는" 경우를 설명할 필요가 없고,
 * 한 공격자가 한 명만 계속 때리는(왕따) 일이 구조적으로 없다.
 */

export const matchKey = (matchId: string) => `tetris-battle:match:${matchId}`;
export const garbageLogKey = (matchId: string, playerId: string) => `tetris-battle:match:${matchId}:garbage:${playerId}`;
export const sentLogKey = (matchId: string, playerId: string) => `tetris-battle:match:${matchId}:sent:${playerId}`;
export const submissionsKey = (matchId: string) => `tetris-battle:match:${matchId}:subs`;
export const savedGuardKey = (matchId: string) => `tetris-battle:match:${matchId}:saved`;
export const verifyingKey = (matchId: string, playerId: string) => `tetris-battle:match:${matchId}:verifying:${playerId}`;
/** 저장 대기 매치 — ZSET(점수 = 저장 예정 시각 ms). 깨우기 타이머가 레플리카 재시작으로 사라져도 스윕이 찾는다(games-polish BT-05) */
export const pendingSavesKey = 'tetris-battle:pending-saves';

/** lock·KO 스크립트 공통 — KEYS[1] 매치 Hash, KEYS[2..] pids 순서의 가비지 로그. ARGV[1] now, ARGV[2] 끊김 유예, ARGV[3] TTL */
const LUA_PRELUDE = `
local M = KEYS[1]
local now = tonumber(ARGV[1])
local grace = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local function g(f) return redis.call('HGET', M, f) end
local function pf(p, f) return 'p:' .. p .. ':' .. f end
local pids = {}
for x in string.gmatch(g('pids') or '', '[^,]+') do pids[#pids + 1] = x end
local function idx(p) for i, x in ipairs(pids) do if x == p then return i end end return nil end
local function alive(p) return g(pf(p, 'alive')) == '1' end
local function notPlayingCode() if g('status') == 'ENDED' then return 'MATCH_ENDED' end return 'MATCH_NOT_FOUND' end
local kos = {}
local ended = false
local function finishIfLast()
  if tonumber(g('aliveCount')) <= 1 and g('status') == 'PLAYING' then
    local t = redis.call('TIME')
    local clk = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
    redis.call('HSET', M, 'status', 'ENDED', 'endedAt', ARGV[1], 'endedClock', string.format('%d', clk))
    for _, p in ipairs(pids) do
      if alive(p) then redis.call('HSET', M, pf(p, 'place'), 1, pf(p, 'frames'), g(pf(p, 'frame')) or '0') end
    end
    ended = true
  end
end
local function ko(p, reason, frame)
  -- 이미 끝난 매치(이 스크립트 안에서 앞선 KO로 끝난 경우 포함)에서는 KO하지 않는다 — 우승자를 KO하면 순위가 깨진다
  if g('status') ~= 'PLAYING' or not alive(p) then return end
  redis.call('HSET', M, pf(p, 'alive'), '0')
  local n = redis.call('HINCRBY', M, 'aliveCount', -1)
  local by = g(pf(p, 'lastFrom')) or ''
  if by ~= '' then redis.call('HINCRBY', M, pf(by, 'kos'), 1) end
  local last = tonumber(g(pf(p, 'frame')) or '0')
  local f = last
  if frame and frame > last then f = frame end
  local kt = redis.call('TIME')
  local koClock = tonumber(kt[1]) * 1000 + math.floor(tonumber(kt[2]) / 1000)
  redis.call('HSET', M, pf(p, 'place'), n + 1, pf(p, 'koReason'), reason, pf(p, 'koBy'), by, pf(p, 'frames'), f,
    pf(p, 'koClock'), string.format('%d', koClock))
  kos[#kos + 1] = { playerId = p, by = by, place = n + 1, reason = reason }
  finishIfLast()
end
local function sweep()
  for _, p in ipairs(pids) do
    if g('status') ~= 'PLAYING' then break end
    local d = g(pf(p, 'discAt'))
    if alive(p) and d and d ~= '' and now - tonumber(d) >= grace then ko(p, 'disconnect', nil) end
  end
end
local function nextTarget(p)
  local n = #pids
  local start = idx(g(pf(p, 'cursor')) or '') or idx(p)
  for i = 1, n do
    local c = pids[(start + i - 1) % n + 1]
    if c ~= p and alive(c) then return c end
  end
  return nil
end
local function touch()
  redis.call('EXPIRE', M, ttl)
end
local function reply(t)
  t.kos = kos
  t.ended = ended
  return cjson.encode(t)
end
`;

/**
 * lock — ARGV[4] pid, [5] seq, [6] frame, [7] sent, [8] combo, [9] b2b('1'|'0'), [10] board, [11] pending, [12] hole,
 *        [13] 가비지 이벤트 상한, [14] 초당 프레임, [15] 프레임 여유, [16] 블록 생성 지연 프레임
 * KEYS: [1] 매치 Hash, [2..n+1] pids 순서의 가비지 로그, [n+2] 이 플레이어의 sent 로그(P5)
 * 처리 순서: 끊김 유예 지난 다른 플레이어 KO(lazy) → 검증(매치 진행·생존·seq/frame 단조·게임 시간 상한) → 스냅샷·통계 → 공격 라우팅
 * 게임 시간 상한의 근거는 constants.ts LOCK_FRAME_SLACK 주석. 현재 시각은 Redis TIME(레플리카 시계와 무관)
 */
export const MATCH_LOCK_SCRIPT = `${LUA_PRELUDE}
if g('status') ~= 'PLAYING' then return reply({ ok = false, code = notPlayingCode() }) end
local pid = ARGV[4]
if not idx(pid) then return reply({ ok = false, code = 'MATCH_NOT_FOUND' }) end
sweep()
if g('status') ~= 'PLAYING' then touch() return reply({ ok = false, code = 'MATCH_ENDED' }) end
if not alive(pid) then touch() return reply({ ok = false, code = 'PLAYER_NOT_ALIVE' }) end
local seq = tonumber(ARGV[5])
local frame = tonumber(ARGV[6])
local lastSeq = tonumber(g(pf(pid, 'seq')) or '0')
local lastFrame = tonumber(g(pf(pid, 'frame')) or '-1')
if seq == lastSeq then
  local nt = nextTarget(pid)
  touch()
  return reply({ ok = true, dup = true, nextTarget = nt or '' })
end
if seq < lastSeq or frame <= lastFrame then touch() return reply({ ok = false, code = 'LOCK_OUT_OF_ORDER' }) end
local t = redis.call('TIME')
local serverMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local maxFrame = math.floor((serverMs - tonumber(g('clockStart'))) * tonumber(ARGV[14]) / 1000) + tonumber(ARGV[15])
if frame > maxFrame then touch() return reply({ ok = false, code = 'LOCK_TOO_FAST' }) end
local prevFrame = lastFrame
if prevFrame < 0 then prevFrame = 0 end
if seq - lastSeq > math.floor((frame - prevFrame) / tonumber(ARGV[16])) + 1 then
  touch()
  return reply({ ok = false, code = 'LOCK_TOO_FAST' })
end
local combo = tonumber(ARGV[8])
redis.call('HSET', M, pf(pid, 'seq'), seq, pf(pid, 'frame'), frame, pf(pid, 'pieces'), seq,
  pf(pid, 'combo'), combo, pf(pid, 'b2b'), ARGV[9], pf(pid, 'board'), ARGV[10], pf(pid, 'pending'), ARGV[11])
if combo > tonumber(g(pf(pid, 'maxCombo')) or '0') then redis.call('HSET', M, pf(pid, 'maxCombo'), combo) end
local sent = tonumber(ARGV[7])
-- 경기 후 검증(P5): 보고한 공격을 lock 단위로 남긴다(대상 유무와 무관 — 시뮬 결과 sent[]와 대조)
if sent > 0 then
  local sentLog = KEYS[#KEYS]
  if redis.call('LLEN', sentLog) < tonumber(ARGV[13]) then
    redis.call('RPUSH', sentLog, seq .. ':' .. sent)
    redis.call('EXPIRE', sentLog, ttl)
  end
end
local target = nil
local gid = 0
if sent > 0 then
  target = nextTarget(pid)
  if target then
    local cur = tonumber(g(pf(target, 'gid')) or '0')
    if cur < tonumber(ARGV[13]) then
      -- 대상 순환 커서는 실제로 보냈을 때만 넘긴다 — 상한에 막혀 못 보낸 공격이 다음 대상 차례까지 건너뛰지 않게(tetris-audit BE-14)
      redis.call('HSET', M, pf(pid, 'cursor'), target)
      gid = redis.call('HINCRBY', M, pf(target, 'gid'), 1)
      local log = KEYS[1 + idx(target)]
      redis.call('RPUSH', log, cjson.encode({ id = gid, lines = sent, hole = tonumber(ARGV[12]), from = pid, at = serverMs }))
      redis.call('EXPIRE', log, ttl)
      redis.call('HINCRBY', M, pf(pid, 'sent'), sent)
      redis.call('HINCRBY', M, pf(target, 'recv'), sent)
      redis.call('HSET', M, pf(target, 'lastFrom'), pid)
    else
      target = nil
    end
  end
end
local nt = nextTarget(pid)
touch()
return reply({ ok = true, dup = false, target = target or '', gid = gid, nextTarget = nt or '' })
`;

/** KO·정리 — ARGV[4] pid(''면 정리만), [5] reason, [6] frame('' = 마지막 lock 프레임) */
export const MATCH_KO_SCRIPT = `${LUA_PRELUDE}
if g('status') ~= 'PLAYING' then return reply({ ok = false, code = notPlayingCode() }) end
local pid = ARGV[4]
if pid ~= '' and not idx(pid) then return reply({ ok = false, code = 'MATCH_NOT_FOUND' }) end
sweep()
if pid ~= '' then
  local frame = nil
  if ARGV[6] ~= '' then frame = tonumber(ARGV[6]) end
  ko(pid, ARGV[5], frame)
end
touch()
return reply({ ok = true })
`;

/**
 * 끊김 시각 기록 — 매치 Hash가 있고 PLAYING일 때만 쓴다(없는 키에 HSET하면 TTL 없는 키가 생긴다).
 * KEYS[1] 매치 Hash, ARGV[1] 필드, ARGV[2] 값('' = 연결됨)
 */
/**
 * 제출 기록 — 닫혔으면 -1(마감·저장 시작 뒤), 이미 냈으면 0, 기록했으면 1. KEYS[1] subs, ARGV[1] pid, [2] JSON, [3] TTL
 * "닫힘 확인 + HSETNX"가 한 스크립트라 저장이 읽은 목록에 없는 제출이 201로 남는 일이 없다(리뷰 L2)
 */
export const CLAIM_SUBMISSION_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], '__closed') == 1 then return -1 end
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

/**
 * 제출 닫기 — 닫힘 표시를 세우고 그 순간의 제출 목록 전체(HGETALL, 평탄 배열)를 돌려준다. 이미 닫혔어도 같은 목록을 돌려준다.
 * KEYS[1] subs, ARGV[1] 닫은 시각, [2] TTL
 */
export const CLOSE_SUBMISSIONS_SCRIPT = `
redis.call('HSETNX', KEYS[1], '__closed', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return redis.call('HGETALL', KEYS[1])
`;

/** 토큰 해시 갱신 — 매치 키가 있을 때만(없는 키를 만들지 않는다). KEYS[1] 매치 Hash, ARGV[1] 필드, [2] 값 */
export const MATCH_SET_TOKEN_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  return 1
end
return 0
`;

/** subs Hash의 예약 필드 — 제출 목록에서 뺀다 */
const RESERVED_SUBMISSION_FIELDS = new Set(['__closed', '__saved']);
const withoutReserved = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).filter(([k]) => !RESERVED_SUBMISSION_FIELDS.has(k)));

/** 저장 진행 가드 TTL(초) — 저장(트랜잭션 1번)이 이보다 오래 걸리지 않는다. 죽은 저장은 이 뒤에 다음 계기가 다시 잡는다(리뷰 L8) */
export const SAVE_GUARD_TTL_SECONDS = 120;
/** 검증 진행 가드 TTL(초) — 최악 시뮬레이션(수백 ms)보다 넉넉히. 프로세스가 죽어도 이 뒤 다시 제출할 수 있다 */
export const VERIFY_GUARD_TTL_SECONDS = 30;

/** ARGV[3] = '1'이면 비어 있을 때만 쓴다(깨우기의 회수용 — 더 새로운 끊김 시각을 낡은 값으로 덮지 않게, 리뷰 R3) */
export const MATCH_SET_DISCONNECTED_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') ~= 'PLAYING' then return 0 end
if ARGV[3] == '1' then
  local cur = redis.call('HGET', KEYS[1], ARGV[1])
  if cur and cur ~= '' then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1
`;

export interface ScriptKo {
  playerId: string;
  /** 마지막으로 가비지를 보낸 사람, 없으면 null */
  by: string | null;
  place: number;
  reason: KoReason;
}

export interface LockScriptResult {
  ok: boolean;
  /** ok=false일 때: MATCH_NOT_FOUND · MATCH_ENDED(이미 끝남) · PLAYER_NOT_ALIVE · LOCK_OUT_OF_ORDER · LOCK_TOO_FAST(게임 시간 상한 위반) */
  code?: 'MATCH_NOT_FOUND' | 'MATCH_ENDED' | 'PLAYER_NOT_ALIVE' | 'LOCK_OUT_OF_ORDER' | 'LOCK_TOO_FAST';
  dup: boolean;
  /** 이번 lock의 공격을 받은 플레이어 (없으면 null) */
  target: string | null;
  /** 대상 기준 가비지 id (공격이 없으면 0) */
  gid: number;
  nextTarget: string | null;
  kos: ScriptKo[];
  ended: boolean;
}

export interface KoScriptResult {
  ok: boolean;
  code?: 'MATCH_NOT_FOUND' | 'MATCH_ENDED';
  kos: ScriptKo[];
  ended: boolean;
}

export interface MatchPlayerSnapshot {
  playerId: string;
  name: string;
  userId: number | null;
  alive: boolean;
  seq: number;
  frame: number;
  pieces: number;
  sent: number;
  received: number;
  maxCombo: number;
  kos: number;
  board: string | null;
  pending: number;
  combo: number;
  b2b: boolean;
  place: number | null;
  frames: number | null;
  koReason: KoReason | null;
  disconnectedAt: number | null;
  /** 탈락 시각(Redis TIME ms) — 경기 후 검증의 가비지 누락 허용 경계 */
  koClock: number | null;
  /** 시작 시점 재연결 토큰 해시(sha256 hex) — 리플레이 제출 인증 */
  tokenHash: string | null;
}

export interface MatchSnapshot {
  matchId: string;
  code: string;
  seed: number;
  startedAt: number;
  status: 'PLAYING' | 'ENDED';
  roomName: string;
  /** Redis 시계 — 경기 0프레임(시작 + 카운트다운) */
  clockStart: number | null;
  /** Redis 시계 — 종료 */
  endedClock: number | null;
  /** 앱 시계 — 종료 (제출 마감 기준) */
  endedAt: number | null;
  players: MatchPlayerSnapshot[];
}

interface RawScriptReply {
  ok: boolean;
  code?: string;
  dup?: boolean;
  target?: string;
  gid?: number;
  nextTarget?: string;
  kos?: Array<{ playerId: string; by: string; place: number; reason: string }> | Record<string, never>;
  ended?: boolean;
}

const orNull = (s: string | undefined): string | null => (s ? s : null);

/** cjson은 빈 배열을 {}로 인코딩한다 */
const parseKos = (raw: RawScriptReply['kos']): ScriptKo[] =>
  Array.isArray(raw)
    ? raw.map((k) => ({ playerId: k.playerId, by: orNull(k.by), place: Number(k.place), reason: k.reason as KoReason }))
    : [];

/**
 * 매치 Redis 접근 (상태 없음 — Redis 클라이언트는 호출마다 받는다).
 * 방 서비스가 소유하고, 게이트웨이는 직접 쓰지 않는다.
 */
export class TetrisBattleMatchStore {
  async create(
    redis: Redis,
    match: {
      matchId: string;
      code: string;
      seed: number;
      startedAt: number;
      roomName: string;
      players: { playerId: string; name: string; userId: number | null; tokenHash: string }[];
    },
  ): Promise<void> {
    // 경기 시계는 Redis 시각 기준 — lock 프레임 상한을 레플리카 시계와 무관하게 판정한다
    const [sec, usec] = await redis.time();
    const clockStart = Number(sec) * 1000 + Math.floor(Number(usec) / 1000) + MATCH_START_DELAY_MS;
    const fields: Record<string, string> = {
      code: match.code,
      clockStart: String(clockStart),
      roomName: match.roomName,
      seed: String(match.seed),
      startedAt: String(match.startedAt),
      status: 'PLAYING',
      aliveCount: String(match.players.length),
      pids: match.players.map((p) => p.playerId).join(','),
    };
    for (const p of match.players) {
      fields[`p:${p.playerId}:name`] = p.name;
      fields[`p:${p.playerId}:userId`] = p.userId === null ? '' : String(p.userId);
      fields[`p:${p.playerId}:alive`] = '1';
      fields[`p:${p.playerId}:discAt`] = '';
      fields[`p:${p.playerId}:tokenHash`] = p.tokenHash;
    }
    await redis.multi().hset(matchKey(match.matchId), fields).expire(matchKey(match.matchId), MATCH_TTL_SECONDS).exec();
  }

  async remove(redis: Redis, matchId: string): Promise<void> {
    await redis.del(matchKey(matchId));
  }

  async lock(
    redis: Redis,
    matchId: string,
    pids: string[],
    input: {
      playerId: string;
      seq: number;
      frame: number;
      sent: number;
      combo: number;
      b2b: boolean;
      board: string;
      pending: number;
      hole: number;
    },
    now: number,
  ): Promise<LockScriptResult> {
    const raw = await redis.eval(
      MATCH_LOCK_SCRIPT,
      2 + pids.length,
      matchKey(matchId),
      ...pids.map((p) => garbageLogKey(matchId, p)),
      sentLogKey(matchId, input.playerId),
      String(now),
      String(DISCONNECT_GRACE_MS),
      String(MATCH_TTL_SECONDS),
      input.playerId,
      String(input.seq),
      String(input.frame),
      String(input.sent),
      String(input.combo),
      input.b2b ? '1' : '0',
      input.board,
      String(input.pending),
      String(input.hole),
      String(MAX_GARBAGE_EVENTS),
      String(FRAMES_PER_SECOND),
      String(LOCK_FRAME_SLACK),
      String(SPAWN_DELAY_FRAMES),
    );
    const r = JSON.parse(String(raw)) as RawScriptReply;
    return {
      ok: r.ok,
      code: r.code as LockScriptResult['code'],
      dup: r.dup === true,
      target: orNull(r.target),
      gid: Number(r.gid ?? 0),
      nextTarget: orNull(r.nextTarget),
      kos: parseKos(r.kos),
      ended: r.ended === true,
    };
  }

  /** playerId가 null이면 끊김 유예 지난 플레이어 정리(KO)만 한다 */
  async knockOut(
    redis: Redis,
    matchId: string,
    pids: string[],
    playerId: string | null,
    reason: KoReason,
    frame: number | null,
    now: number,
  ): Promise<KoScriptResult> {
    const raw = await redis.eval(
      MATCH_KO_SCRIPT,
      1 + pids.length,
      matchKey(matchId),
      ...pids.map((p) => garbageLogKey(matchId, p)),
      String(now),
      String(DISCONNECT_GRACE_MS),
      String(MATCH_TTL_SECONDS),
      playerId ?? '',
      reason,
      frame === null ? '' : String(frame),
    );
    const r = JSON.parse(String(raw)) as RawScriptReply;
    return { ok: r.ok, code: r.code as KoScriptResult['code'], kos: parseKos(r.kos), ended: r.ended === true };
  }

  /** 끊김 시각 기록(null = 다시 연결). 매치가 진행 중일 때만 쓴다. onlyIfEmpty면 이미 기록이 있을 때 그대로 둔다 */
  async setDisconnectedAt(
    redis: Redis,
    matchId: string,
    playerId: string,
    at: number | null,
    { onlyIfEmpty = false }: { onlyIfEmpty?: boolean } = {},
  ): Promise<void> {
    await redis.eval(
      MATCH_SET_DISCONNECTED_SCRIPT,
      1,
      matchKey(matchId),
      `p:${playerId}:discAt`,
      at === null ? '' : String(at),
      onlyIfEmpty ? '1' : '0',
    );
  }

  async snapshot(redis: Redis, matchId: string): Promise<MatchSnapshot | null> {
    const h = await redis.hgetall(matchKey(matchId));
    if (!h.pids) return null;
    const num = (v: string | undefined, d = 0) => (v === undefined || v === '' ? d : Number(v));
    const players = h.pids.split(',').map((pid): MatchPlayerSnapshot => {
      const f = (name: string) => h[`p:${pid}:${name}`];
      return {
        playerId: pid,
        name: f('name') ?? '',
        userId: f('userId') ? Number(f('userId')) : null,
        alive: f('alive') === '1',
        seq: num(f('seq')),
        frame: num(f('frame')),
        pieces: num(f('pieces')),
        sent: num(f('sent')),
        received: num(f('recv')),
        maxCombo: num(f('maxCombo')),
        kos: num(f('kos')),
        board: f('board') || null,
        pending: num(f('pending')),
        combo: num(f('combo'), -1),
        b2b: f('b2b') === '1',
        place: f('place') ? Number(f('place')) : null,
        frames: f('frames') ? Number(f('frames')) : null,
        koReason: (f('koReason') || null) as KoReason | null,
        disconnectedAt: f('discAt') ? Number(f('discAt')) : null,
        koClock: f('koClock') ? Number(f('koClock')) : null,
        tokenHash: f('tokenHash') || null,
      };
    });
    return {
      matchId,
      code: h.code,
      seed: Number(h.seed),
      startedAt: Number(h.startedAt),
      status: h.status === 'ENDED' ? 'ENDED' : 'PLAYING',
      roomName: h.roomName ?? '',
      clockStart: h.clockStart ? Number(h.clockStart) : null,
      endedClock: h.endedClock ? Number(h.endedClock) : null,
      endedAt: h.endedAt ? Number(h.endedAt) : null,
      players,
    };
  }

  // ==================== 경기 후 검증·저장 (P5) ====================

  /** 받는 플레이어의 가비지 로그 전체 (id·lines·hole·보낸 Redis 시각, 보낸 순서) */
  async garbageLog(
    redis: Redis,
    matchId: string,
    playerId: string,
  ): Promise<{ id: number; lines: number; hole: number; at: number | null }[]> {
    const entries = await redis.lrange(garbageLogKey(matchId, playerId), 0, -1);
    return entries.map((e) => {
      const g = JSON.parse(e) as { id: number; lines: number; hole: number; at?: number };
      return { id: g.id, lines: g.lines, hole: g.hole, at: g.at ?? null };
    });
  }

  /** 보낸 플레이어의 lock별 공격 로그 (sent > 0만, seq 순) */
  async sentLog(redis: Redis, matchId: string, playerId: string): Promise<{ seq: number; sent: number }[]> {
    const entries = await redis.lrange(sentLogKey(matchId, playerId), 0, -1);
    return entries.map((e) => {
      const [seq, sent] = e.split(':').map(Number);
      return { seq, sent };
    });
  }

  /** 리플레이 제출 기록 — 플레이어당 1번, 닫힌 뒤에는 거부 */
  async claimSubmission(
    redis: Redis,
    matchId: string,
    playerId: string,
    record: string,
  ): Promise<'CLAIMED' | 'DUPLICATE' | 'CLOSED'> {
    const r = Number(
      await redis.eval(CLAIM_SUBMISSION_SCRIPT, 1, submissionsKey(matchId), playerId, record, String(MATCH_TTL_SECONDS)),
    );
    return r === 1 ? 'CLAIMED' : r === 0 ? 'DUPLICATE' : 'CLOSED';
  }

  /** 지금까지의 제출 (예약 필드 제외) */
  async submissions(redis: Redis, matchId: string): Promise<Record<string, string>> {
    return withoutReserved(await redis.hgetall(submissionsKey(matchId)));
  }

  /** 제출을 닫고 그 순간의 제출 목록을 돌려준다 — 저장은 이 목록만 쓴다(이후 제출은 410) */
  async closeSubmissions(redis: Redis, matchId: string, now: number): Promise<Record<string, string>> {
    const flat = (await redis.eval(
      CLOSE_SUBMISSIONS_SCRIPT,
      1,
      submissionsKey(matchId),
      String(now),
      String(MATCH_TTL_SECONDS),
    )) as string[];
    const h: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) h[flat[i]] = flat[i + 1];
    return withoutReserved(h);
  }

  /** DB 저장 완료 표시 — 이후 저장 계기는 아무것도 하지 않는다 */
  async markSaved(redis: Redis, matchId: string): Promise<void> {
    await redis.multi().hset(submissionsKey(matchId), '__saved', '1').expire(submissionsKey(matchId), MATCH_TTL_SECONDS).exec();
  }

  async isSaved(redis: Redis, matchId: string): Promise<boolean> {
    return (await redis.hexists(submissionsKey(matchId), '__saved')) === 1;
  }

  /** 제출이 닫혔는지(저장이 목록을 확정함) — 닫혔으면 검증할 필요 없이 410 */
  async isClosed(redis: Redis, matchId: string): Promise<boolean> {
    return (await redis.hexists(submissionsKey(matchId), '__closed')) === 1;
  }

  /**
   * 검증 진행 가드 — 같은 참가자의 제출을 동시에 여러 개 보내도 시뮬레이션은 하나만 돈다(tetris-audit BE-08).
   * 최종 1회 보장은 여전히 claimSubmission(HSETNX). 검증이 끝나면 releaseVerification으로 푼다(실패해도 TTL로 풀림)
   */
  async claimVerification(redis: Redis, matchId: string, playerId: string): Promise<boolean> {
    return (await redis.set(verifyingKey(matchId, playerId), '1', 'EX', VERIFY_GUARD_TTL_SECONDS, 'NX')) === 'OK';
  }

  async releaseVerification(redis: Redis, matchId: string, playerId: string): Promise<void> {
    await redis.del(verifyingKey(matchId, playerId));
  }

  /** 저장 진행 가드 — 처음 잡은 쪽만 true (멀티 레플리카). 짧은 TTL */
  async claimSave(redis: Redis, matchId: string): Promise<boolean> {
    return (await redis.set(savedGuardKey(matchId), '1', 'EX', SAVE_GUARD_TTL_SECONDS, 'NX')) === 'OK';
  }

  /** 경기 중·마감 전 토큰 재발급을 매치에 반영 — 매치 키가 있을 때만(리뷰 L7) */
  async setTokenHash(redis: Redis, matchId: string, playerId: string, tokenHash: string): Promise<void> {
    await redis.eval(MATCH_SET_TOKEN_SCRIPT, 1, matchKey(matchId), `p:${playerId}:tokenHash`, tokenHash);
  }

  /** 저장 대기 등록 — 키 TTL은 매치 TTL로 갱신한다(대기 매치가 오래 없으면 키도 사라진다) */
  async markPendingSave(redis: Redis, matchId: string, dueAt: number): Promise<void> {
    await redis.multi().zadd(pendingSavesKey, dueAt, matchId).expire(pendingSavesKey, MATCH_TTL_SECONDS).exec();
  }

  /** 저장 예정 시각이 지난 대기 매치 — 오래된 순, 최대 limit개 */
  async duePendingSaves(redis: Redis, now: number, limit: number): Promise<string[]> {
    return redis.zrangebyscore(pendingSavesKey, 0, now, 'LIMIT', 0, limit);
  }

  async clearPendingSave(redis: Redis, matchId: string): Promise<void> {
    await redis.zrem(pendingSavesKey, matchId);
  }

  /** 매치 Hash가 아직 있는지 — TTL로 사라졌으면 더 저장할 수 없다 */
  async exists(redis: Redis, matchId: string): Promise<boolean> {
    return (await redis.exists(matchKey(matchId))) === 1;
  }

  /** 저장 실패 시 가드를 풀어 다음 제출·조회가 다시 시도하게 한다 */
  async releaseSave(redis: Redis, matchId: string): Promise<void> {
    await redis.del(savedGuardKey(matchId));
  }

  /** 받는 플레이어 기준 lastGarbageId보다 큰 가비지 (재연결 복구) */
  async garbageSince(redis: Redis, matchId: string, playerId: string, lastGarbageId: number): Promise<GarbagePayload[]> {
    const entries = await redis.lrange(garbageLogKey(matchId, playerId), 0, -1);
    return entries
      .map((e) => JSON.parse(e) as { id: number; lines: number; hole: number; from: string })
      .filter((e) => e.id > lastGarbageId)
      .map((e) => ({ matchId, id: e.id, lines: e.lines, hole: e.hole, from: e.from }));
  }
}

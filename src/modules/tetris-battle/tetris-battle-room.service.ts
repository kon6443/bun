import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'crypto';
import type { Redis } from 'ioredis';
import { promisify } from 'util';
import { checkPlayerName, containsForbiddenWord } from '../games/player-name-policy';
import {
  DISCONNECT_GRACE_MS,
  LIVENESS_MIN_CONNECTED_MS,
  LIVENESS_PROBE_INTERVAL_MS,
  LOBBY_LIST_LIMIT,
  LOBBY_SCAN_LIMIT,
  MATCH_START_DELAY_MS,
  PASSWORD_FAILURE_LIMIT,
  PASSWORD_FAILURE_LIMIT_IP,
  PASSWORD_KEY_LENGTH,
  PASSWORD_SALT_BYTES,
  PLAYER_TOKEN_BYTES,
  ROOM_CAS_MAX_ATTEMPTS,
  ROOM_CODE_MAX_ATTEMPTS,
  ROOM_TTL_SECONDS,
  TETRIS_BATTLE_RATE_LIMITS,
  TetrisBattleRateLimitAction,
} from './tetris-battle.constants';
import { TetrisBattleError } from './tetris-battle.errors';
import { GARBAGE_HOLE_MAX } from './battle-engine';
import { SEED_MAX } from './battle-engine/engine';
import { MatchSnapshot, ScriptKo, TetrisBattleMatchStore } from './tetris-battle-match.store';
import {
  AttackPayload,
  BOARD_BYTES,
  BOARD_CELL_MAX,
  ChatMessagePayload,
  EmoteReceivedPayload,
  GarbagePayload,
  MatchEndedPayload,
  MatchResultEntry,
  MatchStartingPayload,
  OpponentUpdatePayload,
  PlayerKOPayload,
  RejoinData,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_NAME_MAX_LENGTH,
  RoomPlayer,
  RoomState,
  RoomStatus,
  RoomSummary,
  TetrisBattleEmoteId,
} from './tetris-battle.events';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * Redis 키 (모두 TTL 있음 — DECISIONS D-012: allkeys-lru라 TTL 없는 키가 쌓이면 다른 키가 밀려난다)
 *
 * | 키 | 타입 | TTL |
 * |---|---|---|
 * | tetris-battle:room:{code} | Hash { v: 버전, json: StoredRoom } | ROOM_TTL_SECONDS, 쓰기마다 갱신 |
 * | tetris-battle:rooms | ZSET code → 생성 시각(ms) — 로비 인덱스 | ROOM_TTL_SECONDS, 쓰기마다 갱신 |
 * | tetris-battle:rl:{action}:{subject} | String 카운터 | 윈도(초) |
 * | tetris-battle:pwfail:{code}:{socketId} | String 카운터 | PASSWORD_FAILURE_LIMIT.windowSec |
 * | tetris-battle:pwfail-ip:{code}:{ip} | String 카운터 | PASSWORD_FAILURE_LIMIT_IP.windowSec |
 * | tetris-battle:probe:{code} | String — 생존 확인 간격 게이트(SET NX PX) | LIVENESS_PROBE_INTERVAL_MS |
 *
 * 로비 인덱스에 남은 코드의 방 키가 TTL로 사라졌으면 listRooms가 발견 즉시 ZREM한다.
 */
const roomKey = (code: string) => `tetris-battle:room:${code}`;
const LOBBY_INDEX_KEY = 'tetris-battle:rooms';
const rateLimitKey = (action: string, subject: string) => `tetris-battle:rl:${action}:${subject}`;
const passwordFailKey = (code: string, socketId: string) => `tetris-battle:pwfail:${code}:${socketId}`;
const passwordFailIpKey = (code: string, ip: string) => `tetris-battle:pwfail-ip:${code}:${ip}`;
const probeKey = (code: string) => `tetris-battle:probe:${code}`;

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

/** Redis에 저장하는 플레이어 — 토큰은 해시만, socketId는 멤버십 판정 기준 */
export interface StoredPlayer {
  playerId: string;
  name: string;
  ready: boolean;
  connected: boolean;
  /** 로그인 유저면 userId (대전 결과 저장 D-008·D-011), 게스트면 null */
  userId: number | null;
  /** sha256(playerToken) hex */
  tokenHash: string;
  /** 지금 이 플레이어를 대표하는 소켓. 끊기면 null */
  socketId: string | null;
  joinedAt: number;
  /** 마지막으로 (재)연결된 시각 — 생존 확인이 막 들어온 플레이어를 유령으로 오판하지 않게 */
  connectedAt: number;
  disconnectedAt: number | null;
}

export interface StoredRoom {
  code: string;
  name: string;
  maxPlayers: number;
  /** `scrypt$<salt b64>$<key b64>` 또는 null(공개 방) */
  passwordHash: string | null;
  hostId: string;
  status: RoomStatus;
  createdAt: number;
  /** 다음 playerId 번호 — 방 수명 동안 playerId를 재사용하지 않는다 */
  nextPlayerSeq: number;
  /** 입장 순서 */
  players: StoredPlayer[];
  /**
   * 진행 중(PLAYING)이거나 직전(RESULT) 매치. 매치 상태 자체는 별도 키(tetris-battle-match.store.ts) —
   * 여기에는 lock 경로가 매치 Hash를 읽지 않고도 Lua KEYS를 만들 수 있게 참가자 순서만 둔다. 없으면 null(옛 기록은 undefined)
   */
  match?: StoredMatchRef | null;
}

export interface StoredMatchRef {
  matchId: string;
  seed: number;
  startedAt: number;
  /** 참가자 playerId (입장 순서) — 매치 Hash `pids`와 같다 */
  playerIds: string[];
}

/** 게이트웨이가 방에 보낼 매치 이벤트 (KO 순서대로, 종료면 ended) */
export interface MatchEvents {
  matchId: string;
  kos: PlayerKOPayload[];
  ended: MatchEndedPayload | null;
}

/** lock 처리 결과 — 게이트웨이가 그대로 방송한다 */
export interface LockOutcome {
  /** ack: 다음 공격 대상 */
  targetId: string | null;
  /** 재전송(seq 중복)이면 true — 방송 없음 */
  duplicate: boolean;
  /** 대상 플레이어 채널로 (끊겨 있어도 보낸다 — 아무도 없으면 재연결 때 lastGarbageId로 복구) */
  garbage: { toPlayerId: string; payload: GarbagePayload } | null;
  attack: AttackPayload | null;
  opponentUpdate: OpponentUpdatePayload | null;
  match: MatchEvents;
  /** 매치가 끝나 방이 RESULT가 됐으면 */
  roomChange: RoomChangeResult | null;
}

/** 백그라운드 경로(끊김 유예 KO 등)에서 생긴 매치 이벤트를 알리는 콜백 — 게이트웨이가 방송 */
export type MatchEventListener = (code: string, events: MatchEvents) => void;

/** 요청한 소켓의 신원 — 게이트웨이가 소켓에서 꺼내 넘긴다(클라이언트 페이로드에서 받지 않는다) */
export interface SocketIdentity {
  socketId: string;
  userId: number | null;
  /** 빈도 제한·비밀번호 잠금용 IP (X-Forwarded-For 마지막 값 — 게이트웨이 clientIp) */
  ip: string;
}

export interface EnterRoomResult {
  /** 경기 중 재연결이면 복구 정보 */
  rejoin?: RejoinData;
  /** 재연결 중 끊김 유예 정리로 생긴 KO·종료 */
  match?: MatchEvents;
  room: RoomState;
  playerId: string;
  playerToken: string;
  /** 재연결로 이 플레이어를 넘겨받았을 때 이전 소켓 id — 게이트웨이가 그 소켓을 방 채널에서 뺀다 */
  replacedSocketId: string | null;
  /** 로비 목록에 보이는 값(인원 등)이 바뀌었는지 — true면 게이트웨이가 roomsChanged를 보낸다 */
  lobbyChanged: boolean;
}

export interface RoomChangeResult {
  /** 변경 후 방 상태. 방이 삭제됐으면 null */
  room: RoomState | null;
  lobbyChanged: boolean;
  /** 경기 중 이탈(기권 KO) 등으로 생긴 매치 이벤트 */
  match?: MatchEvents;
}

/**
 * 방 채널에 지금 붙어 있는 소켓 id 집합(전 레플리카). 게이트웨이가 주입한다 — 서비스가 socket.io 서버에 직접 의존하지 않게.
 * 실패(타임아웃 등)면 throw — 호출 쪽은 이번 확인을 건너뛴다.
 */
export type LiveSocketProbe = (code: string) => Promise<Set<string>>;

/**
 * 요청 결과로 돌려줄 수 없는 방 변경(정리만 일어난 경우·전원 정리로 삭제·생존 확인)을 알리는 콜백.
 * 게이트웨이가 roomState·roomsChanged로 방송한다. room=null이면 방이 삭제됨.
 */
export type RoomChangeListener = (code: string, room: RoomState | null, lobbyChanged: boolean) => void;

interface MutationOutcome<T> {
  result: T;
  /** true면 방을 지운다 */
  deleteRoom?: boolean;
}

/** WAITING 방 우선, 같은 상태면 최근 생성 순 */
const STATUS_ORDER: Record<RoomStatus, number> = { WAITING: 0, PLAYING: 1, RESULT: 2 };

/**
 * 방 이름·채팅에 금지하는 문자: 제어(Cc)·서로게이트(Cs)·사용자 정의(Co)·미할당(Cn) + bidi 제어
 * (U+202A–202E 임베딩·오버라이드, U+2066–2069 격리, U+200E·200F 방향 표시, U+061C 아랍 문자 표시).
 * 서식 문자(Cf) 전체를 막지 않는 이유: ZWJ(U+200D)·이모지 변형 선택자(U+FE0F) 등 이모지 구성 문자가 Cf/Mn이라
 * 👩‍💻 같은 이모지가 막힌다. 제로폭 문자로 금칙어를 쪼개는 우회는 금칙어 정규화(한글·영문만 남김)가 막는다.
 */
const DISALLOWED_CHARS = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u;

export const containsDisallowedChars = (text: string): boolean => DISALLOWED_CHARS.test(text);

@Injectable()
export class TetrisBattleRoomService {
  private readonly logger = new Logger(TetrisBattleRoomService.name);
  private redis: Redis | null = null;
  private liveSocketProbe: LiveSocketProbe | null = null;
  private changeListener: RoomChangeListener | null = null;
  private matchListener: MatchEventListener | null = null;
  private readonly matches = new TetrisBattleMatchStore();

  /** main.ts에서 RedisIoAdapter 초기화 후 호출 (GameSessionService와 같은 방식) */
  setRedisClient(client: Redis): void {
    this.redis = client;
  }

  /** 경기 후 검증(P5, REST)이 같은 Redis 연결을 쓴다. 준비되지 않았으면 null */
  readyRedisClient(): Redis | null {
    return this.redis && this.redis.status === 'ready' ? this.redis : null;
  }

  /** 게이트웨이 afterInit에서 주입 */
  setLiveSocketProbe(probe: LiveSocketProbe): void {
    this.liveSocketProbe = probe;
  }

  /** 게이트웨이 afterInit에서 주입 */
  setChangeListener(listener: RoomChangeListener): void {
    this.changeListener = listener;
  }

  /** 게이트웨이 afterInit에서 주입 */
  setMatchListener(listener: MatchEventListener): void {
    this.matchListener = listener;
  }

  // ==================== 로비 ====================

  async listRooms(now = Date.now()): Promise<RoomSummary[]> {
    const redis = this.requireRedis();
    const codes = await redis.zrevrange(LOBBY_INDEX_KEY, 0, LOBBY_SCAN_LIMIT - 1);
    if (codes.length === 0) return [];

    const pipeline = redis.pipeline();
    for (const code of codes) pipeline.hget(roomKey(code), 'json');
    const results = (await pipeline.exec()) ?? [];

    const summaries: RoomSummary[] = [];
    const vanished: string[] = [];
    codes.forEach((code, i) => {
      const json = results[i]?.[1];
      if (typeof json !== 'string') {
        vanished.push(code);
        return;
      }
      // 읽기 전용 정리 — 유예가 지난 끊긴 플레이어는 목록 인원에서 뺀다(실제 제거는 다음 변경 때)
      const room = this.pruneDisconnected(JSON.parse(json) as StoredRoom, now);
      if (room.players.length > 0) summaries.push(this.toSummary(room));
    });

    // 보여 줄 방의 유령 확인 — 응답을 늦추지 않게 기다리지 않는다(바뀌면 changeListener가 방송)
    for (const summary of summaries.slice(0, LOBBY_LIST_LIMIT)) {
      void this.reconcileLiveness(redis, summary.code, now);
    }

    if (vanished.length > 0) {
      // TTL로 사라진 방을 인덱스에서 정리 — 실패해도 다음 조회에서 다시 시도된다
      redis.zrem(LOBBY_INDEX_KEY, ...vanished).catch((error: unknown) => {
        this.logger.warn(`로비 인덱스 정리 실패: ${(error as Error).message}`);
      });
    }

    return summaries
      .map((summary, index) => ({ summary, index }))
      .sort((a, b) => STATUS_ORDER[a.summary.status] - STATUS_ORDER[b.summary.status] || a.index - b.index)
      .slice(0, LOBBY_LIST_LIMIT)
      .map(({ summary }) => summary);
  }

  // ==================== 생성·입장·이탈 ====================

  /**
   * 방 생성. `beforeCommit`은 검증(이름·비밀번호 해시)이 끝난 뒤, 저장 직전에 한 번 불린다 —
   * 게이트웨이가 이전 방 이탈을 여기서 해, 검증 실패로 현재 방에서 빠지는 일이 없게 한다(리뷰 G6).
   */
  async createRoom(
    input: { name: string; maxPlayers: number; password?: string; playerName: string },
    who: SocketIdentity,
    now = Date.now(),
    beforeCommit?: () => Promise<void>,
  ): Promise<EnterRoomResult> {
    this.assertRoomName(input.name);
    this.assertPlayerName(input.playerName);
    const redis = this.requireRedis();

    const passwordHash = input.password ? await this.hashPassword(input.password) : null;
    await beforeCommit?.();
    const { token, tokenHash } = this.issueToken();
    const playerId = 'p1';

    for (let attempt = 0; attempt < ROOM_CODE_MAX_ATTEMPTS; attempt++) {
      const room: StoredRoom = {
        code: this.generateCode(),
        name: input.name,
        maxPlayers: input.maxPlayers,
        passwordHash,
        hostId: playerId,
        status: 'WAITING',
        createdAt: now,
        nextPlayerSeq: 2,
        players: [this.newPlayer(playerId, input.playerName, who, tokenHash, now)],
        match: null,
      };
      // 기대 버전 '0' = 같은 코드의 방이 없을 때만 만든다 (코드 충돌이면 새 코드로 재시도)
      if (await this.compareAndSet(redis, room.code, '0', room)) {
        return { room: this.toRoomState(room), playerId, playerToken: token, replacedSocketId: null, lobbyChanged: true };
      }
    }
    throw new TetrisBattleError('ROOM_BUSY');
  }

  /**
   * 입장. 세 갈래:
   *  1. `playerToken`이 이 방의 플레이어와 맞으면 재연결 — 같은 playerId로 복귀(비밀번호·상태·정원 검사 없음)
   *  2. 이 소켓이 이미 이 방의 플레이어면 토큰만 재발급(클라이언트가 토큰을 잃은 경우)
   *  3. 새 플레이어 — 이름·상태(WAITING)·정원·비밀번호 검사
   *
   * 저장 전에 읽은 방으로 같은 검사를 먼저 하고(사전 검증), 통과하면 `beforeCommit`(게이트웨이의 이전 방 이탈)을 부른 뒤
   * CAS 안에서 다시 검사해 저장한다 — 오답·만원 등으로 실패하면 현재 방에 그대로 남는다(리뷰 G6).
   * 사전 검증과 저장 사이에 다른 사람이 들어와 만원이 되는 좁은 창은 수용한다(그때는 이전 방에서 빠진 채 ROOM_FULL).
   */
  async joinRoom(
    input: { code: string; password?: string; playerName: string; playerToken?: string; lastGarbageId?: number },
    who: SocketIdentity,
    now = Date.now(),
    beforeCommit?: () => Promise<void>,
    afterCommit?: (entered: EnterRoomResult) => Promise<void>,
  ): Promise<EnterRoomResult> {
    const entered = await this.commitJoin(input, who, now, beforeCommit);
    // 게이트웨이가 여기서 소켓을 방·플레이어 채널에 넣는다 — 놓친 가비지 조회(아래)보다 **먼저**여야
    // 조회 이후 생기는 가비지를 채널로 받는다(리뷰 H2)
    await afterCommit?.(entered);
    if (!input.playerToken) return entered;
    // 경기 중 재연결 — 놓친 가비지·상대 판 복구 (DESIGN §16)
    const recovered = await this.recoverMatch(input.code, entered.playerId, who.socketId, input.lastGarbageId ?? 0, now);
    return recovered ? { ...entered, ...recovered } : entered;
  }

  private async commitJoin(
    input: { code: string; password?: string; playerName: string; playerToken?: string },
    who: SocketIdentity,
    now: number,
    beforeCommit?: () => Promise<void>,
  ): Promise<EnterRoomResult> {
    const redis = this.requireRedis();
    void this.reconcileLiveness(redis, input.code, now);
    const current = await this.loadRoom(redis, input.code);
    if (!current) throw new TetrisBattleError('ROOM_NOT_FOUND');

    const tokenHash = input.playerToken ? this.hashToken(input.playerToken) : null;
    const isRejoin = tokenHash !== null;
    const isSameSocket = current.room.players.some((p) => p.socketId === who.socketId);

    // ---- 사전 검증 (CAS 밖, 읽은 방 기준) ----
    // 재연결이 아니면 이름은 항상 본다. 비밀번호는 "지금 이 소켓이 멤버가 아니면" 검증한다
    // (해시는 방 수명 동안 바뀌지 않는다). 검증하지 않았다면 아래 새 플레이어 갈래에서 추가하지 않는다.
    if (isRejoin) {
      if (!current.room.players.some((p) => this.tokenMatches(p.tokenHash, tokenHash))) {
        throw new TetrisBattleError('INVALID_PLAYER_TOKEN');
      }
    } else {
      this.assertPlayerName(input.playerName);
    }
    let passwordVerified = current.room.passwordHash === null;
    if (!isRejoin && !isSameSocket) {
      const view = this.pruneDisconnected(current.room, now);
      if (view.status !== 'WAITING') throw new TetrisBattleError('MATCH_ALREADY_STARTED');
      if (view.players.length >= view.maxPlayers) throw new TetrisBattleError('ROOM_FULL');
      if (current.room.passwordHash) {
        await this.verifyPasswordOrThrow(redis, current.room, input.password, who);
        passwordVerified = true;
      }
    }

    await beforeCommit?.();
    const fresh = this.issueToken();

    let rotatedInMatch: { matchId: string; playerId: string } | null = null;
    const entered = await this.mutateRoom(redis, input.code, now, (room, before) => {
      rotatedInMatch = null;
      if (tokenHash) {
        const player = room.players.find((p) => this.tokenMatches(p.tokenHash, tokenHash));
        if (!player) throw new TetrisBattleError('INVALID_PLAYER_TOKEN');
        // 이 소켓이 이미 같은 방의 다른 플레이어를 대표하면 한 소켓이 두 자리를 잡게 된다 → 거부
        if (room.players.some((p) => p !== player && p.socketId === who.socketId)) {
          throw new TetrisBattleError('INVALID_PLAYER_TOKEN');
        }
        const replacedSocketId = player.socketId && player.socketId !== who.socketId ? player.socketId : null;
        player.socketId = who.socketId;
        player.connected = true;
        player.connectedAt = now;
        player.disconnectedAt = null;
        return {
          result: this.enterResult(room, before, player.playerId, input.playerToken as string, replacedSocketId),
        };
      }

      const self = room.players.find((p) => p.socketId === who.socketId);
      if (self) {
        self.tokenHash = fresh.tokenHash;
        if (room.match?.playerIds.includes(self.playerId)) {
          rotatedInMatch = { matchId: room.match.matchId, playerId: self.playerId };
        }
        return { result: this.enterResult(room, before, self.playerId, fresh.token, null) };
      }

      // 읽을 때는 멤버였는데(비밀번호 생략) 그 사이 이탈·정리돼 새 플레이어 갈래로 왔다 → 비밀번호 없이 추가하지 않는다.
      // 일시적 경합이라 ROOM_BUSY — 재시도하면 새 입장으로 비밀번호를 검증한다
      if (!passwordVerified) throw new TetrisBattleError('ROOM_BUSY');
      if (room.status !== 'WAITING') throw new TetrisBattleError('MATCH_ALREADY_STARTED');
      if (room.players.length >= room.maxPlayers) throw new TetrisBattleError('ROOM_FULL');

      const playerId = `p${room.nextPlayerSeq}`;
      room.nextPlayerSeq += 1;
      room.players.push(this.newPlayer(playerId, input.playerName, who, fresh.tokenHash, now));
      return { result: this.enterResult(room, before, playerId, fresh.token, null) };
    });

    // 경기 중·결과 화면에서 토큰을 재발급했으면 매치에 복사한 토큰 해시도 갱신한다 — 안 하면 새 토큰으로
    // 리플레이를 제출할 때 403이 된다(리뷰 L7). 매치 키가 있을 때만 쓴다(마감 뒤 제출은 어차피 410)
    const rotated = rotatedInMatch as { matchId: string; playerId: string } | null;
    if (rotated) await this.matches.setTokenHash(redis, rotated.matchId, rotated.playerId, fresh.tokenHash);
    return entered;
  }

  /**
   * 이탈. 방장이 나가면 다음 입장자에게 이양, 마지막 사람이 나가면 방 삭제.
   * P2: PLAYING 중 이탈은 기권(KO reason `leave`) 처리를 여기 앞단에 붙인다.
   */
  async leaveRoom(code: string, socketId: string, now = Date.now()): Promise<RoomChangeResult> {
    const redis = this.requireRedis();
    void this.reconcileLiveness(redis, code, now);

    // 경기 중 이탈 = 기권 KO(reason leave). KO 대상인지는 **이탈을 커밋한 그 방 상태**로 정한다(리뷰 H1) —
    // CAS 밖에서 읽으면 "읽을 땐 WAITING → 그 사이 시작 커밋 → 이탈 커밋"에서 매치에 유령 참가자가 남는다
    let koTarget: { matchId: string; playerIds: string[]; playerId: string } | null = null;
    const change = await this.mutateRoom<RoomChangeResult>(redis, code, now, (room, before) => {
      koTarget = null;
      const player = this.requireMember(room, socketId);
      if (room.status === 'PLAYING' && room.match?.playerIds.includes(player.playerId)) {
        koTarget = { matchId: room.match.matchId, playerIds: room.match.playerIds, playerId: player.playerId };
      }
      this.removePlayer(room, player.playerId);
      if (room.players.length === 0) return { result: { room: null, lobbyChanged: true }, deleteRoom: true };
      return { result: this.changeResult(room, before) };
    });

    const target = koTarget as { matchId: string; playerIds: string[]; playerId: string } | null;
    if (!target) return change;
    // 방에서는 이미 나갔다 — 여기서부터의 실패는 이탈을 되돌리지 않는다(리뷰 J2).
    // KO가 실패하면 끊김 시각을 남겨 유예 뒤 정리(sweep)가 KO하게 하고, 그것도 실패하면 로그만 남긴다
    let ko: Awaited<ReturnType<TetrisBattleMatchStore['knockOut']>>;
    try {
      ko = await this.matches.knockOut(redis, target.matchId, target.playerIds, target.playerId, 'leave', null, now);
    } catch (error) {
      this.logger.warn(`경기 중 이탈 KO 실패 — 유예 뒤 정리로 회수: code=${code}, ${(error as Error).message}`);
      await this.matches.setDisconnectedAt(redis, target.matchId, target.playerId, now).catch((e: unknown) => {
        this.logger.warn(`이탈 끊김 기록도 실패: code=${code}, ${(e as Error).message}`);
      });
      return change;
    }
    const match: MatchEvents = { matchId: target.matchId, kos: this.toKoPayloads(target.matchId, ko.kos), ended: null };
    const finished = ko.ended ? await this.finishMatch(redis, code, target.matchId, now, match) : null;
    return finished
      ? { room: finished.room, lobbyChanged: change.lobbyChanged || finished.lobbyChanged, match }
      : { ...change, match };
  }

  async setReady(code: string, socketId: string, ready: boolean, now = Date.now()): Promise<RoomChangeResult> {
    const redis = this.requireRedis();
    void this.reconcileLiveness(redis, code, now);
    // 빈도 제한은 방·플레이어 단위(토글 연타가 방 전체 방송 폭주가 되지 않게)
    const member = await this.requireMemberOf(redis, code, socketId);
    if (!(await this.consumeRateLimit('setReady', `${code}:${member.playerId}`))) {
      throw new TetrisBattleError('RATE_LIMITED');
    }
    return this.mutateRoom(redis, code, now, (room, before) => {
      const player = this.requireMember(room, socketId);
      if (room.status !== 'WAITING') throw new TetrisBattleError('MATCH_ALREADY_STARTED');
      player.ready = ready;
      return { result: this.changeResult(room, before) };
    });
  }

  /**
   * 소켓 끊김 — connected=false만 표시하고 자리는 유예(DISCONNECT_GRACE_MS) 동안 남긴다.
   * 유예가 지난 플레이어는 이후 아무 변경(입장·이탈·준비·끊김)이 일어날 때 정리된다(lazy, 인메모리 타이머 없음).
   * 이 소켓이 이미 대표 소켓이 아니면(재연결로 넘겨줌·이탈함) 아무것도 바꾸지 않는다.
   */
  async markDisconnected(code: string, socketId: string, now = Date.now()): Promise<RoomChangeResult | null> {
    const redis = this.requireRedis();
    try {
      let inMatch: { matchId: string; playerId: string } | null = null;
      const change = await this.mutateRoom<RoomChangeResult | null>(redis, code, now, (room, before) => {
        inMatch = null;
        const player = room.players.find((p) => p.socketId === socketId);
        if (!player) return { result: null };
        player.socketId = null;
        player.connected = false;
        player.disconnectedAt = now;
        if (room.status === 'PLAYING' && room.match?.playerIds.includes(player.playerId)) {
          inMatch = { matchId: room.match.matchId, playerId: player.playerId };
        }
        return { result: this.changeResult(room, before) };
      });
      // 경기 중이면 매치에도 끊김 시각을 남긴다 → 유예(10초)가 지나면 다음 lock·이벤트에서 KO(disconnect)
      const marked = inMatch as { matchId: string; playerId: string } | null;
      if (marked) await this.markMatchDisconnected(redis, code, marked.matchId, marked.playerId, now);
      return change;
    } catch (error) {
      if (error instanceof TetrisBattleError && error.code === 'ROOM_NOT_FOUND') return null;
      throw error;
    }
  }

  // ==================== 매치 (P2) ====================

  /**
   * 경기 시작 — 방장, WAITING, 플레이어 2명↑, 방장 포함 전원 연결, 방장 외 전원 준비(D-019).
   * 매치 Hash를 먼저 만들고(실패해도 고아 키는 TTL로 사라짐) 방 CAS에서 같은 참가자인지 다시 확인한다 —
   * 그 사이 누가 들어오거나 나갔으면 ROOM_BUSY(방장이 다시 누르면 된다).
   */
  async startMatch(
    code: string,
    socketId: string,
    now = Date.now(),
  ): Promise<RoomChangeResult & { starting: MatchStartingPayload }> {
    const redis = this.requireRedis();
    const loaded = await this.loadRoom(redis, code);
    if (!loaded) throw new TetrisBattleError('ROOM_NOT_FOUND');
    const view = this.pruneDisconnected(loaded.room, now);
    this.assertCanStart(view, socketId);

    const ref: StoredMatchRef = {
      matchId: randomBytes(12).toString('base64url'),
      seed: randomInt(0, SEED_MAX + 1),
      startedAt: now,
      playerIds: view.players.map((p) => p.playerId),
    };
    await this.matches.create(redis, {
      matchId: ref.matchId,
      code,
      seed: ref.seed,
      startedAt: now,
      roomName: view.name,
      // 토큰 해시를 매치에 복사 — 경기 후 리플레이 제출 인증(P5)이 rematch·이탈 뒤에도 그 경기 기준으로 된다
      players: view.players.map((p) => ({ playerId: p.playerId, name: p.name, userId: p.userId, tokenHash: p.tokenHash })),
    });

    try {
      const change = await this.mutateRoom<RoomChangeResult>(redis, code, now, (room, before) => {
        this.assertCanStart(room, socketId);
        const ids = room.players.map((p) => p.playerId);
        if (ids.join(',') !== ref.playerIds.join(',')) throw new TetrisBattleError('ROOM_BUSY');
        room.status = 'PLAYING';
        room.match = ref;
        return { result: this.changeResult(room, before) };
      });
      const starting: MatchStartingPayload = {
        matchId: ref.matchId,
        seed: ref.seed,
        startInMs: MATCH_START_DELAY_MS,
        startAt: new Date(now + MATCH_START_DELAY_MS).toISOString(),
        players: view.players.map((p) => ({ playerId: p.playerId, name: p.name })),
      };
      return { ...change, starting };
    } catch (error) {
      await this.matches.remove(redis, ref.matchId).catch(() => undefined);
      throw error;
    }
  }

  /** 재대결 — 방장, RESULT → WAITING, 전원 ready=false. 이전 매치 키는 TTL 동안 남는다(P5 검증) */
  async rematch(code: string, socketId: string, now = Date.now()): Promise<RoomChangeResult> {
    const redis = this.requireRedis();
    await this.repairEndedMatch(redis, code, now);
    return this.mutateRoom<RoomChangeResult>(redis, code, now, (room, before) => {
      const player = this.requireMember(room, socketId);
      if (room.hostId !== player.playerId) throw new TetrisBattleError('NOT_HOST');
      if (room.status === 'PLAYING') throw new TetrisBattleError('MATCH_ALREADY_STARTED');
      if (room.status !== 'RESULT') throw new TetrisBattleError('MATCH_NOT_FOUND');
      room.status = 'WAITING';
      room.match = null;
      for (const p of room.players) p.ready = false;
      return { result: this.changeResult(room, before) };
    });
  }

  /**
   * 블록 고정 보고. 멤버·매치 확인(방 Hash 읽기 1번) → 판 검증 → Lua 1번(lazy 끊김 KO·생존·seq/frame 단조·
   * 스냅샷·통계·대상 순환·가비지 id) → 끝났으면 방 RESULT.
   * seq 중복(재전송)은 성공 ack + 방송 없음. 실패해도 그 사이 생긴 KO·종료는 matchListener로 방송한다.
   */
  async lock(
    code: string,
    socketId: string,
    input: { matchId: string; seq: number; frame: number; sent: number; combo: number; b2b: boolean; board: string; pending: number },
    now = Date.now(),
  ): Promise<LockOutcome> {
    const redis = this.requireRedis();
    const { player, ref, ended } = await this.requireMatchMember(redis, code, socketId, input.matchId);
    // 이 방의 직전 매치가 이미 끝났으면 늦게 온 보고는 무시하고 성공(리뷰 H7)
    if (ended) return this.ignoredLock(ref.matchId);
    this.assertBoard(input.board);

    const hole = randomInt(0, GARBAGE_HOLE_MAX + 1);
    const r = await this.matches.lock(redis, ref.matchId, ref.playerIds, { ...input, playerId: player.playerId, hole }, now);
    const match: MatchEvents = { matchId: ref.matchId, kos: this.toKoPayloads(ref.matchId, r.kos), ended: null };
    // 종료 판정을 받았거나(r.ended), 이미 끝난 매치인데 방은 PLAYING(종료 반영 실패 후)이면 지금 반영한다(리뷰 J3)
    const roomChange = r.ended || r.code === 'MATCH_ENDED' ? await this.finishMatch(redis, code, ref.matchId, now, match) : null;

    // 이 lock 처리 중(유예 KO로) 또는 그 전에 끝난 매치 — 보고는 무시하고 성공, 생긴 KO·종료는 결과로 방송(리뷰 H7·J3)
    if (!r.ok && r.code === 'MATCH_ENDED') return { ...this.ignoredLock(ref.matchId), match, roomChange };
    if (!r.ok) {
      // KO는 Lua가 확정한 사실이라 요청 실패와 무관하게 방송한다(리뷰 H5)
      this.notifyMatch(code, match, roomChange);
      throw new TetrisBattleError(
        r.code === 'PLAYER_NOT_ALIVE'
          ? 'PLAYER_NOT_ALIVE'
          : r.code === 'LOCK_OUT_OF_ORDER' || r.code === 'LOCK_TOO_FAST'
            ? 'INVALID_PAYLOAD'
            : 'MATCH_NOT_FOUND',
      );
    }

    return {
      targetId: r.nextTarget,
      duplicate: r.dup,
      garbage: r.target
        ? {
            toPlayerId: r.target,
            payload: { matchId: ref.matchId, id: r.gid, lines: input.sent, hole, from: player.playerId },
          }
        : null,
      attack: r.target ? { matchId: ref.matchId, from: player.playerId, to: r.target, lines: input.sent } : null,
      opponentUpdate: r.dup
        ? null
        : {
            matchId: ref.matchId,
            playerId: player.playerId,
            board: input.board,
            pending: input.pending,
            combo: input.combo,
            b2b: input.b2b,
          },
      match,
      roomChange,
    };
  }

  /** 탑아웃 보고 — KO(reason topout, by = 마지막 공격자). 이미 탈락했으면 아무 일 없이 성공(재전송) */
  async topOut(
    code: string,
    socketId: string,
    input: { matchId: string; frame: number },
    now = Date.now(),
  ): Promise<{ match: MatchEvents; roomChange: RoomChangeResult | null }> {
    const redis = this.requireRedis();
    const { player, ref, ended } = await this.requireMatchMember(redis, code, socketId, input.matchId);
    // 직전 매치가 이미 끝났으면(승자의 동시 topOut 등) 무시하고 성공(리뷰 H7)
    if (ended) return { match: { matchId: ref.matchId, kos: [], ended: null }, roomChange: null };
    const r = await this.matches.knockOut(redis, ref.matchId, ref.playerIds, player.playerId, 'topout', input.frame, now);
    const match: MatchEvents = { matchId: ref.matchId, kos: this.toKoPayloads(ref.matchId, r.kos), ended: null };
    const roomChange = r.ended || r.code === 'MATCH_ENDED' ? await this.finishMatch(redis, code, ref.matchId, now, match) : null;
    if (!r.ok && r.code !== 'MATCH_ENDED') throw new TetrisBattleError('MATCH_NOT_FOUND');
    return { match, roomChange };
  }

  /**
   * 매치 Hash는 ENDED인데 방이 PLAYING으로 남은 경우(종료 반영 실패) 지금 RESULT로 반영하고 종료를 방송한다(리뷰 J3).
   * rematch 앞에서 부른다 — 반영되면 바로 재대결할 수 있다
   */
  private async repairEndedMatch(redis: Redis, code: string, now: number): Promise<void> {
    const loaded = await this.loadRoom(redis, code);
    const ref = loaded?.room.match;
    if (!loaded || !ref || loaded.room.status !== 'PLAYING') return;
    const snap = await this.matches.snapshot(redis, ref.matchId);
    if (snap?.status !== 'ENDED') return; // 매치 키가 없으면(만료) 생존 확인 경로에 맡긴다
    const match: MatchEvents = { matchId: ref.matchId, kos: [], ended: null };
    const roomChange = await this.finishMatch(redis, code, ref.matchId, now, match);
    this.notifyMatch(code, match, roomChange);
  }

  private ignoredLock(matchId: string): LockOutcome {
    return {
      targetId: null,
      duplicate: true,
      garbage: null,
      attack: null,
      opponentUpdate: null,
      match: { matchId, kos: [], ended: null },
      roomChange: null,
    };
  }

  private assertCanStart(room: StoredRoom, socketId: string): void {
    const player = this.requireMember(room, socketId);
    if (room.hostId !== player.playerId) throw new TetrisBattleError('NOT_HOST');
    if (room.status !== 'WAITING') throw new TetrisBattleError('MATCH_ALREADY_STARTED');
    if (room.players.length < 2) throw new TetrisBattleError('NOT_ENOUGH_PLAYERS');
    // 방장은 ready 불필요 — 시작 버튼이 곧 준비(D-019). 연결은 방장 포함 전원
    if (room.players.some((p) => !p.connected || (p.playerId !== room.hostId && !p.ready))) {
      throw new TetrisBattleError('NOT_ALL_READY');
    }
  }

  private async requireMatchMember(
    redis: Redis,
    code: string,
    socketId: string,
    matchId: string,
  ): Promise<{ room: StoredRoom; player: StoredPlayer; ref: StoredMatchRef; ended: boolean }> {
    const loaded = await this.loadRoom(redis, code);
    if (!loaded) throw new TetrisBattleError('ROOM_NOT_FOUND');
    const player = this.requireMember(loaded.room, socketId);
    const ref = loaded.room.match;
    const { status } = loaded.room;
    // 다른 matchId·매치 없음·WAITING은 MATCH_NOT_FOUND. 이 방의 직전 매치(RESULT)면 ended=true
    if ((status !== 'PLAYING' && status !== 'RESULT') || !ref || ref.matchId !== matchId || !ref.playerIds.includes(player.playerId)) {
      throw new TetrisBattleError('MATCH_NOT_FOUND');
    }
    return { room: loaded.room, player, ref, ended: status === 'RESULT' };
  }

  /** 판: base64(정확히 BOARD_BYTES바이트, 정규 인코딩) + 칸 값 0~8 */
  private assertBoard(board: string): void {
    const bytes = Buffer.from(board, 'base64');
    if (bytes.length !== BOARD_BYTES || bytes.toString('base64') !== board || bytes.some((v) => v > BOARD_CELL_MAX)) {
      throw new TetrisBattleError('INVALID_PAYLOAD', '판 인코딩이 올바르지 않습니다.');
    }
  }

  /**
   * 매치 종료 반영 — 방이 아직 그 매치의 PLAYING이면 RESULT로 바꾼다.
   * **실제로 PLAYING → RESULT를 바꾼 쪽만** events.ended를 채운다(리뷰 H4 — matchEnded는 정확히 1번).
   * 던지지 않는다(리뷰 H5): 방 CAS가 실패해도(ROOM_BUSY 등) 호출자는 이미 확정된 KO를 방송해야 하고,
   * 반영 못 한 종료는 생존 확인 경로(reconcileMatch)가 매치 Hash ENDED를 보고 마저 반영한다.
   */
  private async finishMatch(
    redis: Redis,
    code: string,
    matchId: string,
    now: number,
    events: MatchEvents,
  ): Promise<RoomChangeResult | null> {
    try {
      const ended = await this.endedPayload(redis, matchId);
      const change = await this.mutateRoom<RoomChangeResult | null>(redis, code, now, (room, before) => {
        if (room.status !== 'PLAYING' || room.match?.matchId !== matchId) return { result: null };
        room.status = 'RESULT';
        return { result: this.changeResult(room, before) };
      });
      if (change) events.ended = ended;
      return change;
    } catch (error) {
      if (!(error instanceof TetrisBattleError && error.code === 'ROOM_NOT_FOUND')) {
        this.logger.warn(`매치 종료 반영 실패 — 생존 확인 경로가 다시 시도: code=${code}, ${(error as Error).message}`);
      }
      return null;
    }
  }

  /**
   * 경기 중 끊김 시각 기록 후, 그 사이 같은 플레이어가 다른 소켓으로 재연결했으면 기록을 지운다(리뷰 H6) —
   * "끊김 표시 커밋 → 재연결 커밋·끊김 해제 → 이 기록"이 늦게 쓰여 살아 있는 플레이어가 유예 KO되는 순서를 막는다
   */
  private async markMatchDisconnected(redis: Redis, code: string, matchId: string, playerId: string, at: number): Promise<void> {
    await this.matches.setDisconnectedAt(redis, matchId, playerId, at);
    const after = await this.loadRoom(redis, code);
    const player = after?.room.players.find((p) => p.playerId === playerId);
    if (player?.connected) await this.matches.setDisconnectedAt(redis, matchId, playerId, null);
  }

  private async endedPayload(redis: Redis, matchId: string): Promise<MatchEndedPayload> {
    const snap = await this.matches.snapshot(redis, matchId);
    return { matchId, results: snap ? this.toResults(snap) : [] };
  }

  /** 순위 오름차순. place가 비어 있으면(이론상 없음) 꼴찌로 */
  private toResults(snap: MatchSnapshot): MatchResultEntry[] {
    return snap.players
      .map(
        (p): MatchResultEntry => ({
          playerId: p.playerId,
          name: p.name,
          place: p.place ?? snap.players.length,
          kos: p.kos,
          sent: p.sent,
          received: p.received,
          pieces: p.pieces,
          maxCombo: p.maxCombo,
          frames: p.frames ?? p.frame,
        }),
      )
      .sort((a, b) => a.place - b.place);
  }

  private toKoPayloads(matchId: string, kos: ScriptKo[]): PlayerKOPayload[] {
    return kos.map((k) => ({ matchId, playerId: k.playerId, by: k.by, place: k.place, reason: k.reason }));
  }

  /**
   * 경기 중 재연결 복구 — 끊김 유예가 지난 플레이어를 먼저 정리(KO)한 뒤, 아직 생존이면 끊김 표시를 지운다.
   * 방에 매치가 없으면 null.
   */
  private async recoverMatch(
    code: string,
    playerId: string,
    socketId: string,
    lastGarbageId: number,
    now: number,
  ): Promise<{ rejoin: RejoinData; match: MatchEvents; room?: RoomState; lobbyChanged?: boolean } | null> {
    const redis = this.requireRedis();
    const loaded = await this.loadRoom(redis, code);
    const ref = loaded?.room.match;
    if (!loaded || !ref || !ref.playerIds.includes(playerId)) return null;

    const match: MatchEvents = { matchId: ref.matchId, kos: [], ended: null };
    let roomChange: RoomChangeResult | null = null;
    if (loaded.room.status === 'PLAYING') {
      const swept = await this.matches.knockOut(redis, ref.matchId, ref.playerIds, null, 'disconnect', null, now);
      match.kos = this.toKoPayloads(ref.matchId, swept.kos);
      if (swept.ended) roomChange = await this.finishMatch(redis, code, ref.matchId, now, match);
      // RESULT 전이는 방 전원에게 (재연결한 본인은 ack의 room으로도 받는다)
      if (roomChange) this.notifyChange(code, roomChange.room, roomChange.lobbyChanged);
    }

    const snap = await this.matches.snapshot(redis, ref.matchId);
    if (!snap) return null;
    const self = snap.players.find((p) => p.playerId === playerId);
    const alive = self?.alive === true && snap.status === 'PLAYING';
    // 끊김 기록은 "지금도 이 소켓이 그 플레이어로 연결돼 있을 때만" 지운다(리뷰 J1) — 재연결 처리 중 이 소켓이 끊겼으면
    // 끊김 처리가 이미 기록을 남겼으므로 지우면 영구 생존이 된다
    if (alive) {
      const latest = await this.loadRoom(redis, code);
      const me = latest?.room.players.find((p) => p.playerId === playerId);
      if (me?.connected && me.socketId === socketId) await this.matches.setDisconnectedAt(redis, ref.matchId, playerId, null);
    }

    const emptyBoard = Buffer.alloc(BOARD_BYTES).toString('base64');
    const rejoin: RejoinData = {
      match: { matchId: ref.matchId, seed: ref.seed, status: snap.status, alive },
      missedGarbage: await this.matches.garbageSince(redis, ref.matchId, playerId, lastGarbageId),
      opponents: snap.players
        .filter((p) => p.playerId !== playerId)
        .map((p) => ({ playerId: p.playerId, board: p.board ?? emptyBoard, pending: p.pending, alive: p.alive })),
    };
    return roomChange?.room
      ? { rejoin, match, room: roomChange.room, lobbyChanged: roomChange.lobbyChanged }
      : { rejoin, match };
  }

  /**
   * 생존 확인 경로의 매치 처리: 유령으로 표시된 참가자의 끊김 시각 기록 + 유예 지난 끊김 KO(lazy) +
   * 매치는 끝났는데 방이 PLAYING으로 남은 경우(종료 반영 직전 프로세스가 죽음) 복구. 결과는 리스너로 방송.
   */
  private async reconcileMatch(redis: Redis, code: string, ghostIds: string[], now: number): Promise<void> {
    const loaded = await this.loadRoom(redis, code);
    const ref = loaded?.room.match;
    if (!loaded || !ref || loaded.room.status !== 'PLAYING') return;

    for (const id of ghostIds) {
      if (ref.playerIds.includes(id)) await this.markMatchDisconnected(redis, code, ref.matchId, id, now);
    }
    const swept = await this.matches.knockOut(redis, ref.matchId, ref.playerIds, null, 'disconnect', null, now);
    const match: MatchEvents = { matchId: ref.matchId, kos: this.toKoPayloads(ref.matchId, swept.kos), ended: null };
    let roomChange: RoomChangeResult | null = null;
    if (swept.ended) {
      roomChange = await this.finishMatch(redis, code, ref.matchId, now, match);
    } else if (!swept.ok) {
      // 매치 Hash가 이미 ENDED(또는 사라짐)인데 방은 PLAYING — 종료 반영을 마저 한다.
      // finishMatch는 실제로 전이시켰을 때만 ended를 채우므로 matchEnded가 두 번 나가지 않는다
      roomChange = await this.finishMatch(redis, code, ref.matchId, now, match);
    }
    this.notifyMatch(code, match, roomChange);
  }

  private notifyMatch(code: string, match: MatchEvents, roomChange: RoomChangeResult | null): void {
    if (roomChange) this.notifyChange(code, roomChange.room, roomChange.lobbyChanged);
    if (match.kos.length === 0 && !match.ended) return;
    try {
      this.matchListener?.(code, match);
    } catch (error) {
      this.logger.warn(`매치 이벤트 알림 실패: code=${code}, ${(error as Error).message}`);
    }
  }

  // ==================== 채팅·이모트 ====================

  /** 채팅 검증 → 브로드캐스트할 페이로드. 멤버십·상태(WAITING·RESULT)·금지 문자·금칙어·빈도 순으로 본다 */
  async prepareChat(code: string, socketId: string, text: string, now = Date.now()): Promise<ChatMessagePayload> {
    const redis = this.requireRedis();
    const player = await this.requireMemberOf(redis, code, socketId, (room) => {
      if (room.status === 'PLAYING') throw new TetrisBattleError('MATCH_ALREADY_STARTED');
    });
    // 제어·bidi 문자(줄바꿈·방향 오버라이드 등)는 화면을 깨거나 다른 사람의 문장처럼 위장하는 데 쓰인다
    if (containsDisallowedChars(text) || containsForbiddenWord(text)) throw new TetrisBattleError('CHAT_FORBIDDEN');
    // 빈도 제한은 방·플레이어 단위 — 재연결(새 소켓)로 카운터를 초기화하지 못하게
    if (!(await this.consumeRateLimit('chat', `${code}:${player.playerId}`))) throw new TetrisBattleError('RATE_LIMITED');
    return { playerId: player.playerId, name: player.name, text, at: new Date(now).toISOString() };
  }

  async prepareEmote(
    code: string,
    socketId: string,
    emoteId: TetrisBattleEmoteId,
    now = Date.now(),
  ): Promise<EmoteReceivedPayload> {
    const redis = this.requireRedis();
    const player = await this.requireMemberOf(redis, code, socketId);
    if (!(await this.consumeRateLimit('emote', `${code}:${player.playerId}`))) throw new TetrisBattleError('RATE_LIMITED');
    return { playerId: player.playerId, emoteId, at: new Date(now).toISOString() };
  }

  // ==================== 빈도 제한 ====================

  /**
   * 고정 윈도 빈도 제한. 한도 안이면 true.
   * Redis 명령이 실패하면 통과시킨다(팀 채팅 레이트 리밋과 같은 fail-open — 보조 방어선 때문에 기능 전체를 막지 않는다).
   */
  async consumeRateLimit(action: TetrisBattleRateLimitAction, subject: string): Promise<boolean> {
    const redis = this.requireRedis();
    const { limit, windowSec } = TETRIS_BATTLE_RATE_LIMITS[action];
    const key = rateLimitKey(action, subject);
    try {
      // MULTI: INCR과 TTL 설정 사이에 키가 TTL 없이 남지 않게. NX: 윈도 시작 때만 TTL
      const results = await redis.multi().incr(key).expire(key, windowSec, 'NX').exec();
      return Number(results?.[0]?.[1] ?? 0) <= limit;
    } catch (error) {
      this.logger.warn(`빈도 제한 확인 실패 — 통과: action=${action}, ${(error as Error).message}`);
      return true;
    }
  }

  // ==================== 내부: 저장·CAS ====================

  private requireRedis(): Redis {
    // 어댑터 클라이언트는 maxRetriesPerRequest: null이라 끊긴 동안 명령이 무한 대기한다 → ready가 아니면 바로 거부
    if (!this.redis || this.redis.status !== 'ready') throw new TetrisBattleError('SERVICE_UNAVAILABLE');
    return this.redis;
  }

  private async loadRoom(redis: Redis, code: string): Promise<{ version: string; room: StoredRoom } | null> {
    const hash = await redis.hgetall(roomKey(code));
    if (!hash.v || !hash.json) return null;
    return { version: hash.v, room: JSON.parse(hash.json) as StoredRoom };
  }

  /** 기대 버전과 같을 때만 쓴다(room=null이면 삭제). 성공 여부 */
  private async compareAndSet(
    redis: Redis,
    code: string,
    expectedVersion: string,
    room: StoredRoom | null,
  ): Promise<boolean> {
    const result = await redis.eval(
      ROOM_CAS_SCRIPT,
      2,
      roomKey(code),
      LOBBY_INDEX_KEY,
      expectedVersion,
      room ? JSON.stringify(room) : '',
      String(ROOM_TTL_SECONDS),
      code,
      String(room?.createdAt ?? 0),
    );
    return Number(result) === 1;
  }

  /**
   * 읽기 → 정리(유예 지난 끊긴 플레이어) → 변경 → CAS 쓰기. 버전이 바뀌었으면 처음부터 다시.
   *
   * `fn`은 재시도될 수 있으므로 **순수해야 한다**(Redis·소켓 부작용 금지) — 받은 room을 고치고 결과만 돌려준다.
   * 내용이 하나도 바뀌지 않았으면 쓰지 않는다. 정리 결과 아무도 없으면 방을 지우고 ROOM_NOT_FOUND.
   * P2(startMatch·lock 등)도 이 함수로 방을 바꾼다.
   */
  private async mutateRoom<T>(
    redis: Redis,
    code: string,
    now: number,
    fn: (room: StoredRoom, before: StoredRoom) => MutationOutcome<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < ROOM_CAS_MAX_ATTEMPTS; attempt++) {
      const loaded = await this.loadRoom(redis, code);
      if (!loaded) throw new TetrisBattleError('ROOM_NOT_FOUND');

      const originalJson = JSON.stringify(loaded.room);
      const room = this.pruneDisconnected(loaded.room, now);

      if (room.players.length === 0) {
        // 전원이 유예를 넘겨 끊긴 방 — 삭제(다른 레플리카가 먼저 지웠어도 결과는 같다)
        if (await this.compareAndSet(redis, code, loaded.version, null)) this.notifyChange(code, null, true);
        throw new TetrisBattleError('ROOM_NOT_FOUND');
      }

      const before = JSON.parse(originalJson) as StoredRoom;
      let outcome: MutationOutcome<T>;
      try {
        outcome = fn(room, before);
      } catch (error) {
        // 요청은 거부됐지만 정리(유예 지난 플레이어 제거)는 반영하고 방송한다 — fn이 room을 일부 고쳤을 수 있어 다시 계산
        const prunedOnly = this.pruneDisconnected(loaded.room, now);
        if (
          error instanceof TetrisBattleError &&
          JSON.stringify(prunedOnly) !== originalJson &&
          (await this.compareAndSet(redis, code, loaded.version, prunedOnly))
        ) {
          const change = this.changeResult(prunedOnly, before);
          this.notifyChange(code, change.room, change.lobbyChanged);
        }
        throw error;
      }

      if (outcome.deleteRoom) {
        if (await this.compareAndSet(redis, code, loaded.version, null)) return outcome.result;
        continue;
      }
      if (JSON.stringify(room) === originalJson) return outcome.result;
      if (await this.compareAndSet(redis, code, loaded.version, room)) {
        // 요청 결과가 null(호출자가 방송할 게 없음)인데 정리로 방이 바뀌었으면 여기서 알린다(리뷰 G3)
        if (outcome.result === null) {
          const change = this.changeResult(room, before);
          this.notifyChange(code, change.room, change.lobbyChanged);
        }
        return outcome.result;
      }
    }
    this.logger.warn(`방 변경 충돌 재시도 초과: code=${code}`);
    throw new TetrisBattleError('ROOM_BUSY');
  }

  /** 멤버십 검증만 하는 읽기 경로 (채팅·이모트) */
  private async requireMemberOf(
    redis: Redis,
    code: string,
    socketId: string,
    check?: (room: StoredRoom) => void,
  ): Promise<StoredPlayer> {
    const loaded = await this.loadRoom(redis, code);
    if (!loaded) throw new TetrisBattleError('ROOM_NOT_FOUND');
    const player = this.requireMember(loaded.room, socketId);
    check?.(loaded.room);
    return player;
  }

  // ==================== 내부: 생존 확인·변경 알림 ====================

  /**
   * 유령(connected=true인데 실제 소켓이 없는 플레이어) 정리 — 방당 LIVENESS_PROBE_INTERVAL_MS에 1번(Redis SET NX 게이트, 레플리카 공통).
   * 방 채널에 없고 연결 후 LIVENESS_MIN_CONNECTED_MS가 지난 플레이어를 끊김으로 표시한다 → 유예가 지나면 기존 lazy 정리가 뺀다.
   * 어떤 실패도 요청을 막지 않는다(로그만). 바뀌면 changeListener로 방송.
   * 호출 쪽은 기다리지 않는다(`void`) — 응답 없는 레플리카 때문에 요청 ack가 늦어지지 않게(리뷰 G1).
   */
  private async reconcileLiveness(redis: Redis, code: string, now: number): Promise<void> {
    if (!this.liveSocketProbe) return;
    try {
      const gate = await redis.set(probeKey(code), '1', 'PX', LIVENESS_PROBE_INTERVAL_MS, 'NX');
      if (gate !== 'OK') return;
      const live = await this.liveSocketProbe(code);
      let ghostIds: string[] = [];

      const change = await this.mutateRoom<RoomChangeResult | null>(redis, code, now, (room, before) => {
        const ghosts = room.players.filter(
          (p) =>
            p.connected &&
            p.socketId !== null &&
            !live.has(p.socketId) &&
            now - (p.connectedAt ?? p.joinedAt) >= LIVENESS_MIN_CONNECTED_MS,
        );
        for (const p of ghosts) {
          p.socketId = null;
          p.connected = false;
          p.disconnectedAt = now;
        }
        ghostIds = ghosts.map((p) => p.playerId);
        return { result: ghosts.length > 0 ? this.changeResult(room, before) : null };
      });
      if (change) this.notifyChange(code, change.room, change.lobbyChanged);
      await this.reconcileMatch(redis, code, ghostIds, now);
    } catch (error) {
      if (error instanceof TetrisBattleError && error.code === 'ROOM_NOT_FOUND') return;
      this.logger.warn(`생존 확인 실패 — 건너뜀: code=${code}, ${(error as Error).message}`);
    }
  }

  private notifyChange(code: string, room: RoomState | null, lobbyChanged: boolean): void {
    try {
      this.changeListener?.(code, room, lobbyChanged);
    } catch (error) {
      this.logger.warn(`방 변경 알림 실패: code=${code}, ${(error as Error).message}`);
    }
  }

  // ==================== 내부: 방 규칙 (순수) ====================

  /** 멤버십 = 방 기록의 플레이어 중 대표 소켓이 이 소켓인 사람. 클라이언트가 보낸 playerId는 믿지 않는다 */
  private requireMember(room: StoredRoom, socketId: string): StoredPlayer {
    const player = room.players.find((p) => p.socketId === socketId);
    if (!player) throw new TetrisBattleError('NOT_IN_ROOM');
    return player;
  }

  /**
   * WAITING·RESULT 방에서 유예가 지난 끊긴 플레이어를 뺀다(새 객체). PLAYING은 P2가 KO로 처리하므로 건드리지 않는다.
   */
  private pruneDisconnected(source: StoredRoom, now: number): StoredRoom {
    const room: StoredRoom = { ...source, players: source.players.map((p) => ({ ...p })) };
    if (room.status === 'PLAYING') return room;
    const expired = room.players.filter(
      (p) => !p.connected && p.disconnectedAt !== null && now - p.disconnectedAt >= DISCONNECT_GRACE_MS,
    );
    for (const p of expired) this.removePlayer(room, p.playerId);
    return room;
  }

  /** 플레이어 제거 + 방장이었으면 이양: 연결된 사람 중 가장 먼저 들어온 사람, 없으면 가장 먼저 들어온 사람 */
  private removePlayer(room: StoredRoom, playerId: string): void {
    room.players = room.players.filter((p) => p.playerId !== playerId);
    if (room.hostId !== playerId || room.players.length === 0) return;
    const next = room.players.find((p) => p.connected) ?? room.players[0];
    room.hostId = next.playerId;
  }

  private newPlayer(
    playerId: string,
    name: string,
    who: SocketIdentity,
    tokenHash: string,
    now: number,
  ): StoredPlayer {
    return {
      playerId,
      name,
      ready: false,
      connected: true,
      userId: who.userId,
      tokenHash,
      socketId: who.socketId,
      joinedAt: now,
      connectedAt: now,
      disconnectedAt: null,
    };
  }

  private enterResult(
    room: StoredRoom,
    before: StoredRoom,
    playerId: string,
    playerToken: string,
    replacedSocketId: string | null,
  ): EnterRoomResult {
    return { ...this.changeResult(room, before), playerId, playerToken, replacedSocketId };
  }

  private changeResult(room: StoredRoom, before: StoredRoom): { room: RoomState; lobbyChanged: boolean } {
    const lobbyChanged = JSON.stringify(this.toSummary(room)) !== JSON.stringify(this.toSummary(before));
    return { room: this.toRoomState(room), lobbyChanged };
  }

  toRoomState(room: StoredRoom): RoomState {
    return {
      code: room.code,
      name: room.name,
      maxPlayers: room.maxPlayers,
      locked: room.passwordHash !== null,
      hostId: room.hostId,
      status: room.status,
      players: room.players.map(
        (p): RoomPlayer => ({
          playerId: p.playerId,
          name: p.name,
          ready: p.ready,
          connected: p.connected,
          isGuest: p.userId === null,
        }),
      ),
    };
  }

  private toSummary(room: StoredRoom): RoomSummary {
    return {
      code: room.code,
      name: room.name,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      locked: room.passwordHash !== null,
      status: room.status,
    };
  }

  // ==================== 내부: 이름·코드·토큰·비밀번호 ====================

  private assertPlayerName(name: string): void {
    const verdict = checkPlayerName(name);
    if (verdict === 'INVALID') throw new TetrisBattleError('NAME_INVALID');
    if (verdict === 'FORBIDDEN') throw new TetrisBattleError('NAME_FORBIDDEN');
  }

  /** 방 이름: 1~20자, 제어·서식 문자 금지, 금칙어 금지 (플레이어 이름보다 허용 문자가 넓다 — 이모지·문장부호 허용) */
  private assertRoomName(name: string): void {
    const length = Array.from(name).length;
    if (length === 0 || length > ROOM_NAME_MAX_LENGTH || containsDisallowedChars(name)) {
      throw new TetrisBattleError('ROOM_NAME_INVALID');
    }
    if (containsForbiddenWord(name)) throw new TetrisBattleError('ROOM_NAME_FORBIDDEN');
  }

  private generateCode(): string {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    return code;
  }

  private issueToken(): { token: string; tokenHash: string } {
    const token = randomBytes(PLAYER_TOKEN_BYTES).toString('base64url');
    return { token, tokenHash: this.hashToken(token) };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** 둘 다 sha256 hex(같은 길이)라 timingSafeEqual 전제를 만족한다 */
  private tokenMatches(storedHash: string, candidateHash: string): boolean {
    const a = Buffer.from(storedHash, 'hex');
    const b = Buffer.from(candidateHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(PASSWORD_SALT_BYTES);
    const key = await scryptAsync(password, salt, PASSWORD_KEY_LENGTH);
    return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  private async passwordMatches(password: string, stored: string): Promise<boolean> {
    const [scheme, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
    return timingSafeEqual(actual, expected);
  }

  /**
   * 시도 예약 → 한도 판정 → 검증. 시도를 검증 **전에** INCR로 세고 그 반환값으로 판정하므로
   * 동시에 여러 시도를 보내도 한도를 넘는 시도는 scrypt까지 가지 않고 ROOM_PASSWORD_LOCKED다
   * (먼저 조회하고 실패 후 세는 방식은 동시 시도가 모두 0을 읽어 한도를 우회한다 — 리뷰 F1).
   *  - 같은 소켓: PASSWORD_FAILURE_LIMIT.maxFailures번까지 검증
   *  - 같은 IP: PASSWORD_FAILURE_LIMIT_IP.maxFailures번까지 검증
   * 정답이면 예약한 시도를 되돌린다(DECR) — 잠금은 오답만 센다.
   */
  private async verifyPasswordOrThrow(
    redis: Redis,
    room: StoredRoom,
    password: string | undefined,
    who: SocketIdentity,
  ): Promise<void> {
    const socketKey = passwordFailKey(room.code, who.socketId);
    const ipKey = passwordFailIpKey(room.code, who.ip);

    const results = await redis
      .multi()
      .incr(socketKey)
      .expire(socketKey, PASSWORD_FAILURE_LIMIT.windowSec, 'NX')
      .incr(ipKey)
      .expire(ipKey, PASSWORD_FAILURE_LIMIT_IP.windowSec, 'NX')
      .exec();
    const socketAttempts = Number(results?.[0]?.[1] ?? 0);
    const ipAttempts = Number(results?.[2]?.[1] ?? 0);
    if (socketAttempts > PASSWORD_FAILURE_LIMIT.maxFailures || ipAttempts > PASSWORD_FAILURE_LIMIT_IP.maxFailures) {
      throw new TetrisBattleError('ROOM_PASSWORD_LOCKED');
    }

    if (password && (await this.passwordMatches(password, room.passwordHash as string))) {
      // 정답이면 예약한 시도를 돌려준다 — NAT로 IP를 공유하는 정상 입장이 잠금에 쌓이지 않게(리뷰 G7).
      // 그 사이 윈도가 끝나 키가 사라졌으면 DECR이 TTL 없는 -1 키를 만들므로 EXPIRE NX로 TTL을 다시 건다
      try {
        await redis
          .multi()
          .decr(socketKey)
          .expire(socketKey, PASSWORD_FAILURE_LIMIT.windowSec, 'NX')
          .decr(ipKey)
          .expire(ipKey, PASSWORD_FAILURE_LIMIT_IP.windowSec, 'NX')
          .exec();
      } catch (error) {
        this.logger.warn(`비밀번호 시도 카운터 복원 실패: code=${room.code}, ${(error as Error).message}`);
      }
      return;
    }
    throw new TetrisBattleError('ROOM_WRONG_PASSWORD');
  }
}

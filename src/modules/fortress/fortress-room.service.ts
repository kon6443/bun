import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomInt } from 'crypto';
import type { Redis } from 'ioredis';
import { GameRoomRateLimiter } from '../game-room/game-room-rate-limit';
import { acquireIntervalGate, touchHeartbeat } from '../game-room/game-room-presence';
import {
  generateRoomCode,
  hashPlayerToken,
  hashRoomPassword,
  issuePlayerToken,
  playerTokenMatches,
  verifyRoomPassword,
} from '../game-room/game-room-secrets';
import { chatTextAllowed, checkPlayerName, checkRoomName } from '../game-room/game-room-text';
import { GameRoomStore } from '../game-room/game-room.store';
import { ENGINE_VERSION, MAP_IDS, type MapId, type MatchConfig, SEED_MAX, TANKS } from './engine';
import { FortressMatchService, TurnSubmitInput } from './fortress-match.service';
import { defaultTankSkin, storedTankSkin } from './fortress-skins';
import {
  DISCONNECT_GRACE_MS,
  FINISH_RETRY_DELAY_MS,
  FINISH_RETRY_MAX_ATTEMPTS,
  FORTRESS_RATE_LIMITS,
  FORTRESS_ROOM_KEYS,
  FortressRateLimitAction,
  HEARTBEAT_PROBE_INTERVAL_MS,
  HEARTBEAT_TTL_MS,
  LIVENESS_MIN_CONNECTED_MS,
  LIVENESS_PROBE_INTERVAL_MS,
  LOBBY_LIST_LIMIT,
  LOBBY_SCAN_LIMIT,
  LOBBY_TAIL_SWEEP_BATCH,
  MATCH_ID_BYTES,
  MATCH_START_DELAY_MS,
  PASSWORD_FAILURE_LIMIT,
  PASSWORD_FAILURE_LIMIT_IP,
  PASSWORD_KEY_LENGTH,
  PASSWORD_SALT_BYTES,
  PLAYER_TOKEN_BYTES,
  ROOM_CAS_MAX_ATTEMPTS,
  ROOM_CODE_MAX_ATTEMPTS,
  ROOM_TTL_SECONDS,
  WAKE_MARGIN_MS,
} from './fortress.constants';
import { FortressError } from './fortress.errors';
import {
  ChatMessagePayload,
  EmoteReceivedPayload,
  FortressEmoteId,
  FortressTankSkin,
  MatchSnapshot,
  MatchStartingPayload,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_MAX_PLAYERS,
  ROOM_MIN_PLAYERS,
  ROOM_NAME_MAX_LENGTH,
  RoomMapId,
  RoomMode,
  RoomPlayer,
  RoomSettings,
  RoomState,
  RoomStatus,
  RoomSummary,
  TEAM_SIZE,
} from './fortress.events';

/**
 * Redis 키 — 공용 부품 `createGameRoomKeys('fortress:')`(FORTRESS_ROOM_KEYS) + 경기 키(fortress.constants.ts FORTRESS_MATCH_KEYS).
 * 모양은 테트리스 대전과 같고 접두사만 다르다(DESIGN §4): fortress:room:{code} · fortress:rooms · fortress:rl:* · fortress:pwfail* ·
 * fortress:probe:{code} · fortress:hb:{code}:{socketId} · fortress:hbprobe:{code}. 모두 TTL 있음
 */
const KEYS = FORTRESS_ROOM_KEYS;

/** Redis에 저장하는 플레이어 — 토큰은 해시만, socketId는 멤버십 판정 기준 (테트리스 StoredPlayer + 팀·탱크) */
export interface StoredPlayer {
  playerId: string;
  name: string;
  ready: boolean;
  connected: boolean;
  /** 로그인 유저면 userId, 게스트면 null */
  userId: number | null;
  /** sha256(playerToken) hex */
  tokenHash: string;
  /** team 모드 0|1, ffa는 null */
  team: 0 | 1 | null;
  /** 0..2 (엔진 TANKS 인덱스) */
  tankId: number;
  /**
   * 탱크 스킨(F7) — 입장·자리 넘겨받기 때 계정 장착(게스트 default). 클라이언트 값은 받지 않는다.
   * 이 필드가 없던 시절(F7 배포 전)에 저장된 방은 undefined = default
   */
  skin?: FortressTankSkin;
  /** 지금 이 플레이어를 대표하는 소켓. 끊기면 null */
  socketId: string | null;
  /** 대표 소켓을 연 탭의 식별자 — 경기 중 같은 탭의 재연결만 연결된 자리를 넘겨받게 한다(테트리스 tetris-audit D-007과 같은 규칙) */
  tabId: string | null;
  /** 하트비트(presencePing 응답)를 보내는 클라이언트인지 */
  heartbeat: boolean;
  joinedAt: number;
  connectedAt: number;
  disconnectedAt: number | null;
}

export interface StoredMatchRef {
  matchId: string;
  /** 참가자 playerId (slot 순 = 입장 순서) */
  playerIds: string[];
}

export interface StoredRoom extends RoomSettings {
  code: string;
  name: string;
  /** `scrypt$<salt b64>$<key b64>` 또는 null(공개 방) */
  passwordHash: string | null;
  hostId: string;
  status: RoomStatus;
  createdAt: number;
  /** 다음 playerId 번호 — 방 수명 동안 playerId를 재사용하지 않는다 */
  nextPlayerSeq: number;
  /** 입장 순서 */
  players: StoredPlayer[];
  /** 진행 중(PLAYING)이거나 직전(RESULT) 경기. 경기 상태 자체는 경기 키(fortress-match.store.ts) */
  match: StoredMatchRef | null;
}

/** 요청한 소켓의 신원 — 게이트웨이가 소켓에서 꺼내 넘긴다(클라이언트 페이로드에서 받지 않는다) */
export interface SocketIdentity {
  socketId: string;
  userId: number | null;
  /** 빈도 제한·비밀번호 잠금용 IP */
  ip: string;
  /**
   * 입장(create·join)에서만 — 게이트웨이가 계정 장착에서 읽은 탱크 스킨(F7). 조회 실패면 없다:
   * 새 자리는 default, 기존 자리는 이전 값 유지(기본값으로 덮지 않게 — 테트리스 enterIdentity와 같은 규칙)
   */
  skin?: FortressTankSkin;
}

/** 입장 요청에 실려 오는 클라이언트 특성 */
export interface ClientTraits {
  tabId?: string;
  heartbeat?: boolean;
}

export interface RoomChangeResult {
  /** 변경 후 방 상태. 방이 삭제됐으면 null */
  room: RoomState | null;
  lobbyChanged: boolean;
}

export interface EnterRoomResult extends RoomChangeResult {
  room: RoomState;
  playerId: string;
  playerToken: string;
  /** 넘겨받은 이전 소켓 id — 게이트웨이가 그 소켓을 방 채널에서 빼고 sessionReplaced를 보낸다 */
  replacedSocketId: string | null;
  /** 경기 중 재연결이면 복원 정보 */
  rejoin?: { match: MatchSnapshot };
}

export type LiveSocketProbe = (code: string) => Promise<Set<string>>;
export type SocketEvictor = (socketIds: string[]) => void;
export type RoomChangeListener = (code: string, room: RoomState | null, lobbyChanged: boolean) => void;

interface MutationOutcome<T> {
  result: T;
  deleteRoom?: boolean;
}

/** WAITING 방 우선, 같은 상태면 최근 생성 순 */
const STATUS_ORDER: Record<RoomStatus, number> = { WAITING: 0, PLAYING: 1, RESULT: 2 };

/**
 * 포트리스 대전 방 서비스 (DESIGN §4·§11, D-014) — `game-room` 부품 위에 새로 만든 방 라이프사이클.
 * 입장 4갈래·이탈·준비·방장 이양·강퇴·끊김·하트비트·생존 확인·재대결은 테트리스 대전 방 서비스와 같은 규칙을 따른다
 * (F3c에서 공용 코어로 뽑을 예정 — 그때까지 두 벌). 포트리스 차이: 방 설정(mode·mapId)·팀·탱크·경기 중 채팅 전원 허용,
 * 경기는 FortressMatchService(서버 권위 턴)에 맡긴다.
 *
 * 모든 변경은 "읽기 → 순수 변경 → 버전 CAS"(mutateRoom). 멤버십은 매 요청 방 기록의 socketId로 판정한다(playbook 클러스터 1).
 */
@Injectable()
export class FortressRoomService {
  private readonly logger = new Logger(FortressRoomService.name);
  private redis: Redis | null = null;
  private liveSocketProbe: LiveSocketProbe | null = null;
  private changeListener: RoomChangeListener | null = null;
  private socketEvictor: SocketEvictor | null = null;
  private readonly rooms = new GameRoomStore<StoredRoom>(KEYS, ROOM_TTL_SECONDS, this.logger);
  private readonly rateLimiter = new GameRoomRateLimiter<FortressRateLimitAction>(KEYS, FORTRESS_RATE_LIMITS, this.logger);
  private wakeScheduler: (task: () => void, delayMs: number) => void = (task, delayMs) => {
    setTimeout(task, delayMs).unref();
  };

  constructor(private readonly matches: FortressMatchService) {
    // 경기가 끝나면(어느 레플리카·어느 경로든) 방을 RESULT로 — 순환 의존 없이 훅으로 받는다
    this.matches.setEndedHook((code, matchId) => this.finishMatch(code, matchId));
  }

  /** main.ts에서 RedisIoAdapter 초기화 후 호출 (FortressMatchService에도 같은 연결을 따로 주입한다) */
  setRedisClient(client: Redis): void {
    this.redis = client;
  }

  readyRedisClient(): Redis | null {
    return this.redis && this.redis.status === 'ready' ? this.redis : null;
  }

  setLiveSocketProbe(probe: LiveSocketProbe): void {
    this.liveSocketProbe = probe;
  }

  setChangeListener(listener: RoomChangeListener): void {
    this.changeListener = listener;
  }

  setSocketEvictor(evictor: SocketEvictor): void {
    this.socketEvictor = evictor;
  }

  setWakeScheduler(scheduler: (task: () => void, delayMs: number) => void): void {
    this.wakeScheduler = scheduler;
  }

  /** 나중에 한 번 깨운다 — 이미 있는 멱등 경로를 앞당겨 부르는 트리거일 뿐이다(레플리카가 죽으면 다음 요청의 lazy 정리가 대신) */
  scheduleWake(task: () => Promise<void>, delayMs: number): void {
    this.wakeScheduler(() => void task(), delayMs);
  }

  /**
   * 끊김 유예가 끝난 방 정리 — WAITING·RESULT는 유예 지난 자리 제거·방장 이양, PLAYING은 끊긴 참가자의 경기 끊김 기록을 채우고
   * 경기 마감 처리를 부른다(기록이 실패했어도 유예 resign이 일어나게 — 테트리스 리뷰 R2와 같은 이유). 실패는 로그만
   */
  async sweepExpired(code: string, now = Date.now()): Promise<void> {
    const redis = this.readyRedisClient();
    if (!redis) return;
    try {
      const loaded = await this.rooms.load(redis, code);
      if (!loaded) return;
      const ref = loaded.room.match;
      if (loaded.room.status === 'PLAYING' && ref) {
        for (const p of loaded.room.players) {
          if (!p.connected && p.disconnectedAt !== null && ref.playerIds.includes(p.playerId)) {
            await this.markMatchDisconnected(redis, code, ref.matchId, p.playerId, p.disconnectedAt, { onlyIfEmpty: true });
          }
        }
        await this.resignDepartedPlayers(loaded.room, now);
        await this.matches.processDue(ref.matchId, now);
        return;
      }
      await this.mutateRoom<null>(redis, code, now, () => ({ result: null }));
    } catch (error) {
      if (error instanceof FortressError && error.code === 'ROOM_NOT_FOUND') return;
      this.logger.warn(`유예 만료 정리 실패 — 다음 요청이 정리: code=${code}, ${(error as Error).message}`);
    }
  }

  // ==================== 로비 ====================

  /** 로비 목록. `reconcile=false`는 방 변경 방송 경로용 — 방송마다 생존 확인을 걸지 않는다 */
  async listRooms(now = Date.now(), { reconcile = true }: { reconcile?: boolean } = {}): Promise<RoomSummary[]> {
    const redis = this.requireRedis();
    const stored = await this.rooms.scanLobby(redis, LOBBY_SCAN_LIMIT, LOBBY_TAIL_SWEEP_BATCH);
    const summaries: RoomSummary[] = [];
    for (const source of stored) {
      const room = this.pruneDisconnected(source, now);
      if (room.players.length > 0) summaries.push(this.toSummary(room));
    }
    const sorted = summaries
      .map((summary, index) => ({ summary, index }))
      .sort((a, b) => STATUS_ORDER[a.summary.status] - STATUS_ORDER[b.summary.status] || a.index - b.index)
      .map(({ summary }) => summary)
      .slice(0, LOBBY_LIST_LIMIT);
    if (reconcile) {
      for (const summary of sorted) void this.reconcileLiveness(redis, summary.code, now);
    }
    return sorted;
  }

  // ==================== 생성·입장·이탈 ====================

  /**
   * 방 생성 — 만든 사람이 방장(p1). team 모드는 maxPlayers 4 고정, 방장은 team 0.
   * `beforeCommit`은 검증이 끝난 뒤 저장 직전에 한 번(게이트웨이의 이전 방 이탈 — 검증 실패로 현재 방에서 빠지지 않게)
   */
  async createRoom(
    input: RoomSettings & { name: string; password?: string; playerName: string } & ClientTraits,
    who: SocketIdentity,
    now = Date.now(),
    beforeCommit?: () => Promise<void>,
  ): Promise<EnterRoomResult> {
    this.assertRoomName(input.name);
    this.assertPlayerName(input.playerName);
    const redis = this.requireRedis();
    const passwordHash = input.password
      ? await hashRoomPassword(input.password, { saltBytes: PASSWORD_SALT_BYTES, keyLength: PASSWORD_KEY_LENGTH })
      : null;
    await beforeCommit?.();
    const { token, tokenHash } = issuePlayerToken(PLAYER_TOKEN_BYTES);
    const playerId = 'p1';
    const maxPlayers = input.mode === 'team' ? ROOM_MAX_PLAYERS : input.maxPlayers;

    for (let attempt = 0; attempt < ROOM_CODE_MAX_ATTEMPTS; attempt++) {
      const room: StoredRoom = {
        code: generateRoomCode(ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH),
        name: input.name,
        mode: input.mode,
        mapId: input.mapId,
        maxPlayers,
        passwordHash,
        hostId: playerId,
        status: 'WAITING',
        createdAt: now,
        nextPlayerSeq: 2,
        players: [],
        match: null,
      };
      room.players.push(this.newPlayer(room, playerId, input.playerName, who, tokenHash, input, now));
      if (await this.rooms.compareAndSet(redis, room.code, '0', room)) {
        return { room: this.toRoomState(room), playerId, playerToken: token, replacedSocketId: null, lobbyChanged: true };
      }
    }
    throw new FortressError('ROOM_BUSY');
  }

  /**
   * 입장. 네 갈래(테트리스 대전과 같다):
   *  1. `playerToken`이 이 방의 플레이어와 맞으면 재연결 — 같은 playerId로 복귀(비밀번호·상태·정원 검사 없음)
   *  2. 이 소켓이 이미 이 방의 플레이어면 토큰만 재발급
   *  3. 로그인 유저이고 같은 userId의 자리가 있으면 그 자리로 복귀 + 토큰 재발급(다른 탭·기기)
   *  4. 새 플레이어 — 이름·상태(WAITING)·정원·비밀번호 검사. team 모드면 적은 팀(같으면 0)에 넣는다
   * 1·3(넘겨받기)은 경기 중인 자리를 다른 탭이 아직 쓰고 있으면 SEAT_IN_USE. 이전 소켓이 있으면 replacedSocketId(→ sessionReplaced).
   * 경기 중 복귀(1·3)는 커밋·채널 입장(afterCommit) 뒤 경기 끊김 표시를 지우고 ack `rejoin.match`로 복원 정보를 붙인다
   */
  async joinRoom(
    input: { code: string; password?: string; playerName: string; playerToken?: string } & ClientTraits,
    who: SocketIdentity,
    now = Date.now(),
    beforeCommit?: () => Promise<void>,
    afterCommit?: (entered: EnterRoomResult) => Promise<void>,
  ): Promise<EnterRoomResult> {
    const { entered, resumed } = await this.commitJoin(input, who, now, beforeCommit);
    await afterCommit?.(entered);
    if (!resumed || entered.room.status !== 'PLAYING') return entered;
    // 입장은 이미 커밋됐다 — 복원이 실패해도 복원 없이 입장으로 돌려준다(테트리스 BE-04와 같은 원칙). 클라이언트는 resync로 다시 받는다
    try {
      const rejoin = await this.recoverMatch(input.code, entered.playerId, who.socketId, now);
      // 복원 중 lazy 마감 처리(끊김 resign 등)로 경기가 끝났을 수 있다 — finishMatch가 RESULT를 이미 알렸으니
      // ack의 room도 최신으로(옛 PLAYING을 돌려주지 않게, leaveRoom과 같은 이유)
      const latest = await this.rooms.load(this.requireRedis(), input.code);
      const room = latest ? this.toRoomState(latest.room) : entered.room;
      return rejoin ? { ...entered, room, rejoin } : { ...entered, room };
    } catch (error) {
      this.logger.warn(`재연결 복원 실패 — 복원 없이 입장: code=${input.code}, player=${entered.playerId}, ${(error as Error).message}`);
      return entered;
    }
  }

  private async commitJoin(
    input: { code: string; password?: string; playerName: string; playerToken?: string } & ClientTraits,
    who: SocketIdentity,
    now: number,
    beforeCommit?: () => Promise<void>,
  ): Promise<{ entered: EnterRoomResult; resumed: boolean }> {
    const redis = this.requireRedis();
    void this.reconcileLiveness(redis, input.code, now);
    const current = await this.rooms.load(redis, input.code);
    if (!current) throw new FortressError('ROOM_NOT_FOUND');

    const tokenHash = input.playerToken ? hashPlayerToken(input.playerToken) : null;
    const isRejoin = tokenHash !== null;
    const isSameSocket = current.room.players.some((p) => p.socketId === who.socketId);
    const userSeat = !isRejoin && !isSameSocket ? this.findUserSeat(current.room, who) : undefined;
    if (userSeat) this.assertCanTakeOver(current.room, userSeat, who, input.tabId);

    // ---- 사전 검증 (CAS 밖, 읽은 방 기준) — 통과해야 beforeCommit(이전 방 이탈)을 부른다 ----
    if (isRejoin) {
      const seat = current.room.players.find((p) => playerTokenMatches(p.tokenHash, tokenHash));
      if (!seat) throw new FortressError('INVALID_PLAYER_TOKEN');
      this.assertCanTakeOver(current.room, seat, who, input.tabId);
    } else {
      this.assertPlayerName(input.playerName);
    }
    let passwordVerified = current.room.passwordHash === null;
    if (!isRejoin && !isSameSocket && !userSeat) {
      const view = this.pruneDisconnected(current.room, now);
      if (view.status !== 'WAITING') throw new FortressError('MATCH_ALREADY_STARTED');
      if (view.players.length >= view.maxPlayers) throw new FortressError('ROOM_FULL');
      if (current.room.passwordHash) {
        await this.verifyPasswordOrThrow(redis, current.room.code, current.room.passwordHash, input.password, who);
        passwordVerified = true;
      }
    }

    await beforeCommit?.();
    const fresh = issuePlayerToken(PLAYER_TOKEN_BYTES);
    let resumed = false;
    const entered = await this.mutateRoom(redis, input.code, now, (room, before) => {
      resumed = false;
      if (tokenHash) {
        const player = room.players.find((p) => playerTokenMatches(p.tokenHash, tokenHash));
        if (!player) throw new FortressError('INVALID_PLAYER_TOKEN');
        // 이 소켓이 이미 같은 방의 다른 플레이어를 대표하면 한 소켓이 두 자리를 잡게 된다 → 거부
        if (room.players.some((p) => p !== player && p.socketId === who.socketId)) throw new FortressError('INVALID_PLAYER_TOKEN');
        const replaced = this.takeOver(room, player, who, input, now);
        resumed = true;
        return { result: this.enterResult(room, before, player.playerId, input.playerToken as string, replaced) };
      }

      const self = room.players.find((p) => p.socketId === who.socketId);
      if (self) {
        self.tokenHash = fresh.tokenHash;
        this.refreshSkin(room, self, who);
        return { result: this.enterResult(room, before, self.playerId, fresh.token, null) };
      }

      const seat = this.findUserSeat(room, who);
      if (seat) {
        const replaced = this.takeOver(room, seat, who, input, now);
        seat.tokenHash = fresh.tokenHash;
        resumed = true;
        return { result: this.enterResult(room, before, seat.playerId, fresh.token, replaced) };
      }

      // 읽을 때는 멤버였는데(비밀번호 생략) 그 사이 이탈·정리돼 새 플레이어 갈래로 왔다 → 비밀번호 없이 추가하지 않는다
      if (!passwordVerified) throw new FortressError('ROOM_BUSY');
      if (room.status !== 'WAITING') throw new FortressError('MATCH_ALREADY_STARTED');
      if (room.players.length >= room.maxPlayers) throw new FortressError('ROOM_FULL');
      const playerId = `p${room.nextPlayerSeq}`;
      room.nextPlayerSeq += 1;
      room.players.push(this.newPlayer(room, playerId, input.playerName, who, fresh.tokenHash, input, now));
      return { result: this.enterResult(room, before, playerId, fresh.token, null) };
    });
    return { entered, resumed };
  }

  /** 경기 중 참가자 자리를 다른 탭·기기가 아직 쓰고 있으면 SEAT_IN_USE (같은 탭 tabId의 재연결은 허용) — 테트리스와 같은 규칙 */
  private assertCanTakeOver(room: StoredRoom, player: StoredPlayer, who: SocketIdentity, tabId: string | undefined): void {
    const inMatch = room.status === 'PLAYING' && room.match?.playerIds.includes(player.playerId) === true;
    const usedElsewhere = player.connected && player.socketId !== null && player.socketId !== who.socketId;
    const sameTab = tabId !== undefined && player.tabId === tabId;
    if (inMatch && usedElsewhere && !sameTab) throw new FortressError('SEAT_IN_USE');
  }

  private findUserSeat(room: StoredRoom, who: SocketIdentity): StoredPlayer | undefined {
    if (who.userId === null) return undefined;
    return room.players.find((p) => p.userId === who.userId);
  }

  /**
   * 재입장·자리 넘겨받기 때 계정 장착 변경을 반영한다(F7). 스킨은 자리 주인의 것이라 같은 계정일 때만 —
   * 토큰 갈래는 다른 계정(로그인한 게스트 자리 등)이 들어올 수 있다. 진행 중 경기의 참가자 자리는 바꾸지 않는다:
   * 경기 화면·리플레이(시작 때 고정)가 같은 스킨이게. 조회 실패면 who.skin이 없어 기존 값 유지
   */
  private refreshSkin(room: StoredRoom, player: StoredPlayer, who: SocketIdentity): void {
    if (!who.skin || who.userId === null || who.userId !== player.userId) return;
    const inMatch = room.status === 'PLAYING' && room.match?.playerIds.includes(player.playerId) === true;
    if (!inMatch) player.skin = who.skin;
  }

  /** 기존 자리를 이 소켓으로 넘겨받는다 — 넘겨준 이전 소켓 id(없거나 같은 소켓이면 null) */
  private takeOver(room: StoredRoom, player: StoredPlayer, who: SocketIdentity, client: ClientTraits, now: number): string | null {
    this.assertCanTakeOver(room, player, who, client.tabId);
    const previous = player.socketId !== who.socketId ? player.socketId : null;
    player.socketId = who.socketId;
    player.tabId = client.tabId ?? null;
    this.refreshSkin(room, player, who);
    player.heartbeat = client.heartbeat === true;
    player.connected = true;
    player.connectedAt = now;
    player.disconnectedAt = null;
    return previous;
  }

  /**
   * 이탈. 방장이 나가면 다음 입장자에게 이양, 마지막 사람이 나가면 방 삭제.
   * 경기 중 이탈 = 즉시 resign(cause leave). 대상인지는 이탈을 커밋한 그 방 상태로 정한다(테트리스 리뷰 H1).
   * resign이 실패하면 경기 끊김 표시를 남겨 유예 뒤 resign되게 한다. 돌려주는 room은 경기 처리 뒤의 최신 방(종료로 RESULT가 됐을 수 있다)
   */
  async leaveRoom(code: string, socketId: string, now = Date.now()): Promise<RoomChangeResult> {
    const redis = this.requireRedis();
    void this.reconcileLiveness(redis, code, now);
    const { change, target } = await this.mutateRoom<{ change: RoomChangeResult; target: { matchId: string; playerId: string } | null }>(
      redis,
      code,
      now,
      (room, before) => {
        const player = this.requireMember(room, socketId);
        const target =
          room.status === 'PLAYING' && room.match?.playerIds.includes(player.playerId)
            ? { matchId: room.match.matchId, playerId: player.playerId }
            : null;
        this.removePlayer(room, player.playerId);
        if (room.players.length === 0) return { result: { change: { room: null, lobbyChanged: true }, target }, deleteRoom: true };
        return { result: { change: this.changeResult(room, before), target } };
      },
    );
    if (!target) return change;
    // 방에서는 이미 나갔다 — 여기서부터의 실패는 이탈을 되돌리지 않는다
    try {
      await this.matches.resign(target.matchId, target.playerId, 'leave', now);
    } catch (error) {
      this.logger.warn(`경기 중 이탈 resign 실패 — 유예 뒤 resign으로 회수: code=${code}, ${(error as Error).message}`);
      await this.matches.setDisconnected(target.matchId, target.playerId, now, now).catch((e: unknown) => {
        this.logger.warn(`이탈 끊김 기록도 실패 — 정리 깨우기가 resign 재시도: code=${code}, ${(e as Error).message}`);
      });
      // 둘 다 실패했어도 정리(sweepExpired → resignDepartedPlayers)가 다시 기권시킨다. 생존 확인 경로도 같은 회수를 한다
      this.scheduleWake(() => this.sweepExpired(code), FINISH_RETRY_DELAY_MS);
    }
    if (!change.room) return change;
    const latest = await this.rooms.load(redis, code).catch(() => null);
    // 종료 반영(RESULT)은 finishMatch가 이미 알렸다 — 게이트웨이가 마지막에 보내는 roomState가 옛 PLAYING이 되지 않게 최신으로
    return latest ? { room: this.toRoomState(latest.room), lobbyChanged: change.lobbyChanged } : change;
  }

  async setReady(code: string, socketId: string, ready: boolean, now = Date.now()): Promise<RoomChangeResult> {
    const redis = this.requireRedis();
    void this.reconcileLiveness(redis, code, now);
    const member = await this.requireMemberOf(redis, code, socketId);
    if (!(await this.consumeRateLimit('setReady', `${code}:${member.playerId}`))) throw new FortressError('RATE_LIMITED');
    return this.mutateRoom(redis, code, now, (room, before) => {
      const player = this.requireMember(room, socketId);
      if (room.status !== 'WAITING') throw new FortressError('MATCH_ALREADY_STARTED');
      player.ready = ready;
      return { result: this.changeResult(room, before) };
    });
  }

  // ==================== 방 설정·팀·탱크 (DESIGN §11) ====================

  /**
   * 방장 설정 변경(WAITING). 무엇이든 바뀌면 전원 ready=false(바뀐 게 없으면 쓰지 않는다).
   * - team 모드는 maxPlayers 4 고정(보낸 값 무시) · 현재 인원보다 작은 maxPlayers는 TOO_MANY_PLAYERS
   * - team으로 바꾸면 입장 순서대로 team 0,1,0,1(인원이 4명이 아니어도 허용 — 시작 때 TEAM_UNBALANCED) · ffa로 바꾸면 team null
   */
  async updateSettings(code: string, socketId: string, patch: Partial<RoomSettings>, now = Date.now()): Promise<RoomChangeResult> {
    const redis = this.requireRedis();
    await this.consumeEditLimit(redis, code, socketId);
    return this.mutateRoom(redis, code, now, (room, before) => {
      const player = this.requireMember(room, socketId);
      if (room.hostId !== player.playerId) throw new FortressError('NOT_HOST');
      if (room.status !== 'WAITING') throw new FortressError('MATCH_ALREADY_STARTED');
      const mode: RoomMode = patch.mode ?? room.mode;
      const mapId: RoomMapId = patch.mapId ?? room.mapId;
      const maxPlayers = mode === 'team' ? ROOM_MAX_PLAYERS : (patch.maxPlayers ?? room.maxPlayers);
      if (maxPlayers < room.players.length) throw new FortressError('TOO_MANY_PLAYERS');
      if (mode === room.mode && mapId === room.mapId && maxPlayers === room.maxPlayers) return { result: this.changeResult(room, before) };
      if (mode !== room.mode) {
        room.players.forEach((p, i) => {
          p.team = mode === 'team' ? (i % 2 === 0 ? 0 : 1) : null;
        });
      }
      room.mode = mode;
      room.mapId = mapId;
      room.maxPlayers = maxPlayers;
      for (const p of room.players) p.ready = false;
      return { result: this.changeResult(room, before) };
    });
  }

  /** 팀 선택(team 모드·WAITING) — 그 팀에 다른 사람이 이미 2명이면 TEAM_FULL. ready는 풀지 않는다. ffa 방이면 INVALID_PAYLOAD */
  async setTeam(code: string, socketId: string, team: 0 | 1, now = Date.now()): Promise<RoomChangeResult> {
    const redis = this.requireRedis();
    await this.consumeEditLimit(redis, code, socketId);
    return this.mutateRoom(redis, code, now, (room, before) => {
      const player = this.requireMember(room, socketId);
      if (room.status !== 'WAITING') throw new FortressError('MATCH_ALREADY_STARTED');
      if (room.mode !== 'team') throw new FortressError('INVALID_PAYLOAD', '팀전 방에서만 팀을 고를 수 있습니다.');
      if (player.team === team) return { result: this.changeResult(room, before) };
      if (room.players.filter((p) => p !== player && p.team === team).length >= TEAM_SIZE) throw new FortressError('TEAM_FULL');
      player.team = team;
      return { result: this.changeResult(room, before) };
    });
  }

  /** 탱크 선택(WAITING) — ready는 풀지 않는다 */
  async setTank(code: string, socketId: string, tankId: number, now = Date.now()): Promise<RoomChangeResult> {
    const redis = this.requireRedis();
    if (!Number.isInteger(tankId) || tankId < 0 || tankId >= TANKS.length) throw new FortressError('INVALID_PAYLOAD');
    await this.consumeEditLimit(redis, code, socketId);
    return this.mutateRoom(redis, code, now, (room, before) => {
      const player = this.requireMember(room, socketId);
      if (room.status !== 'WAITING') throw new FortressError('MATCH_ALREADY_STARTED');
      player.tankId = tankId;
      return { result: this.changeResult(room, before) };
    });
  }

  private async consumeEditLimit(redis: Redis, code: string, socketId: string): Promise<void> {
    const member = await this.requireMemberOf(redis, code, socketId);
    if (!(await this.consumeRateLimit('roomEdit', `${code}:${member.playerId}`))) throw new FortressError('RATE_LIMITED');
  }

  /**
   * 소켓 끊김 — connected=false만 표시하고 자리는 남긴다. WAITING·RESULT는 DISCONNECT_GRACE_MS 뒤 정리,
   * 경기 참가자면 경기에도 끊김 시각을 남긴다 → MATCH_DISCONNECT_GRACE_MS(30초)가 지나면 resign(disconnect). 유예 중 자기 턴은 마감 → skip
   */
  async markDisconnected(code: string, socketId: string, now = Date.now()): Promise<RoomChangeResult | null> {
    const redis = this.requireRedis();
    try {
      const outcome = await this.mutateRoom<{ change: RoomChangeResult; inMatch: { matchId: string; playerId: string } | null } | null>(
        redis,
        code,
        now,
        (room, before) => {
          const player = room.players.find((p) => p.socketId === socketId);
          if (!player) return { result: null };
          player.socketId = null;
          player.connected = false;
          player.disconnectedAt = now;
          const inMatch =
            room.status === 'PLAYING' && room.match?.playerIds.includes(player.playerId)
              ? { matchId: room.match.matchId, playerId: player.playerId }
              : null;
          return { result: { change: this.changeResult(room, before), inMatch } };
        },
      );
      if (outcome?.inMatch) {
        await this.markMatchDisconnected(redis, code, outcome.inMatch.matchId, outcome.inMatch.playerId, now).catch((error: unknown) => {
          this.logger.warn(`경기 끊김 기록 실패 — 깨우기가 회수: code=${code}, ${(error as Error).message}`);
        });
      }
      if (outcome) this.scheduleWake(() => this.sweepExpired(code), DISCONNECT_GRACE_MS + WAKE_MARGIN_MS);
      return outcome?.change ?? null;
    } catch (error) {
      if (error instanceof FortressError && error.code === 'ROOM_NOT_FOUND') return null;
      throw error;
    }
  }

  // ==================== 경기 ====================

  /**
   * 경기 시작 — 방장, WAITING, 2명↑, 방장 포함 전원 연결, 방장 외 전원 준비, team은 정확히 2:2.
   * 'random' 맵은 여기서 실제 맵으로 정한다. slot = 입장 순서 0..n−1(시작 순서·스폰은 seed로 엔진이 정함).
   * 경기 키를 먼저 만들고 방 CAS에서 같은 참가자·팀·탱크인지 다시 확인한다 — 그 사이 바뀌었으면 ROOM_BUSY(방장이 다시 누르면 된다).
   * 마감(ZSET·깨우기)은 방 CAS가 성공한 뒤에야 건다(activate, 리뷰 B1) — 방이 PLAYING이 되기 전에 레플리카가 죽으면 경기 키는 아무도 진행하지 않고 TTL로 사라진다
   */
  async startMatch(code: string, socketId: string, now = Date.now()): Promise<RoomChangeResult & { starting: MatchStartingPayload }> {
    const redis = this.requireRedis();
    const loaded = await this.rooms.load(redis, code);
    if (!loaded) throw new FortressError('ROOM_NOT_FOUND');
    const view = this.pruneDisconnected(loaded.room, now);
    this.assertCanStart(view, socketId);

    const matchId = randomBytes(MATCH_ID_BYTES).toString('base64url');
    const mapId: MapId = view.mapId === 'random' ? MAP_IDS[randomInt(MAP_IDS.length)] : view.mapId;
    const config: MatchConfig = {
      seed: randomInt(0, SEED_MAX + 1),
      mapId,
      mode: view.mode,
      // ffa는 엔진이 team을 무시한다(0으로 채움)
      players: view.players.map((p, slot) => ({ slot, team: view.mode === 'team' ? (p.team ?? 0) : 0, tankId: p.tankId })),
    };
    // skin은 시작 때 고정(F7) — 화면·리플레이가 같은 값이고, 경기 중 나가 roomState에서 빠진 참가자도 slots로 그린다
    const slots = view.players.map((p, slot) => ({ slot, playerId: p.playerId, name: p.name, skin: storedTankSkin(p.skin) }));
    const lineup = this.lineupOf(view);
    // userId는 결과 저장용(F6) — 경기 키에만 두고 matchStarting으로는 보내지 않는다
    const matchSlots = view.players.map((p, slot) => ({ ...slots[slot], userId: p.userId }));
    const match = await this.matches.create({ matchId, code, roomName: view.name, config, slots: matchSlots }, now);

    let roomCommitted = false;
    try {
      const change = await this.mutateRoom<RoomChangeResult>(redis, code, now, (room, before) => {
        this.assertCanStart(room, socketId);
        if (this.lineupOf(room) !== lineup) throw new FortressError('ROOM_BUSY');
        room.status = 'PLAYING';
        room.match = { matchId, playerIds: room.players.map((p) => p.playerId) };
        return { result: this.changeResult(room, before) };
      });
      roomCommitted = true;
      await this.matches.activate(match, now);
      const starting: MatchStartingPayload = {
        matchId,
        engineVersion: ENGINE_VERSION,
        config,
        slots,
        turn: this.matches.turnInfo(match, now),
        startInMs: MATCH_START_DELAY_MS,
        startAt: new Date(now + MATCH_START_DELAY_MS).toISOString(),
      };
      return { ...change, starting };
    } catch (error) {
      // 방은 PLAYING으로 커밋됐는데 마감 걸기가 실패했다 — 아직 아무도 matchId를 모르니(ack·방송 전) 방을 WAITING으로 되돌려 방장이 다시 누를 수 있게 한다(리뷰 B1·2차).
      // 경기 키는 방을 되돌렸을 때만 지운다 — 그 사이 다른 레플리카의 이탈 resign으로 끝나 방이 RESULT면 결과 저장·resync가 그 키를 쓴다(3차 리뷰)
      if (!roomCommitted || (await this.revertStart(redis, code, matchId, now))) await this.matches.remove(matchId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 시작 되돌리기 — 방이 아직 그 경기의 PLAYING이면 WAITING·match 없음으로 돌리고 roomState를 알린다. 던지지 않는다.
   * 되돌렸으면 true. 방이 이미 다른 상태로 갔거나(false) 실패하면 경기 키를 그대로 둔다 — 남은 PLAYING 방은 다음 생존 확인(reconcileLiveness)이 회수한다
   */
  private async revertStart(redis: Redis, code: string, matchId: string, now: number): Promise<boolean> {
    try {
      const change = await this.mutateRoom<RoomChangeResult | null>(redis, code, now, (room, before) => {
        if (room.status !== 'PLAYING' || room.match?.matchId !== matchId) return { result: null };
        room.status = 'WAITING';
        room.match = null;
        return { result: this.changeResult(room, before) };
      });
      if (!change) return false;
      this.notifyChange(code, change.room, change.lobbyChanged);
      return true;
    } catch (error) {
      this.logger.warn(`경기 시작 되돌리기 실패 — 생존 확인이 회수: code=${code}, match=${matchId}, ${(error as Error).message}`);
      return false;
    }
  }

  /** 시작 확인용 — 참가자·팀·탱크가 경기 설정을 만든 때와 같은지 */
  private lineupOf(room: StoredRoom): string {
    return JSON.stringify(room.players.map((p) => [p.playerId, p.team, p.tankId]));
  }

  /** 재대결 — 방장, RESULT → WAITING, 전원 ready=false. 끝난 경기의 방 반영이 늦었으면 먼저 반영한다 */
  async rematch(code: string, socketId: string, now = Date.now()): Promise<RoomChangeResult> {
    const redis = this.requireRedis();
    await this.repairEndedMatch(redis, code, now);
    return this.mutateRoom<RoomChangeResult>(redis, code, now, (room, before) => {
      const player = this.requireMember(room, socketId);
      if (room.hostId !== player.playerId) throw new FortressError('NOT_HOST');
      if (room.status === 'PLAYING') throw new FortressError('MATCH_ALREADY_STARTED');
      if (room.status !== 'RESULT') throw new FortressError('MATCH_NOT_FOUND');
      room.status = 'WAITING';
      room.match = null;
      for (const p of room.players) p.ready = false;
      return { result: this.changeResult(room, before) };
    });
  }

  /** 턴 제출 — 이 소켓이 이 방 진행 중 경기의 참가자인지 확인한 뒤 경기 서비스로(판정·방송은 경기 서비스) */
  async turnSubmit(code: string, socketId: string, input: TurnSubmitInput & { matchId: string }, now = Date.now()): Promise<void> {
    const redis = this.requireRedis();
    const { player } = await this.requireMatchMember(redis, code, socketId, input.matchId, ['PLAYING']);
    if (!(await this.consumeRateLimit('turnSubmit', `${code}:${player.playerId}`))) throw new FortressError('RATE_LIMITED');
    await this.clearStaleDisconnect(input.matchId, player.playerId, now);
    await this.matches.submit(input.matchId, player.playerId, input, now);
  }

  /** 경기 복원 — 진행 중이거나 직전(RESULT) 경기. 경기 키가 사라졌으면 MATCH_NOT_FOUND */
  async resync(code: string, socketId: string, input: { matchId: string; seq?: number; clientHash?: string }, now = Date.now()): Promise<MatchSnapshot> {
    const redis = this.requireRedis();
    const { player } = await this.requireMatchMember(redis, code, socketId, input.matchId, ['PLAYING', 'RESULT']);
    if (!(await this.consumeRateLimit('resync', `${code}:${player.playerId}`))) throw new FortressError('RATE_LIMITED');
    await this.clearStaleDisconnect(input.matchId, player.playerId, now);
    const snapshot = await this.matches.snapshot(input.matchId, now, input);
    if (!snapshot) throw new FortressError('MATCH_NOT_FOUND');
    return snapshot;
  }

  /**
   * 이 소켓이 자리를 대표한다고 확인된 뒤(requireMatchMember) 경기에 남은 끊김 기록을 지운다 — 재연결 경로의 해제가 실패했으면
   * 연결된 사람이 30초 뒤 resign되므로, 경기 요청(turnSubmit·resync)마다 한 번 더 바로잡는다. 기록이 없으면 쓰지 않는다(setDisconnected가 같은 값이면 무동작).
   * 실패해도 요청은 막지 않는다(로그만)
   */
  private async clearStaleDisconnect(matchId: string, playerId: string, now: number): Promise<void> {
    try {
      await this.matches.setDisconnected(matchId, playerId, null, now);
    } catch (error) {
      this.logger.warn(`경기 끊김 기록 해제 실패: match=${matchId}, player=${playerId}, ${(error as Error).message}`);
    }
  }

  /**
   * 경기 종료 반영(경기 서비스 endedHook) — 방이 아직 그 경기의 PLAYING이면 RESULT로 바꾸고 roomState를 알린다. 던지지 않는다.
   * 실패하면 잠시 뒤 다시(FINISH_RETRY_MAX_ATTEMPTS까지), 그래도 남으면 rematch 앞의 repairEndedMatch가 회수한다
   */
  async finishMatch(code: string, matchId: string, attempt = 0, now = Date.now()): Promise<void> {
    const redis = this.readyRedisClient();
    if (!redis) return;
    try {
      const change = await this.mutateRoom<RoomChangeResult | null>(redis, code, now, (room, before) => {
        if (room.status !== 'PLAYING' || room.match?.matchId !== matchId) return { result: null };
        room.status = 'RESULT';
        return { result: this.changeResult(room, before) };
      });
      if (!change) return;
      this.notifyChange(code, change.room, change.lobbyChanged);
      // 경기 중 끊긴 자리는 PLAYING 동안 정리되지 않는다 — RESULT가 된 지금부터 유예 정리를 깨운다
      if (change.room?.players.some((p) => !p.connected)) {
        this.scheduleWake(() => this.sweepExpired(code), WAKE_MARGIN_MS);
        this.scheduleWake(() => this.sweepExpired(code), DISCONNECT_GRACE_MS + WAKE_MARGIN_MS);
      }
    } catch (error) {
      if (error instanceof FortressError && error.code === 'ROOM_NOT_FOUND') return;
      this.logger.warn(`경기 종료 반영 실패 — 잠시 뒤 다시 시도: code=${code}, ${(error as Error).message}`);
      if (attempt < FINISH_RETRY_MAX_ATTEMPTS) {
        this.scheduleWake(() => this.finishMatch(code, matchId, attempt + 1), FINISH_RETRY_DELAY_MS);
      }
    }
  }

  /**
   * 방이 PLAYING인데 경기가 끝났거나(경기 키 ENDED — 종료 반영 실패) 경기 키가 없으면(TTL·축출, 시작 CAS 직후 레플리카 사망)
   * 지금 RESULT로 반영한다 — 경기 키가 없으면 결과(matchEnded)는 없이 방만 옮긴다(재대결로 빠져나올 수 있게)
   */
  private async repairEndedMatch(redis: Redis, code: string, now: number): Promise<void> {
    const loaded = await this.rooms.load(redis, code);
    const ref = loaded?.room.match;
    if (!loaded || !ref || loaded.room.status !== 'PLAYING') return;
    const snapshot = await this.matches.snapshot(ref.matchId, now);
    if (!snapshot || snapshot.turn === null) await this.finishMatch(code, ref.matchId, FINISH_RETRY_MAX_ATTEMPTS, now);
  }

  /**
   * 방에서는 빠졌는데(이탈) 경기에서는 아직 살아 있는 참가자를 기권시킨다(cause leave) — 이탈 resign과 그 대비책(끊김 기록)이
   * 둘 다 실패한 경우의 회수. resign은 이미 탈락이면 무동작이고 CAS라 여러 경로가 동시에 불러도 한 번만 들어간다
   */
  private async resignDepartedPlayers(room: StoredRoom, now: number): Promise<void> {
    const ref = room.match;
    if (room.status !== 'PLAYING' || !ref) return;
    const present = new Set(room.players.map((p) => p.playerId));
    for (const playerId of ref.playerIds) {
      if (!present.has(playerId)) await this.matches.resign(ref.matchId, playerId, 'leave', now);
    }
  }

  private assertCanStart(room: StoredRoom, socketId: string): void {
    const player = this.requireMember(room, socketId);
    if (room.hostId !== player.playerId) throw new FortressError('NOT_HOST');
    if (room.status !== 'WAITING') throw new FortressError('MATCH_ALREADY_STARTED');
    if (room.players.length < ROOM_MIN_PLAYERS) throw new FortressError('NOT_ENOUGH_PLAYERS');
    if (room.mode === 'team') {
      const teamA = room.players.filter((p) => p.team === 0).length;
      const teamB = room.players.filter((p) => p.team === 1).length;
      if (teamA !== TEAM_SIZE || teamB !== TEAM_SIZE) throw new FortressError('TEAM_UNBALANCED');
    }
    // 방장은 ready 불필요 — 시작 버튼이 곧 준비. 연결은 방장 포함 전원
    if (room.players.some((p) => !p.connected || (p.playerId !== room.hostId && !p.ready))) throw new FortressError('NOT_ALL_READY');
  }

  private async requireMatchMember(
    redis: Redis,
    code: string,
    socketId: string,
    matchId: string,
    statuses: RoomStatus[],
  ): Promise<{ room: StoredRoom; player: StoredPlayer; ref: StoredMatchRef }> {
    const loaded = await this.rooms.load(redis, code);
    if (!loaded) throw new FortressError('ROOM_NOT_FOUND');
    const player = this.requireMember(loaded.room, socketId);
    const ref = loaded.room.match;
    if (!statuses.includes(loaded.room.status) || !ref || ref.matchId !== matchId || !ref.playerIds.includes(player.playerId)) {
      throw new FortressError('MATCH_NOT_FOUND');
    }
    return { room: loaded.room, player, ref };
  }

  /**
   * 경기 중 재연결 — 지금도 이 소켓이 그 자리를 대표할 때만 경기 끊김 표시를 지운다(재연결 처리 중 다시 끊겼으면 끊김 기록이 남아야 한다,
   * 테트리스 리뷰 J1). 그 뒤 lazy 마감 처리 + 복원 정보
   */
  private async recoverMatch(code: string, playerId: string, socketId: string, now: number): Promise<{ match: MatchSnapshot } | null> {
    const redis = this.requireRedis();
    const loaded = await this.rooms.load(redis, code);
    const ref = loaded?.room.match;
    if (!loaded || loaded.room.status !== 'PLAYING' || !ref || !ref.playerIds.includes(playerId)) return null;
    const me = loaded.room.players.find((p) => p.playerId === playerId);
    if (me?.connected && me.socketId === socketId) await this.matches.setDisconnected(ref.matchId, playerId, null, now);
    const snapshot = await this.matches.snapshot(ref.matchId, now);
    return snapshot ? { match: snapshot } : null;
  }

  /**
   * 경기 끊김 시각 기록 후, 그 사이 같은 플레이어가 재연결했으면 기록을 지운다(테트리스 리뷰 H6) —
   * "끊김 커밋 → 재연결 커밋 → 이 기록"이 늦게 쓰여 살아 있는 플레이어가 유예 resign되는 순서를 막는다.
   * onlyIfEmpty: 이미 기록이 있으면 덮지 않는다(정리 경로가 기록 누락만 채운다)
   */
  private async markMatchDisconnected(
    redis: Redis,
    code: string,
    matchId: string,
    playerId: string,
    at: number,
    options: { onlyIfEmpty?: boolean } = {},
  ): Promise<void> {
    if (options.onlyIfEmpty) {
      const snapshot = await this.matches.disconnectedAt(matchId, playerId);
      if (snapshot !== null) return;
    }
    await this.matches.setDisconnected(matchId, playerId, at);
    const after = await this.rooms.load(redis, code);
    const player = after?.room.players.find((p) => p.playerId === playerId);
    if (player?.connected) await this.matches.setDisconnected(matchId, playerId, null);
  }

  // ==================== 강퇴 ====================

  /** 방장이 참가자를 내보낸다 — WAITING·RESULT에서만. 자리를 빼므로 토큰도 무효(재입장은 새 자리) */
  async kickPlayer(code: string, socketId: string, targetId: string, now = Date.now()): Promise<RoomChangeResult & { kickedSocketId: string | null }> {
    const redis = this.requireRedis();
    const member = await this.requireMemberOf(redis, code, socketId);
    if (!(await this.consumeRateLimit('kick', `${code}:${member.playerId}`))) throw new FortressError('RATE_LIMITED');
    return this.mutateRoom(redis, code, now, (room, before) => {
      const host = this.requireMember(room, socketId);
      if (room.hostId !== host.playerId) throw new FortressError('NOT_HOST');
      if (room.status === 'PLAYING') throw new FortressError('MATCH_ALREADY_STARTED');
      const target = room.players.find((p) => p.playerId === targetId);
      if (!target || target.playerId === host.playerId) throw new FortressError('PLAYER_NOT_FOUND');
      this.removePlayer(room, target.playerId);
      return { result: { ...this.changeResult(room, before), kickedSocketId: target.socketId } };
    });
  }

  // ==================== 하트비트 ====================

  /** presencePing 응답 기록 — 실패해도 던지지 않는다. 기록 뒤 방의 하트비트 판정을 시작한다 */
  async recordHeartbeat(code: string, socketId: string, now = Date.now()): Promise<void> {
    const redis = this.readyRedisClient();
    if (!redis) return;
    try {
      await touchHeartbeat(redis, KEYS.heartbeat(code, socketId), HEARTBEAT_TTL_MS);
    } catch (error) {
      this.logger.warn(`하트비트 기록 실패: code=${code}, ${(error as Error).message}`);
      return;
    }
    void this.reconcileHeartbeats(redis, code, now);
  }

  /**
   * 하트비트가 끊긴 자리를 끊김으로 표시하고 그 소켓을 서버에서 끊는다 — 방당 HEARTBEAT_PROBE_INTERVAL_MS에 1번(SET NX 게이트).
   * 대상: heartbeat=true인 연결된 자리 중 연결 후 HEARTBEAT_TTL_MS가 지났는데 하트비트 키가 없는 자리. 어떤 실패도 로그만
   */
  private async reconcileHeartbeats(redis: Redis, code: string, now: number): Promise<void> {
    try {
      if (!(await acquireIntervalGate(redis, KEYS.heartbeatProbe(code), HEARTBEAT_PROBE_INTERVAL_MS))) return;
      const loaded = await this.rooms.load(redis, code);
      if (!loaded) return;
      const due = loaded.room.players.filter(
        (p) => p.heartbeat && p.connected && p.socketId !== null && now - p.connectedAt >= HEARTBEAT_TTL_MS,
      );
      if (due.length === 0) return;
      const beats = await redis.mget(...due.map((p) => KEYS.heartbeat(code, p.socketId as string)));
      const silent = new Map(due.filter((_, i) => beats[i] === null).map((p) => [p.playerId, p.socketId]));
      if (silent.size === 0) return;
      await this.markGhosts(redis, code, now, (p) => silent.get(p.playerId) === p.socketId, true);
    } catch (error) {
      if (error instanceof FortressError && error.code === 'ROOM_NOT_FOUND') return;
      this.logger.warn(`하트비트 판정 실패 — 건너뜀: code=${code}, ${(error as Error).message}`);
    }
  }

  /**
   * 유령(connected=true인데 실제 소켓이 없는 플레이어) 정리 — 방당 LIVENESS_PROBE_INTERVAL_MS에 1번(SET NX 게이트, 레플리카 공통).
   * 방 채널에 없고 연결 후 LIVENESS_MIN_CONNECTED_MS가 지난 플레이어를 끊김으로 표시한다. 호출 쪽은 기다리지 않는다(void)
   */
  private async reconcileLiveness(redis: Redis, code: string, now: number): Promise<void> {
    if (!this.liveSocketProbe) return;
    try {
      if (!(await acquireIntervalGate(redis, KEYS.probe(code), LIVENESS_PROBE_INTERVAL_MS))) return;
      const live = await this.liveSocketProbe(code);
      await this.markGhosts(
        redis,
        code,
        now,
        (p) => p.socketId !== null && !live.has(p.socketId) && now - p.connectedAt >= LIVENESS_MIN_CONNECTED_MS,
        false,
      );
      // 이탈 resign이 빠진 참가자·끝난 경기가 방에 반영되지 않은 채 남았으면 회수
      const loaded = await this.rooms.load(redis, code);
      if (loaded) await this.resignDepartedPlayers(loaded.room, now);
      await this.repairEndedMatch(redis, code, now);
    } catch (error) {
      if (error instanceof FortressError && error.code === 'ROOM_NOT_FOUND') return;
      this.logger.warn(`생존 확인 실패 — 건너뜀: code=${code}, ${(error as Error).message}`);
    }
  }

  /** 판정한 유령을 끊김으로 표시(같은 소켓 그대로인 자리만) → 방송·정리 예약·(하트비트면) 소켓 끊기·경기 끊김 기록 */
  private async markGhosts(redis: Redis, code: string, now: number, isGhost: (p: StoredPlayer) => boolean, evict: boolean): Promise<void> {
    let ghosts: { playerId: string; socketId: string }[] = [];
    let matchId: string | null = null;
    const change = await this.mutateRoom<RoomChangeResult | null>(redis, code, now, (room, before) => {
      const found = room.players.filter((p) => p.connected && p.socketId !== null && isGhost(p));
      ghosts = found.map((p) => ({ playerId: p.playerId, socketId: p.socketId as string }));
      for (const p of found) {
        p.socketId = null;
        p.connected = false;
        p.disconnectedAt = now;
      }
      matchId = room.status === 'PLAYING' ? (room.match?.matchId ?? null) : null;
      return { result: found.length > 0 ? this.changeResult(room, before) : null };
    });
    if (!change) return;
    if (evict) this.socketEvictor?.(ghosts.map((g) => g.socketId));
    this.scheduleWake(() => this.sweepExpired(code), DISCONNECT_GRACE_MS + WAKE_MARGIN_MS);
    this.notifyChange(code, change.room, change.lobbyChanged);
    const inMatch: string | null = matchId;
    if (!inMatch) return;
    for (const ghost of ghosts) {
      await this.markMatchDisconnected(redis, code, inMatch, ghost.playerId, now).catch((error: unknown) => {
        this.logger.warn(`유령의 경기 끊김 기록 실패 — 깨우기가 회수: code=${code}, ${(error as Error).message}`);
      });
    }
  }

  // ==================== 채팅·이모트 ====================

  /** 채팅 — 대기실·경기 중 모두 방 멤버 전원 허용(D-004, 테트리스와 다름). 금지 문자·금칙어 → 빈도 순 */
  async prepareChat(code: string, socketId: string, text: string, now = Date.now()): Promise<ChatMessagePayload> {
    const redis = this.requireRedis();
    const player = await this.requireMemberOf(redis, code, socketId);
    if (!chatTextAllowed(text)) throw new FortressError('CHAT_FORBIDDEN');
    if (!(await this.consumeRateLimit('chat', `${code}:${player.playerId}`))) throw new FortressError('RATE_LIMITED');
    return { playerId: player.playerId, name: player.name, text, at: new Date(now).toISOString() };
  }

  async prepareEmote(code: string, socketId: string, emoteId: FortressEmoteId, now = Date.now()): Promise<EmoteReceivedPayload> {
    const redis = this.requireRedis();
    const player = await this.requireMemberOf(redis, code, socketId);
    if (!(await this.consumeRateLimit('emote', `${code}:${player.playerId}`))) throw new FortressError('RATE_LIMITED');
    return { playerId: player.playerId, emoteId, at: new Date(now).toISOString() };
  }

  /** 고정 윈도 빈도 제한(공용 GameRoomRateLimiter). Redis 실패면 통과(fail-open) */
  async consumeRateLimit(action: FortressRateLimitAction, subject: string): Promise<boolean> {
    return this.rateLimiter.consume(this.requireRedis(), action, subject);
  }

  // ==================== 내부: 저장·CAS ====================

  private requireRedis(): Redis {
    if (!this.redis || this.redis.status !== 'ready') throw new FortressError('SERVICE_UNAVAILABLE');
    return this.redis;
  }

  private async verifyPasswordOrThrow(
    redis: Redis,
    code: string,
    passwordHash: string,
    password: string | undefined,
    who: SocketIdentity,
  ): Promise<void> {
    const verdict = await verifyRoomPassword(
      redis,
      KEYS,
      { socket: PASSWORD_FAILURE_LIMIT, ip: PASSWORD_FAILURE_LIMIT_IP },
      code,
      passwordHash,
      password,
      who,
      this.logger,
    );
    if (verdict === 'LOCKED') throw new FortressError('ROOM_PASSWORD_LOCKED');
    if (verdict === 'WRONG') throw new FortressError('ROOM_WRONG_PASSWORD');
  }

  /**
   * 읽기 → 정리(유예 지난 끊긴 플레이어) → 변경 → CAS 쓰기. 버전이 바뀌었으면 처음부터 다시(테트리스 mutateRoom과 같은 규칙).
   * `fn`은 재시도될 수 있으므로 순수해야 한다. 바뀐 게 없으면 쓰지 않는다. 정리 결과 아무도 없으면 방을 지우고 ROOM_NOT_FOUND
   */
  private async mutateRoom<T>(
    redis: Redis,
    code: string,
    now: number,
    fn: (room: StoredRoom, before: StoredRoom) => MutationOutcome<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < ROOM_CAS_MAX_ATTEMPTS; attempt++) {
      const loaded = await this.rooms.load(redis, code);
      if (!loaded) throw new FortressError('ROOM_NOT_FOUND');
      const originalJson = JSON.stringify(loaded.room);
      const room = this.pruneDisconnected(loaded.room, now);

      if (room.players.length === 0) {
        if (await this.rooms.compareAndSet(redis, code, loaded.version, null)) this.notifyChange(code, null, true);
        throw new FortressError('ROOM_NOT_FOUND');
      }

      const before = JSON.parse(originalJson) as StoredRoom;
      let outcome: MutationOutcome<T>;
      try {
        outcome = fn(room, before);
      } catch (error) {
        // 요청은 거부됐지만 정리(유예 지난 플레이어 제거)는 반영하고 방송한다
        const prunedOnly = this.pruneDisconnected(loaded.room, now);
        if (
          error instanceof FortressError &&
          JSON.stringify(prunedOnly) !== originalJson &&
          (await this.rooms.compareAndSet(redis, code, loaded.version, prunedOnly))
        ) {
          const change = this.changeResult(prunedOnly, before);
          this.notifyChange(code, change.room, change.lobbyChanged);
        }
        throw error;
      }

      if (outcome.deleteRoom) {
        if (await this.rooms.compareAndSet(redis, code, loaded.version, null)) return outcome.result;
        continue;
      }
      if (JSON.stringify(room) === originalJson) return outcome.result;
      if (await this.rooms.compareAndSet(redis, code, loaded.version, room)) {
        if (outcome.result === null) {
          const change = this.changeResult(room, before);
          this.notifyChange(code, change.room, change.lobbyChanged);
        }
        return outcome.result;
      }
    }
    this.logger.warn(`방 변경 충돌 재시도 초과: code=${code}`);
    throw new FortressError('ROOM_BUSY');
  }

  private async requireMemberOf(redis: Redis, code: string, socketId: string): Promise<StoredPlayer> {
    const loaded = await this.rooms.load(redis, code);
    if (!loaded) throw new FortressError('ROOM_NOT_FOUND');
    return this.requireMember(loaded.room, socketId);
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
    if (!player) throw new FortressError('NOT_IN_ROOM');
    return player;
  }

  /** WAITING·RESULT 방에서 유예가 지난 끊긴 플레이어를 뺀다(새 객체). PLAYING은 경기 끊김 유예(resign)가 처리하므로 건드리지 않는다 */
  private pruneDisconnected(source: StoredRoom, now: number): StoredRoom {
    const room: StoredRoom = { ...source, players: source.players.map((p) => ({ ...p })) };
    if (room.status === 'PLAYING') return room;
    const expired = room.players.filter((p) => !p.connected && p.disconnectedAt !== null && now - p.disconnectedAt >= DISCONNECT_GRACE_MS);
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

  /** 새 자리 — team 모드면 사람이 적은 팀(같으면 0), 탱크 0 */
  private newPlayer(
    room: StoredRoom,
    playerId: string,
    name: string,
    who: SocketIdentity,
    tokenHash: string,
    client: ClientTraits,
    now: number,
  ): StoredPlayer {
    let team: 0 | 1 | null = null;
    if (room.mode === 'team') {
      const teamA = room.players.filter((p) => p.team === 0).length;
      const teamB = room.players.filter((p) => p.team === 1).length;
      team = teamA <= teamB ? 0 : 1;
    }
    return {
      playerId,
      name,
      ready: false,
      connected: true,
      userId: who.userId,
      tokenHash,
      team,
      tankId: 0,
      // 게스트는 항상 default — 로그인이면 게이트웨이가 읽은 계정 장착(조회 실패면 default)
      skin: who.userId === null ? defaultTankSkin() : (who.skin ?? defaultTankSkin()),
      socketId: who.socketId,
      tabId: client.tabId ?? null,
      heartbeat: client.heartbeat === true,
      joinedAt: now,
      connectedAt: now,
      disconnectedAt: null,
    };
  }

  private enterResult(room: StoredRoom, before: StoredRoom, playerId: string, playerToken: string, replacedSocketId: string | null): EnterRoomResult {
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
      mode: room.mode,
      mapId: room.mapId,
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
          extra: { team: p.team, tankId: p.tankId, skin: storedTankSkin(p.skin) },
        }),
      ),
    };
  }

  private toSummary(room: StoredRoom): RoomSummary {
    return {
      code: room.code,
      name: room.name,
      mode: room.mode,
      mapId: room.mapId,
      maxPlayers: room.maxPlayers,
      playerCount: room.players.length,
      locked: room.passwordHash !== null,
      status: room.status,
    };
  }

  private assertPlayerName(name: string): void {
    const verdict = checkPlayerName(name);
    if (verdict === 'INVALID') throw new FortressError('NAME_INVALID');
    if (verdict === 'FORBIDDEN') throw new FortressError('NAME_FORBIDDEN');
  }

  private assertRoomName(name: string): void {
    const verdict = checkRoomName(name, ROOM_NAME_MAX_LENGTH);
    if (verdict === 'INVALID') throw new FortressError('ROOM_NAME_INVALID');
    if (verdict === 'FORBIDDEN') throw new FortressError('ROOM_NAME_FORBIDDEN');
  }
}

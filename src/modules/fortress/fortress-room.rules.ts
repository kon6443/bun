import { checkPlayerName, checkRoomName } from '../game-room/game-room-text';
import { findMemberBySocket, pruneDisconnectedSeats } from '../game-room/game-room.rules';
import { defaultTankSkin, storedTankSkin } from './fortress-skins';
import { DISCONNECT_GRACE_MS } from './fortress.constants';
import { FortressError } from './fortress.errors';
import {
  FortressTankSkin,
  MatchSnapshot,
  ROOM_MIN_PLAYERS,
  ROOM_NAME_MAX_LENGTH,
  RoomPlayer,
  RoomSettings,
  RoomState,
  RoomStatus,
  RoomSummary,
  TEAM_SIZE,
} from './fortress.events';

/*
 * 포트리스 방 — 저장 모양과 순수 규칙. Redis·시각 소스·방송을 모른다(방 서비스가 읽기 → 이 규칙 → CAS 쓰기로 쓴다).
 * 거부는 FortressError로 던진다. 두 게임 공통 규칙(멤버십·제거·유예 정리)은 game-room.rules.ts에 있다.
 */

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

/** 멤버십 = 방 기록의 플레이어 중 대표 소켓이 이 소켓인 사람. 클라이언트가 보낸 playerId는 믿지 않는다 */
export function requireMember(room: StoredRoom, socketId: string): StoredPlayer {
  const player = findMemberBySocket(room, socketId);
  if (!player) throw new FortressError('NOT_IN_ROOM');
  return player;
}

/** WAITING·RESULT 방에서 유예가 지난 끊긴 플레이어를 뺀다(새 객체). PLAYING은 경기 끊김 유예(resign)가 처리하므로 건드리지 않는다 */
export function pruneDisconnected(source: StoredRoom, now: number): StoredRoom {
  return pruneDisconnectedSeats(source, now, DISCONNECT_GRACE_MS);
}

export function assertHost(room: StoredRoom, player: StoredPlayer): void {
  if (room.hostId !== player.playerId) throw new FortressError('NOT_HOST');
}

export function assertWaiting(room: StoredRoom): void {
  if (room.status !== 'WAITING') throw new FortressError('MATCH_ALREADY_STARTED');
}

/** 새 자리 — team 모드면 사람이 적은 팀(같으면 0), 탱크 0 */
export function newPlayer(
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

export function enterResult(room: StoredRoom, before: StoredRoom, playerId: string, playerToken: string, replacedSocketId: string | null): EnterRoomResult {
  return { ...changeResult(room, before), playerId, playerToken, replacedSocketId };
}

export function changeResult(room: StoredRoom, before: StoredRoom): { room: RoomState; lobbyChanged: boolean } {
  const lobbyChanged = JSON.stringify(toSummary(room)) !== JSON.stringify(toSummary(before));
  return { room: toRoomState(room), lobbyChanged };
}

export function toRoomState(room: StoredRoom): RoomState {
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

export function toSummary(room: StoredRoom): RoomSummary {
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

export function assertPlayerName(name: string): void {
  const verdict = checkPlayerName(name);
  if (verdict === 'INVALID') throw new FortressError('NAME_INVALID');
  if (verdict === 'FORBIDDEN') throw new FortressError('NAME_FORBIDDEN');
}

export function assertRoomName(name: string): void {
  const verdict = checkRoomName(name, ROOM_NAME_MAX_LENGTH);
  if (verdict === 'INVALID') throw new FortressError('ROOM_NAME_INVALID');
  if (verdict === 'FORBIDDEN') throw new FortressError('ROOM_NAME_FORBIDDEN');
}

export function assertCanStart(room: StoredRoom, socketId: string): void {
  const player = requireMember(room, socketId);
  assertHost(room, player);
  assertWaiting(room);
  if (room.players.length < ROOM_MIN_PLAYERS) throw new FortressError('NOT_ENOUGH_PLAYERS');
  if (room.mode === 'team') {
    const teamA = room.players.filter((p) => p.team === 0).length;
    const teamB = room.players.filter((p) => p.team === 1).length;
    if (teamA !== TEAM_SIZE || teamB !== TEAM_SIZE) throw new FortressError('TEAM_UNBALANCED');
  }
  // 방장은 ready 불필요 — 시작 버튼이 곧 준비. 연결은 방장 포함 전원
  if (room.players.some((p) => !p.connected || (p.playerId !== room.hostId && !p.ready))) throw new FortressError('NOT_ALL_READY');
}

/** 시작 확인용 — 참가자·팀·탱크가 경기 설정을 만든 때와 같은지 */
export function lineupOf(room: StoredRoom): string {
  return JSON.stringify(room.players.map((p) => [p.playerId, p.team, p.tankId]));
}

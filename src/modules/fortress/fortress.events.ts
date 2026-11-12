import type { Action, MatchConfig, MatchResult } from './engine';

/**
 * 포트리스 소켓 계약 — namespace `/fortress` (docs/tasks/fortress DESIGN §11, 프로토콜 v1 — D-011·D-012)
 *
 * **프론트가 이 파일을 기준으로 사본을 만든다.** 이벤트명·페이로드·에러 코드·상수를 바꾸면
 * 프론트 사본과 DESIGN §11을 같이 고친다(프론트 세션에 통보).
 *
 * 방·로비 이벤트명·ack 형태·에러 코드는 테트리스 대전(`tetris-battle.events.ts`)과 같다. 다른 점만 여기서 늘린다:
 * 방 설정(mode·mapId)·팀·탱크·경기 중 채팅 전원 허용·턴 이벤트. 엔진 타입(MatchConfig·Action·MatchResult)은 엔진 사본 그대로다.
 */

/** namespace */
export const FORTRESS_NAMESPACE = '/fortress';

// ==================== 이벤트명 ====================

/** 클라이언트 → 서버. 모든 핸들러는 ack로 `FortressAck`을 돌려준다(heartbeat 제외) */
export const FortressClientEvents = {
  /** 방 목록 조회 + 로비 구독(이후 `roomsChanged`) */
  LIST_ROOMS: 'listRooms',
  /** 방 생성 — 만든 사람이 방장으로 입장 */
  CREATE_ROOM: 'createRoom',
  /** 방 입장 — `playerToken`이면 재연결, 경기 중이면 ack `rejoin.match`로 복원 */
  JOIN_ROOM: 'joinRoom',
  /** 방 나가기 — 경기 중이면 즉시 기권(cause `leave`) */
  LEAVE_ROOM: 'leaveRoom',
  /** 준비 토글 (WAITING) */
  SET_READY: 'setReady',
  /** 방 설정 변경 (방장, WAITING) — 바뀌면 전원 ready=false */
  UPDATE_SETTINGS: 'updateSettings',
  /** 팀 선택 (team 모드, WAITING) — ready 유지 */
  SET_TEAM: 'setTeam',
  /** 탱크 선택 (WAITING) — ready 유지 */
  SET_TANK: 'setTank',
  /** 텍스트 채팅 (모든 상태 — 경기 중에도 전원, D-004) */
  CHAT: 'chat',
  /** 이모트 (프리셋 id만, 모든 상태) */
  EMOTE: 'emote',
  /** 경기 시작 (방장, WAITING, 시작 조건은 DESIGN §11) */
  START_MATCH: 'startMatch',
  /** 재대결 (방장, RESULT → WAITING, 전원 ready=false) */
  REMATCH: 'rematch',
  /** 강퇴 (방장, WAITING·RESULT) */
  KICK_PLAYER: 'kickPlayer',
  /** `presencePing` 응답 `{ code }` — ack 없음 */
  HEARTBEAT: 'heartbeat',
  /** 내 턴 행동 제출 — `TurnSubmitPayload` */
  TURN_SUBMIT: 'turnSubmit',
  /** 경기 복원 요청 — `ResyncPayload` → ack `MatchSnapshot` */
  RESYNC: 'resync',
  /**
   * 로비 전체 채팅 구독 — ack `JoinLobbyChatAckData`(최근 대화·참여 수). 이후 `lobbyChatMessage`를 받는다.
   * 재연결하면 다시 보낸다(서버가 자동으로 다시 넣지 않는다) — D-016, 테트리스 대전 로비 채팅과 같은 계약
   */
  JOIN_LOBBY_CHAT: 'joinLobbyChat',
  /** 로비 채팅 구독 해제 */
  LEAVE_LOBBY_CHAT: 'leaveLobbyChat',
  /** 로비 채팅 보내기 `LobbyChatPayload` — ack `{ message }`. 구독 전이면 `LOBBY_CHAT_NOT_JOINED` */
  LOBBY_CHAT: 'lobbyChat',
} as const;

/** 서버 → 클라이언트 */
export const FortressServerEvents = {
  /** 로비 구독자에게 방 목록 전체 — `{ rooms: RoomSummary[] }` */
  ROOMS_CHANGED: 'roomsChanged',
  /** 방 멤버에게 방 상태 전체 — `RoomState` */
  ROOM_STATE: 'roomState',
  /** 방 멤버에게 채팅 (보낸 사람 포함) */
  CHAT_MESSAGE: 'chatMessage',
  /** 방 멤버에게 이모트 (보낸 사람 포함) */
  EMOTE_RECEIVED: 'emoteReceived',
  /** 로비 채팅 구독자에게 (보낸 사람 포함) — `LobbyChatMessage`. 채널은 포트리스 전용(테트리스 로비 채팅과 섞이지 않는다, D-016) */
  LOBBY_CHAT_MESSAGE: 'lobbyChatMessage',
  /** ack 없이 보낸 요청이 실패했을 때만 */
  ERROR: 'error',
  /** 방 — `MatchStartingPayload` (첫 턴 TurnInfo 포함, 별도 턴 시작 이벤트는 없다) */
  MATCH_STARTING: 'matchStarting',
  /** 방 — `TurnResolvedPayload` (다음 턴 TurnInfo 포함) */
  TURN_RESOLVED: 'turnResolved',
  /** 방 — `MatchEndedPayload` (방 상태 RESULT) */
  MATCH_ENDED: 'matchEnded',
  /** 자리를 다른 소켓이 넘겨받았을 때 이전 소켓에만 — `{ code }` */
  SESSION_REPLACED: 'sessionReplaced',
  /** 강퇴된 소켓에만 — `{ code }` */
  KICKED: 'kicked',
  /** 서버 → 이 레플리카의 소켓 (페이로드 없음) — 방 안이면 바로 `heartbeat`로 답한다 */
  PRESENCE_PING: 'presencePing',
} as const;

// ==================== 에러 코드 ====================

/** ack 에러 `code`. 앞 부분은 테트리스 대전과 같은 이름·의미, `----- 포트리스 -----` 아래가 추가분 */
export const FortressErrorCodes = {
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_WRONG_PASSWORD: 'ROOM_WRONG_PASSWORD',
  ROOM_PASSWORD_LOCKED: 'ROOM_PASSWORD_LOCKED',
  NOT_HOST: 'NOT_HOST',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  MATCH_ALREADY_STARTED: 'MATCH_ALREADY_STARTED',
  MATCH_NOT_FOUND: 'MATCH_NOT_FOUND',
  NOT_ENOUGH_PLAYERS: 'NOT_ENOUGH_PLAYERS',
  NOT_ALL_READY: 'NOT_ALL_READY',
  NAME_INVALID: 'NAME_INVALID',
  NAME_FORBIDDEN: 'NAME_FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_PLAYER_TOKEN: 'INVALID_PLAYER_TOKEN',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  ROOM_NAME_INVALID: 'ROOM_NAME_INVALID',
  ROOM_NAME_FORBIDDEN: 'ROOM_NAME_FORBIDDEN',
  CHAT_FORBIDDEN: 'CHAT_FORBIDDEN',
  ROOM_BUSY: 'ROOM_BUSY',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SEAT_IN_USE: 'SEAT_IN_USE',
  PLAYER_NOT_FOUND: 'PLAYER_NOT_FOUND',
  /** 로비 채팅을 구독(joinLobbyChat)하지 않은 소켓이 보냄 */
  LOBBY_CHAT_NOT_JOINED: 'LOBBY_CHAT_NOT_JOINED',
  // ----- 포트리스 -----
  /** 지금 턴 주인이 아님 (탈락자 포함) */
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  /** 제출한 seq가 서버의 지금 턴과 다름 — 늦은·중복 제출. resync로 맞춘다 */
  TURN_MISMATCH: 'TURN_MISMATCH',
  /** 마감이 지남 — 서버가 이미 skip을 넣었거나 넣는다 */
  TURN_EXPIRED: 'TURN_EXPIRED',
  /** 시작 카운트다운(matchStarting.startAt) 전 제출 — 첫 턴 주인이 먼저 쏘지 못하게 */
  MATCH_NOT_STARTED: 'MATCH_NOT_STARTED',
  /** 엔진이 행동을 거부 — message에 엔진 reason(MOVE_RANGE 등) */
  ACTION_REJECTED: 'ACTION_REJECTED',
  /** setTeam: 그 팀이 이미 2명 */
  TEAM_FULL: 'TEAM_FULL',
  /** startMatch: team 모드인데 정확히 2:2가 아님 */
  TEAM_UNBALANCED: 'TEAM_UNBALANCED',
  /** updateSettings: 현재 인원보다 작은 maxPlayers */
  TOO_MANY_PLAYERS: 'TOO_MANY_PLAYERS',
} as const;

export type FortressErrorCode = (typeof FortressErrorCodes)[keyof typeof FortressErrorCodes];

// ==================== 공통 타입 ====================

/** 방 상태. WAITING →(startMatch) PLAYING →(경기 끝) RESULT →(rematch) WAITING */
export const ROOM_STATUSES = ['WAITING', 'PLAYING', 'RESULT'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const ROOM_MODES = ['ffa', 'team'] as const;
export type RoomMode = (typeof ROOM_MODES)[number];

/** 방 설정 맵 — 'random'은 서버가 시작 때 실제 맵으로 정해 `config.mapId`에 넣는다(엔진 config에는 오지 않는다) */
export const ROOM_MAP_IDS = ['hills', 'canyon', 'random'] as const;
export type RoomMapId = (typeof ROOM_MAP_IDS)[number];

export interface RoomSettings {
  mode: RoomMode;
  mapId: RoomMapId;
  /** 2~4, team은 4 고정 */
  maxPlayers: number;
}

export interface RoomSummary extends RoomSettings {
  code: string;
  name: string;
  playerCount: number;
  locked: boolean;
  status: RoomStatus;
}

/** 탱크 스킨 — F7 전까지 항상 `{ id: 'default', level: 1 }`. 프론트는 모르는 id를 default로 그린다 */
export interface FortressTankSkin {
  id: string;
  level: number;
}

/** 포트리스 게임별 플레이어 값 (공용 RoomPlayer의 `extra`) */
export interface FortressPlayerExtra {
  /** team 모드 0|1, ffa는 null */
  team: 0 | 1 | null;
  /** 0..2 (엔진 TANKS 인덱스) */
  tankId: number;
  skin: FortressTankSkin;
}

/** 방 안에서 보이는 플레이어 — 토큰·소켓·userId는 내보내지 않는다 */
export interface RoomPlayer {
  playerId: string;
  name: string;
  ready: boolean;
  /** false = 소켓이 끊겨 재연결 유예 중 */
  connected: boolean;
  isGuest: boolean;
  extra: FortressPlayerExtra;
}

/** 방 상태 — `roomState` 브로드캐스트와 create/join ack. players는 입장 순서 */
export interface RoomState extends RoomSettings {
  code: string;
  name: string;
  locked: boolean;
  hostId: string;
  status: RoomStatus;
  players: RoomPlayer[];
}

/** ack 공통 형태 */
export type FortressAck<T> = { ok: true; data: T } | { ok: false; code: FortressErrorCode; message: string };

/**
 * 턴 정보 — 첫 턴(`matchStarting.turn`)·다음 턴(`turnResolved.next`)·복원(`MatchSnapshot.turn`)이 모두 이 모양
 * - seq: 지금까지 적용된 행동 수 = 다음 행동의 actions 인덱스. `turnSubmit.seq`에 그대로 싣는다
 * - deadlineAt: 서버 시계 마감(ISO 8601, 기록용) · remainingMs: 서버가 보낼 때 계산한 남은 시간(표시는 이 값 — 기기 시계 무관)
 */
export interface TurnInfo {
  seq: number;
  turnNo: number;
  slot: number;
  deadlineAt: string;
  turnMs: number;
  remainingMs: number;
}

/** 행동이 들어간 이유 — player: 턴 주인 제출 · timeout: 마감 초과 skip · leave: leaveRoom 기권 · disconnect: 끊김 유예 초과 기권 */
export type TurnCause = 'player' | 'timeout' | 'leave' | 'disconnect';

/** resync ack·재연결 `rejoin.match` — 액션 재적용으로 복원한다(state JSON은 보내지 않는다) */
export interface MatchSnapshot {
  matchId: string;
  engineVersion: number;
  config: MatchConfig;
  actions: Action[];
  /** 마지막 행동 적용 후 stateHash */
  stateHash: string;
  /** null = 경기 끝 */
  turn: TurnInfo | null;
  slots: MatchSlot[];
}

export interface MatchSlot {
  slot: number;
  playerId: string;
  name: string;
  /** 경기 시작 때 고정한 탱크 스킨(F7) — 경기 중 방을 나가 roomState에 없는 참가자도 이 값으로 그린다 */
  skin: FortressTankSkin;
}

// ==================== 클라이언트 → 서버 페이로드 ====================

/** 필드명·검증은 테트리스 대전 CreateRoomDto와 같다(name = 방 이름) + 방 설정 */
export interface CreateRoomPayload extends RoomSettings {
  name: string;
  playerName: string;
  password?: string;
  tabId?: string;
  heartbeat?: boolean;
}

/**
 * 필드명·검증은 테트리스 대전 JoinRoomDto와 같다. `lastGarbageId`는 없다 —
 * 경기 중 재연결 복구는 `rejoin.match`(행동 목록 재적용)로 한다
 */
export interface JoinRoomPayload {
  code: string;
  password?: string;
  playerName: string;
  playerToken?: string;
  tabId?: string;
  heartbeat?: boolean;
}

/** 방 안 동작 공통 — 테트리스 대전 RoomCodeDto와 같다 */
export interface RoomCodePayload {
  code: string;
}

export interface KickPlayerPayload extends RoomCodePayload {
  playerId: string;
}

export interface SetReadyPayload extends RoomCodePayload {
  ready: boolean;
}

/** 대기실·경기 중 모두 허용(관전 없음 — 방 멤버만) */
export interface ChatPayload extends RoomCodePayload {
  text: string;
}

export interface EmotePayload extends RoomCodePayload {
  emoteId: FortressEmoteId;
}

export type UpdateSettingsPayload = RoomCodePayload & Partial<RoomSettings>;

export interface SetTeamPayload extends RoomCodePayload {
  team: 0 | 1;
}

export interface SetTankPayload extends RoomCodePayload {
  tankId: number;
}

export interface TurnSubmitPayload {
  matchId: string;
  seq: number;
  move: number;
  angle: number;
  power: number;
  weaponId: number;
}

/** 해시가 달라 요청할 때는 마지막으로 적용한 seq와 자기 해시를 싣는다(서버 버그 탐지 로그) */
export interface ResyncPayload {
  matchId: string;
  /** 마지막으로 적용한 행동 수(= 받은 TurnInfo.seq, actions.length) — clientHash는 이 수만큼 적용한 뒤의 해시 */
  seq?: number;
  clientHash?: string;
}

/** 로비 채팅 보내기 — name은 게스트만(로그인 사용자는 서버가 계정 이름으로 정하고 보낸 값은 무시) */
export interface LobbyChatPayload {
  text: string;
  name?: string;
}

// ==================== ack data ====================

export interface ListRoomsAckData {
  rooms: RoomSummary[];
}

/** createRoom·joinRoom 공통. `playerToken`은 재연결용 비밀값 */
export interface EnterRoomAckData {
  room: RoomState;
  playerId: string;
  playerToken: string;
  rejoin?: { match: MatchSnapshot };
}

export type EmptyAckData = Record<string, never>;

export interface JoinLobbyChatAckData {
  /** 최근 대화 — 오래된 것부터, 최대 50개·30분 이내 */
  messages: LobbyChatMessage[];
  /** 지금 로비 채팅에 들어와 있는 소켓 수(전 레플리카, 나 포함). 셀 수 없으면 null */
  onlineCount: number | null;
  /**
   * 내 표시 — 로그인 사용자는 서버가 정한 이름, 게스트는 null(보낼 때 name을 넣는다).
   * senderKey는 내 글의 senderKey와 같은 값 — 새로고침 뒤에도 지난 내 글을 알아본다(같은 IP 게스트끼리는 같은 키)
   */
  me: { isGuest: boolean; name: string | null; senderKey: string };
}

export interface LobbyChatAckData {
  message: LobbyChatMessage;
}

// ==================== 서버 → 클라이언트 페이로드 ====================

/** 이 소켓의 자리를 다른 소켓이 넘겨받음 — 복귀 재시도 금지 */
export interface SessionReplacedPayload {
  code: string;
}

/** 방장이 내보냄 — 토큰도 무효 */
export interface KickedPayload {
  code: string;
}

export interface RoomsChangedPayload {
  rooms: RoomSummary[];
}

export interface ChatMessagePayload {
  playerId: string;
  name: string;
  text: string;
  /** ISO 8601 (UTC) */
  at: string;
}

/** 로비 채팅 메시지 — 서버가 확정한 것만 방송한다 (D-016) */
export interface LobbyChatMessage {
  /** 메시지 id — 방송·ack·최근 대화를 합칠 때 중복 제거 키 */
  id: string;
  /** 차단용 불투명 키 — 로그인은 계정, 게스트는 접속 IP 기준 HMAC(신원은 알 수 없다). 같은 사람이면 같은 값 */
  senderKey: string;
  name: string;
  isGuest: boolean;
  text: string;
  /** ISO 8601 (UTC) */
  at: string;
}

export interface EmoteReceivedPayload {
  playerId: string;
  emoteId: FortressEmoteId;
  /** ISO 8601 (UTC) */
  at: string;
}

/** ack 없이 보낸 요청이 실패했을 때만(테트리스 대전과 같은 형태) — ack가 있는 요청은 ack로 받는다 */
export interface ErrorPayload {
  code: FortressErrorCode;
  message: string;
  /** ISO 8601 (UTC) */
  timestamp: string;
}

export interface MatchStartingPayload {
  matchId: string;
  /** 클라이언트 ENGINE_VERSION과 다르면 "새로고침 필요" 안내 */
  engineVersion: number;
  config: MatchConfig;
  slots: MatchSlot[];
  turn: TurnInfo;
  /** 수신 시각 + startInMs에 시작 */
  startInMs: number;
  startAt: string;
}

export interface TurnResolvedPayload {
  matchId: string;
  /** 이번 행동의 actions 인덱스 (적용 후 행동 수 = seq + 1) */
  seq: number;
  action: Action;
  cause: TurnCause;
  stateHash: string;
  /** null = 경기 끝 (곧 matchEnded). 남의 턴 resign이면 진행 중 턴 그대로(remainingMs 갱신) */
  next: TurnInfo | null;
}

export interface MatchResultEntry {
  playerId: string;
  name: string;
  slot: number;
  team: 0 | 1 | null;
  hp: number;
  /** 자기 턴 fire로 다른 팀에게 깎은 HP */
  damage: number;
  /** 자기 턴 fire로 다른 팀 탱크가 hp·out으로 죽은 수 */
  kos: number;
  /** 같은 값은 같은 순위(1, 1, 3) — DESIGN §11 place */
  place: number;
}

export interface MatchEndedPayload {
  matchId: string;
  result: MatchResult;
  /** 순위 오름차순, 같은 순위는 slot 순 */
  players: MatchResultEntry[];
  /** F6 리플레이 저장 후 */
  replay?: { id: string };
}

// ==================== 상수 ====================

/** 방 코드: 테트리스 대전과 같은 형식. 초대 링크 `/games/fortress/battle/{code}` */
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_MIN_PLAYERS = 2;
export const ROOM_MAX_PLAYERS = 4;
export const TEAM_SIZE = 2;
export const ROOM_NAME_MAX_LENGTH = 20;
export const ROOM_PASSWORD_MIN_LENGTH = 1;
export const ROOM_PASSWORD_MAX_LENGTH = 20;
export const CHAT_TEXT_MAX_LENGTH = 100;

/** 이모트 프리셋 — 테트리스 대전과 같은 id */
export const FORTRESS_EMOTE_IDS = ['gg', 'nice', 'wow', 'laugh', 'cry', 'angry'] as const;
export type FortressEmoteId = (typeof FORTRESS_EMOTE_IDS)[number];

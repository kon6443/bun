/**
 * 테트리스 대전 소켓 계약 — namespace `/tetris-battle` (docs/tasks/tetris-battle DESIGN §16, 프로토콜 v1)
 *
 * **프론트가 이 파일을 기준으로 사본을 만든다.** 이벤트명·페이로드·에러 코드·상수를 바꾸면
 * 프론트 사본과 DESIGN §16을 같이 고친다(프론트 세션에 통보).
 *
 * P1(방·로비): listRooms·createRoom·joinRoom·leaveRoom·setReady·chat·emote
 * P2(매치): startMatch·rematch·lock·topOut, 서버 → matchStarting·garbage·attack·opponentUpdate·playerKO·matchEnded
 */

/** namespace */
export const TETRIS_BATTLE_NAMESPACE = '/tetris-battle';

// ==================== 이벤트명 ====================

/** 클라이언트 → 서버. 모든 핸들러는 ack로 `TetrisBattleAck`을 돌려준다 */
export const TetrisBattleClientEvents = {
  /** 방 목록 조회 + 로비 구독(이후 `roomsChanged`를 받는다) */
  LIST_ROOMS: 'listRooms',
  /** 방 생성 — 성공 시 만든 사람이 방장으로 입장, 로비 구독 해제 */
  CREATE_ROOM: 'createRoom',
  /**
   * 방 입장 — `playerToken`이 있으면 재연결(같은 playerId로 복귀). 로그인 유저는 같은 userId의 자리가 있으면 그 자리로 복귀.
   * 경기 중 아직 연결된 자리는 같은 탭(`tabId` 일치)만 넘겨받는다 — 아니면 `SEAT_IN_USE` (tetris-audit D-007)
   */
  JOIN_ROOM: 'joinRoom',
  /** 방 나가기 */
  LEAVE_ROOM: 'leaveRoom',
  /** 준비 토글 (WAITING에서만) */
  SET_READY: 'setReady',
  /** 텍스트 채팅 (WAITING·RESULT, 경기 중에는 탈락자만 — tetris-audit D-016) */
  CHAT: 'chat',
  /** 이모트 (프리셋 id만, 모든 상태) */
  EMOTE: 'emote',
  /** 경기 시작 (방장, WAITING, 연결된 플레이어 2명↑ 전원 준비) */
  START_MATCH: 'startMatch',
  /** 재대결 (방장, RESULT → WAITING, 전원 ready=false) */
  REMATCH: 'rematch',
  /** 블록 고정 보고 — ack `{ targetId }`(다음 공격 대상) */
  LOCK: 'lock',
  /** 탑아웃 보고 */
  TOP_OUT: 'topOut',
  /** 강퇴 (방장, WAITING·RESULT, 방장 아닌 참가자) — tetris-audit D-011 */
  KICK_PLAYER: 'kickPlayer',
  /** `presencePing`에 대한 응답 `{ code }` — ack 없음 (tetris-audit D-010·D-012) */
  HEARTBEAT: 'heartbeat',
} as const;

/** 서버 → 클라이언트 */
export const TetrisBattleServerEvents = {
  /** 로비 구독자에게 방 목록 전체 — `{ rooms: RoomSummary[] }` */
  ROOMS_CHANGED: 'roomsChanged',
  /** 방 멤버에게 방 상태 전체 — `RoomState` */
  ROOM_STATE: 'roomState',
  /** 방 멤버에게 채팅 (보낸 사람 포함) */
  CHAT_MESSAGE: 'chatMessage',
  /** 방 멤버에게 이모트 (보낸 사람 포함) */
  EMOTE_RECEIVED: 'emoteReceived',
  /** ack 없이 보낸 요청이 실패했을 때만 (ack가 있으면 ack로 받는다) */
  ERROR: 'error',
  /** 방 — `MatchStartingPayload` */
  MATCH_STARTING: 'matchStarting',
  /**
   * 공격 대상 1명 — `GarbagePayload` (ack 없음, 유실은 재연결 lastGarbageId로 복구).
   * 재연결 직후에는 같은 가비지가 이 이벤트와 rejoin.missedGarbage로 **두 번 올 수 있다** —
   * 받는 쪽은 id ≤ 직전에 받은 id인 가비지를 버린다(대전 래퍼 receiveGarbage가 이미 그렇게 한다)
   */
  GARBAGE: 'garbage',
  /** 방 — `AttackPayload` (궤적·대상 표시) */
  ATTACK: 'attack',
  /** 방(보낸 사람 제외) — `OpponentUpdatePayload` */
  OPPONENT_UPDATE: 'opponentUpdate',
  /** 방 — `PlayerKOPayload` */
  PLAYER_KO: 'playerKO',
  /** 방 — `MatchEndedPayload` (방 상태 RESULT) */
  MATCH_ENDED: 'matchEnded',
  /** 자리를 다른 소켓(다른 탭·기기)이 넘겨받았을 때 이전 소켓에만 — `SessionReplacedPayload` (tetris-audit D-007) */
  SESSION_REPLACED: 'sessionReplaced',
  /** 강퇴된 소켓에만 — `KickedPayload` (tetris-audit D-011) */
  KICKED: 'kicked',
  /** 서버 → 이 레플리카의 소켓, 4초마다(페이로드 없음) — 방 안이면 바로 `heartbeat`로 답한다 (tetris-audit D-012) */
  PRESENCE_PING: 'presencePing',
} as const;

// ==================== 에러 코드 ====================

/**
 * ack 에러 `code`. 앞 15개는 DESIGN §16 v1 목록 그대로다.
 * 뒤 6개(`ROOM_NAME_INVALID`·`ROOM_NAME_FORBIDDEN`·`CHAT_FORBIDDEN`·`ROOM_BUSY`·`SERVICE_UNAVAILABLE`·`INTERNAL_ERROR`)는 P1 구현 중 추가.
 * `PLAYER_NOT_ALIVE`는 P2 구현 중 추가.
 */
export const TetrisBattleErrorCodes = {
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_WRONG_PASSWORD: 'ROOM_WRONG_PASSWORD',
  /** 같은 방 비밀번호를 연속으로 틀려 잠시 막힘 (소켓 단위 또는 IP 단위) */
  ROOM_PASSWORD_LOCKED: 'ROOM_PASSWORD_LOCKED',
  NOT_HOST: 'NOT_HOST',
  /** 이 소켓이 그 방의 플레이어가 아님 (멤버십 검증 실패) */
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  /** WAITING이 아닌 방에서 할 수 없는 동작(입장·준비)이나 경기 중 채팅 */
  MATCH_ALREADY_STARTED: 'MATCH_ALREADY_STARTED',
  MATCH_NOT_FOUND: 'MATCH_NOT_FOUND',
  NOT_ENOUGH_PLAYERS: 'NOT_ENOUGH_PLAYERS',
  NOT_ALL_READY: 'NOT_ALL_READY',
  /** 플레이어 이름 형식 위반 (게임 랭킹 이름 정책과 같은 규칙) */
  NAME_INVALID: 'NAME_INVALID',
  /** 플레이어 이름 금칙어 */
  NAME_FORBIDDEN: 'NAME_FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  /** 재연결 토큰이 이 방의 어떤 플레이어와도 맞지 않음 → 토큰 없이 새로 입장해야 한다 */
  INVALID_PLAYER_TOKEN: 'INVALID_PLAYER_TOKEN',
  /** 페이로드 형식 오류 (DTO 검증 실패) */
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  // ----- P1 추가 -----
  /** 방 이름 형식 위반 (1~20자, 제어문자 금지) — 플레이어 이름 오류와 구분 */
  ROOM_NAME_INVALID: 'ROOM_NAME_INVALID',
  /** 방 이름 금칙어 */
  ROOM_NAME_FORBIDDEN: 'ROOM_NAME_FORBIDDEN',
  /** 채팅 금칙어 */
  CHAT_FORBIDDEN: 'CHAT_FORBIDDEN',
  /** 같은 방 동시 변경 충돌이 재시도 한도를 넘음 — 잠시 후 재시도 */
  ROOM_BUSY: 'ROOM_BUSY',
  /** Redis 미연결 — 방 기능 전체 사용 불가 */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** 예상하지 못한 서버 오류 (내부 메시지는 노출하지 않는다) */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // ----- P2 추가 -----
  /** 이미 탈락한 플레이어의 lock (탈락 후 늦게 도착한 보고) */
  PLAYER_NOT_ALIVE: 'PLAYER_NOT_ALIVE',
  // ----- tetris-audit 추가 -----
  /** 경기 중인 자리를 다른 탭·기기가 아직 쓰고 있어 넘겨받을 수 없음 (D-007) */
  SEAT_IN_USE: 'SEAT_IN_USE',
  /** 강퇴 대상이 이 방에 없거나 방장 자신 (D-011) */
  PLAYER_NOT_FOUND: 'PLAYER_NOT_FOUND',
} as const;

export type TetrisBattleErrorCode = (typeof TetrisBattleErrorCodes)[keyof typeof TetrisBattleErrorCodes];

// ==================== 공통 타입 ====================

/** 방 상태. WAITING →(startMatch) PLAYING →(생존자 ≤1) RESULT →(rematch) WAITING */
export const ROOM_STATUSES = ['WAITING', 'PLAYING', 'RESULT'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/** 로비 목록 한 줄 — 비밀번호 방은 `locked: true`만 보인다 */
export interface RoomSummary {
  code: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
  locked: boolean;
  status: RoomStatus;
}

/** 방 안에서 보이는 플레이어 — 토큰·소켓·userId는 내보내지 않는다 */
export interface RoomPlayer {
  /** 방 내 고유 id (`p1`, `p2`, …) — 방 수명 동안 재사용하지 않는다 */
  playerId: string;
  name: string;
  ready: boolean;
  /** false = 소켓이 끊겨 재연결 유예 중 */
  connected: boolean;
  isGuest: boolean;
}

/** 방 상태 — `roomState` 브로드캐스트와 create/join ack에 쓴다. players는 입장 순서 */
export interface RoomState {
  code: string;
  name: string;
  maxPlayers: number;
  locked: boolean;
  hostId: string;
  status: RoomStatus;
  players: RoomPlayer[];
}

/** ack 공통 형태 */
export type TetrisBattleAck<T> = { ok: true; data: T } | { ok: false; code: TetrisBattleErrorCode; message: string };

// ==================== ack data ====================

export interface ListRoomsAckData {
  rooms: RoomSummary[];
}

/** createRoom·joinRoom 공통. `playerToken`은 재연결용 비밀값 — 클라이언트가 방 수명 동안 보관 */
export interface EnterRoomAckData {
  room: RoomState;
  playerId: string;
  playerToken: string;
  rejoin?: RejoinData;
}

/** leaveRoom·setReady·chat·emote·startMatch·rematch·topOut */
export type EmptyAckData = Record<string, never>;

/** lock ack — 다음 공격 대상(생존 상대가 없으면 null) */
export interface LockAckData {
  targetId: string | null;
}

/**
 * 재연결 복구(joinRoom이 기존 자리로 복귀 — playerToken 또는 같은 로그인 userId — 했고 방에 매치가 있을 때만) — DESIGN §16
 * - match.alive: 본인이 아직 생존인지(끊긴 사이 유예가 지나 KO됐으면 false) — v1 표에 없던 필드(P2 추가)
 * - missedGarbage: 본인이 받은 가비지 중 id > lastGarbageId (오래된 순)
 * - opponents: 본인 제외 플레이어의 최신 스냅샷(아직 lock이 없으면 빈 판)
 */
export interface RejoinData {
  match: { matchId: string; seed: number; status: 'PLAYING' | 'ENDED'; alive: boolean };
  missedGarbage: GarbagePayload[];
  opponents: { playerId: string; board: string; pending: number; alive: boolean }[];
}

// ==================== 서버 → 클라이언트 페이로드 ====================

/** 이 소켓의 자리를 다른 소켓이 넘겨받음 — 이 소켓은 더 이상 그 방의 멤버가 아니다(복귀 재시도 금지) */
export interface SessionReplacedPayload {
  code: string;
}

/** 방장이 이 소켓을 내보냄 — 토큰도 무효(다시 들어오면 새 자리) */
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

export type KoReason = 'topout' | 'disconnect' | 'leave';

export interface MatchStartingPayload {
  matchId: string;
  /** 엔진 seed (0 ~ 2^32−1) — 전원 같은 블록 순서 */
  seed: number;
  /** 수신 시각 + startInMs에 시작 */
  startInMs: number;
  /** 참고용 서버 시각 기준 시작 시각 (ISO 8601) */
  startAt: string;
  /** 참가자 (입장 순서) */
  players: { playerId: string; name: string }[];
}

export interface GarbagePayload {
  matchId: string;
  /** 받는 플레이어 기준 단조 증가 정수 (1부터) */
  id: number;
  /** 1 ~ MAX_ATTACK(22) */
  lines: number;
  /** 구멍 열 0~9 */
  hole: number;
  /** 보낸 플레이어 */
  from: string;
}

export interface AttackPayload {
  matchId: string;
  from: string;
  to: string;
  lines: number;
}

export interface OpponentUpdatePayload {
  matchId: string;
  playerId: string;
  /** 판 인코딩(아래 BOARD_* 상수) base64 */
  board: string;
  pending: number;
  combo: number;
  b2b: boolean;
}

export interface PlayerKOPayload {
  matchId: string;
  playerId: string;
  /** 마지막으로 이 플레이어에게 가비지를 보낸 사람 (없으면 null) */
  by: string | null;
  /** 최종 순위 (남은 생존자 수 + 1) */
  place: number;
  reason: KoReason;
}

export interface MatchResultEntry {
  playerId: string;
  name: string;
  place: number;
  kos: number;
  sent: number;
  received: number;
  pieces: number;
  maxCombo: number;
  /** 탈락 프레임, 우승자는 마지막 lock 프레임 */
  frames: number;
}

export interface MatchEndedPayload {
  matchId: string;
  /** 순위 오름차순 */
  results: MatchResultEntry[];
}

export interface EmoteReceivedPayload {
  playerId: string;
  emoteId: TetrisBattleEmoteId;
  /** ISO 8601 (UTC) */
  at: string;
}

// ==================== 상수 ====================

/** 방 코드: 6자, 혼동 문자(0·O·1·I·L) 제외 대문자+숫자. 초대 링크 `/games/tetris/battle/{code}` */
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const ROOM_MIN_PLAYERS = 2;
export const ROOM_MAX_PLAYERS = 4;
/** 방 이름 최대 길이(문자 수, 앞뒤 공백 제거·연속 공백 1개 정리 후) */
export const ROOM_NAME_MAX_LENGTH = 20;
/** 비밀번호 길이(문자 수) */
export const ROOM_PASSWORD_MIN_LENGTH = 1;
export const ROOM_PASSWORD_MAX_LENGTH = 20;
/** 채팅 최대 길이(문자 수, 앞뒤 공백 제거 후) */
export const CHAT_TEXT_MAX_LENGTH = 100;

/** 이모트 프리셋 — 이 id 외에는 거부한다. 그림·문구는 프론트가 id로 매핑 */
export const TETRIS_BATTLE_EMOTE_IDS = ['gg', 'nice', 'wow', 'laugh', 'cry', 'angry'] as const;
export type TetrisBattleEmoteId = (typeof TETRIS_BATTLE_EMOTE_IDS)[number];

/**
 * 판 인코딩 (P2 `lock.board`·`opponentUpdate.board`에서 쓴다 — DESIGN §16)
 *
 * - 엔진 판은 40행(0~39, 위→아래) × 10열이고 화면에 보이는 것은 아래 20행(20~39)이다.
 * - 보이는 20행만 위(행 20)→아래(행 39), 각 행은 왼쪽(열 0)→오른쪽(열 9) 순서로 칸당 1바이트를 늘어놓는다.
 *   바이트 인덱스 = (row - BOARD_VISIBLE_ROW_OFFSET) * BOARD_COLS + col
 * - 칸 값: 0 빈칸 · 1~7 블록(엔진 피스 값 그대로) · 8 가비지
 * - 200바이트를 표준 base64(패딩 포함)로 보낸다 → 문자열 길이 268
 */
export const BOARD_COLS = 10;
export const BOARD_VISIBLE_ROWS = 20;
export const BOARD_VISIBLE_ROW_OFFSET = 20;
export const BOARD_BYTES = BOARD_COLS * BOARD_VISIBLE_ROWS;
export const BOARD_BASE64_LENGTH = Math.ceil(BOARD_BYTES / 3) * 4;
export const BOARD_CELL_EMPTY = 0;
/** 블록 값 최대 — 이보다 큰 칸 값은 거부 (가비지 8 포함) */
export const BOARD_CELL_MAX = 8;
export const BOARD_CELL_GARBAGE = 8;

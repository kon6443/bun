/**
 * Fishing WebSocket 이벤트 상수
 *
 * /fishing namespace 전용 이벤트.
 * /teams namespace와 완전히 독립적으로 운영됨.
 */
export const FishingSocketEvents = {
  // ===== Client → Server 이벤트 =====
  /** 맵 room 참가 */
  JOIN_MAP: 'joinMap',
  /** 맵 room 퇴장 */
  LEAVE_MAP: 'leaveMap',
  /** 플레이어 위치 이동 */
  MOVE: 'move',
  /** 낚시 상태 변경 (casting, waiting, bite, challenge 등) */
  FISHING_STATE: 'fishingState',
  /** 채팅 메시지 전송 */
  CHAT_MESSAGE: 'chatMessage',
  /** 낚시 성공 결과 */
  CATCH_RESULT: 'catchResult',

  // ===== Server → Client 이벤트 =====
  /** 다른 유저 위치 업데이트 */
  PLAYER_MOVED: 'playerMoved',
  /** 다른 유저 낚시 상태 변경 */
  PLAYER_FISHING_STATE: 'playerFishingState',
  /** 채팅 메시지 수신 */
  CHAT_RECEIVED: 'chatReceived',
  /** 낚시 성공 알림 (전체 브로드캐스트) */
  CATCH_NOTIFICATION: 'catchNotification',
  /** 유저 접속 알림 */
  USER_JOINED: 'userJoined',
  /** 유저 퇴장 알림 */
  USER_LEFT: 'userLeft',
  /** 온라인 유저 목록 (접속 시 전송) */
  ONLINE_USERS: 'onlineUsers',
  /** 현재 플레이어 위치 목록 (접속 시 전송) */
  PLAYER_POSITIONS: 'playerPositions',

  // ===== 공통 이벤트 =====
  /** room 참가 성공 응답 */
  JOINED_MAP: 'joinedMap',
  /** room 퇴장 성공 응답 */
  LEFT_MAP: 'leftMap',
  /** 에러 */
  ERROR: 'error',
} as const;

export type FishingSocketEvent = (typeof FishingSocketEvents)[keyof typeof FishingSocketEvents];

// ===== 위치 관련 타입 =====

export interface PlayerPosition {
  x: number;
  y: number;
  direction: 'left' | 'right';
}

// ===== Client → Server 페이로드 =====

export interface JoinMapPayload {
  mapId: string;
}

export interface LeaveMapPayload {
  mapId: string;
}

export interface MovePayload {
  x: number;
  y: number;
  direction: 'left' | 'right';
}

export interface FishingStatePayload {
  state: 'idle' | 'casting' | 'waiting' | 'bite' | 'challenge' | 'success' | 'fail';
  pointId?: string;
}

export interface ChatMessagePayload {
  message: string;
}

export interface CatchResultPayload {
  fishName: string;
  grade: string;
  size: number;
  weight: number;
}

// ===== Server → Client 페이로드 =====

export interface PlayerMovedPayload {
  userId: number;
  userName: string;
  x: number;
  y: number;
  direction: 'left' | 'right';
  timestamp: number;
}

export interface PlayerFishingStatePayload {
  userId: number;
  userName: string;
  state: 'idle' | 'casting' | 'waiting' | 'bite' | 'challenge' | 'success' | 'fail';
  pointId?: string;
}

export interface ChatReceivedPayload {
  userId: number;
  userName: string;
  message: string;
  timestamp: string;
}

export interface CatchNotificationPayload {
  userId: number;
  userName: string;
  fishName: string;
  grade: string;
  size: number;
  weight: number;
  timestamp: string;
}

export interface FishingUserJoinedPayload {
  userId: number;
  userName: string;
  connectionCount: number;
  totalOnlineCount: number;
  position?: PlayerPosition;
}

export interface FishingUserLeftPayload {
  userId: number;
  userName: string;
  connectionCount: number;
  totalOnlineCount: number;
}

export interface FishingOnlineUserInfo {
  userId: number;
  userName: string;
  connectionCount: number;
  position?: PlayerPosition;
  fishingState?: string;
}

export interface FishingOnlineUsersPayload {
  mapId: string;
  users: FishingOnlineUserInfo[];
  totalCount: number;
}

export interface PlayerPositionsPayload {
  positions: Record<number, PlayerPosition & { userName: string; fishingState?: string }>;
}

export interface JoinedMapPayload {
  mapId: string;
  room: string;
}

export interface LeftMapPayload {
  mapId: string;
  room: string;
}

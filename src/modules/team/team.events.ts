/**
 * Team WebSocket 이벤트 상수
 *
 * NestJS 정석: 이벤트명을 상수로 관리하여 타입 안전성 확보
 */
export const TeamSocketEvents = {
  // ===== Client → Server 이벤트 =====
  /** 팀 room 참가 */
  JOIN_TEAM: 'joinTeam',
  /** 팀 room 퇴장 */
  LEAVE_TEAM: 'leaveTeam',
  /** 채팅 메시지 전송 */
  CHAT_MESSAGE: 'chatMessage',
  /** 채팅 읽음 위치 갱신 */
  CHAT_READ: 'chatRead',

  // ===== Server → Client 이벤트 =====
  /** 태스크 생성 알림 */
  TASK_CREATED: 'taskCreated',
  /** 태스크 수정 알림 */
  TASK_UPDATED: 'taskUpdated',
  /** 태스크 상태 변경 알림 (taskStatus) */
  TASK_STATUS_CHANGED: 'taskStatusChanged',
  /** 태스크 활성 상태 변경 알림 (actStatus) */
  TASK_ACTIVE_STATUS_CHANGED: 'taskActiveStatusChanged',
  /** 태스크 삭제 알림 */
  TASK_DELETED: 'taskDeleted',

  // ===== 태그 이벤트 =====
  /** 팀 태그 생성 알림 */
  TAG_CREATED: 'tagCreated',
  /** 팀 태그 이름·색 수정 알림 */
  TAG_UPDATED: 'tagUpdated',
  /** 팀 태그 삭제 알림 (붙어 있던 태스크에서도 제거됨) */
  TAG_DELETED: 'tagDeleted',
  /** 팀 태그 순서 변경 알림 */
  TAGS_REORDERED: 'tagsReordered',

  // ===== 댓글 이벤트 =====
  /** 댓글 생성 알림 */
  COMMENT_CREATED: 'commentCreated',
  /** 댓글 수정 알림 */
  COMMENT_UPDATED: 'commentUpdated',
  /** 댓글 삭제 알림 */
  COMMENT_DELETED: 'commentDeleted',

  // ===== 온라인 유저 이벤트 =====
  /** 유저 접속 알림 */
  USER_JOINED: 'userJoined',
  /** 유저 퇴장 알림 */
  USER_LEFT: 'userLeft',
  /** 온라인 유저 목록 */
  ONLINE_USERS: 'onlineUsers',

  // ===== 멤버 역할 이벤트 =====
  /** 멤버 역할 변경 알림 */
  MEMBER_ROLE_CHANGED: 'memberRoleChanged',
  /** 멤버 상태 변경 알림 */
  MEMBER_STATUS_CHANGED: 'memberStatusChanged',
  /** 초대 수락으로 멤버 가입·재가입 알림 */
  MEMBER_JOINED: 'memberJoined',

  // ===== 채팅 이벤트 =====
  /** 채팅 메시지 수신 */
  CHAT_RECEIVED: 'chatReceived',
  /** 멤버 읽음 위치 갱신 알림 */
  CHAT_READ_UPDATED: 'chatReadUpdated',

  // ===== 공통 이벤트 =====
  /** room 참가 성공 응답 */
  JOINED_TEAM: 'joinedTeam',
  /** room 퇴장 성공 응답 */
  LEFT_TEAM: 'leftTeam',
  /** 에러 */
  ERROR: 'error',
} as const;

/**
 * 이벤트 타입 (TypeScript 타입 추론용)
 */
export type TeamSocketEvent = (typeof TeamSocketEvents)[keyof typeof TeamSocketEvents];

// ===== 이벤트 페이로드 타입 정의 =====

/**
 * 태스크에 붙은 태그 (팀 태그 정렬 순서)
 */
export interface TaskTagPayload {
  tagId: number;
  tagName: string;
  tagColor: string;
}

/**
 * 태스크 생성 이벤트 페이로드
 */
export interface TaskCreatedPayload {
  taskId: number;
  teamId: number;
  taskName: string;
  taskDescription: string | null;
  taskStatus: number;
  actStatus: number;
  startAt: string | null;
  endAt: string | null;
  tags: TaskTagPayload[];
  createdBy: number;
}

/**
 * 태스크 수정 이벤트 페이로드
 */
export interface TaskUpdatedPayload {
  taskId: number;
  teamId: number;
  taskName?: string;
  taskDescription?: string | null;
  taskStatus?: number;
  startAt?: string | null;
  endAt?: string | null;
  /** 태스크의 현재 태그 전체 (변경 여부와 무관하게 항상 실음) */
  tags?: TaskTagPayload[];
  updatedBy: number;
}

/**
 * 태스크 상태 변경 이벤트 페이로드
 */
export interface TaskStatusChangedPayload {
  taskId: number;
  teamId: number;
  oldStatus: number;
  newStatus: number;
  completedAt: string | null;
  updatedBy: number;
}

/**
 * 태스크 활성 상태 변경 이벤트 페이로드
 */
export interface TaskActiveStatusChangedPayload {
  taskId: number;
  teamId: number;
  oldActStatus: number;
  newActStatus: number;
  updatedBy: number;
}

/**
 * 태스크 삭제 이벤트 페이로드
 */
export interface TaskDeletedPayload {
  taskId: number;
  teamId: number;
  deletedBy: number;
}

/**
 * 태그 생성 이벤트 페이로드
 */
export interface TagCreatedPayload {
  teamId: number;
  tagId: number;
  tagName: string;
  tagColor: string;
  sortOrder: number;
  createdBy: number;
}

/**
 * 태그 수정 이벤트 페이로드 (수정 후 태그 전체)
 */
export interface TagUpdatedPayload {
  teamId: number;
  tagId: number;
  tagName: string;
  tagColor: string;
  sortOrder: number;
  updatedBy: number;
}

/**
 * 태그 삭제 이벤트 페이로드 — 수신 측은 모든 태스크·필터에서 이 태그를 제거한다
 */
export interface TagDeletedPayload {
  teamId: number;
  tagId: number;
  deletedBy: number;
}

/**
 * 태그 순서 변경 이벤트 페이로드 — tagIds는 팀 전체 태그의 새 순서
 */
export interface TagsReorderedPayload {
  teamId: number;
  tagIds: number[];
  updatedBy: number;
}

/**
 * 댓글 생성 이벤트 페이로드
 */
export interface CommentCreatedPayload {
  commentId: number;
  taskId: number;
  teamId: number;
  userId: number;
  userName: string | null;
  commentContent: string;
  crtdAt: string;
}

/**
 * 댓글 수정 이벤트 페이로드
 */
export interface CommentUpdatedPayload {
  commentId: number;
  taskId: number;
  teamId: number;
  commentContent: string;
  mdfdAt: string;
  updatedBy: number;
}

/**
 * 댓글 삭제 이벤트 페이로드
 */
export interface CommentDeletedPayload {
  commentId: number;
  taskId: number;
  teamId: number;
  deletedBy: number;
}

/**
 * Room 참가 성공 응답 페이로드
 */
export interface JoinedTeamPayload {
  teamId: number;
  room: string;
}

/**
 * Room 퇴장 성공 응답 페이로드
 */
export interface LeftTeamPayload {
  teamId: number;
  room: string;
}

// ===== 온라인 유저 관련 타입 =====

/**
 * 온라인 유저 정보
 */
export interface OnlineUserInfo {
  userId: number;
  userName: string;
  connectionCount: number; // 같은 유저의 접속 수 (다중 탭)
}

/**
 * 유저 접속 이벤트 페이로드
 */
export interface UserJoinedPayload {
  teamId: number;
  userId: number;
  userName: string;
  connectionCount: number;
  totalOnlineCount: number;
}

/**
 * 유저 퇴장 이벤트 페이로드
 */
export interface UserLeftPayload {
  teamId: number;
  userId: number;
  userName: string;
  connectionCount: number; // 남은 접속 수 (0이면 완전히 오프라인)
  totalOnlineCount: number;
}

/**
 * 온라인 유저 목록 페이로드
 */
export interface OnlineUsersPayload {
  teamId: number;
  users: OnlineUserInfo[];
  totalCount: number;
}

// ===== 멤버 역할 관련 타입 =====

/**
 * 멤버 역할 변경 이벤트 페이로드
 */
export interface MemberRoleChangedPayload {
  teamId: number;
  userId: number;
  userName: string | null;
  previousRole: string;
  newRole: string;
  changedBy: number;
}

/**
 * 멤버 상태 변경 이벤트 페이로드
 */
export interface MemberStatusChangedPayload {
  teamId: number;
  userId: number;
  userName: string | null;
  previousStatus: number;
  newStatus: number;
  changedBy: number;
}

// ===== 채팅 관련 타입 =====

/**
 * 채팅 메시지 전송 페이로드 (Client → Server)
 *
 * teamId는 보내지 않음 — 서버가 소켓에 캐싱된 teamId로 room을 식별한다.
 * clientMsgId는 클라이언트가 생성한 메시지 식별자로, 낙관적 업데이트 및
 * 추후 저장 도입 시 중복 제거(dedup) 키로 사용한다.
 */
export interface ChatMessagePayload {
  message: string;
  clientMsgId: string;
}

/**
 * 채팅 메시지 수신 페이로드 (Server → Client) — 이력 조회 REST의 메시지 항목과 같은 형태
 *
 * messageId는 DB가 발급한 ID(팀 안에서 단조 증가)다. 읽음 커서와 비교하는 기준값이다.
 * clientMsgId는 보낸 클라이언트가 낙관적으로 띄운 메시지를 찾아 교체하는 키다.
 * 보낸 사람은 이 메시지까지 읽은 것으로 처리된다 — 프론트는 userId의 커서를 messageId로 올린다.
 */
export interface ChatReceivedPayload {
  messageId: number;
  clientMsgId: string;
  teamId: number;
  userId: number;
  userName: string;
  message: string;
  timestamp: string;
}

/**
 * 채팅 읽음 위치 갱신 페이로드 (Client → Server)
 *
 * 이 ID 이하의 메시지를 모두 읽었다는 뜻이다. 서버는 현재 커서보다 클 때만 반영한다.
 */
export interface ChatReadPayload {
  lastReadMessageId: number;
}

/**
 * 멤버 읽음 위치 갱신 알림 페이로드 (Server → Client)
 *
 * 커서가 실제로 전진했을 때만 보낸다. 프론트는 해당 멤버의 커서를 Math.max로 반영한다.
 */
export interface ChatReadUpdatedPayload {
  teamId: number;
  userId: number;
  lastReadMessageId: number;
}

/**
 * 멤버 가입 알림 페이로드 (Server → Client) — 초대 수락(신규·재가입)
 *
 * 가입 시점의 커서(팀 최신 메시지 ID)를 함께 보내 다른 화면이 안 읽은 인원 수를 바로 맞추게 한다.
 */
export interface MemberJoinedPayload {
  teamId: number;
  userId: number;
  userName: string;
  lastReadMessageId: number;
}

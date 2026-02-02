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

  // ===== 댓글 이벤트 =====
  /** 댓글 생성 알림 */
  COMMENT_CREATED: 'commentCreated',
  /** 댓글 수정 알림 */
  COMMENT_UPDATED: 'commentUpdated',
  /** 댓글 삭제 알림 */
  COMMENT_DELETED: 'commentDeleted',

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

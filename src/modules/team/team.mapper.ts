import type { TeamMemberType } from './team.service';
import { MANAGEMENT_ROLES, RoleKey } from '../../common/constants/role.constants';

/**
 * 조회 API 응답용 매핑 — 내부 조회 결과에서 **공개 필드만** 골라낸다.
 *
 * 서비스의 조회 헬퍼(`getTeamMembersBy`·`getTeamTasksBy`)는 알림 경로도 함께 쓰므로
 * 팀의 알림 채널 정보(`discordWebhookUrl`·`telegramChatId`)를 싣고 있다.
 * 객체를 펼쳐(`{ ...tm }`) 그대로 응답하면 이 값이 일반 멤버에게 노출된다(웹훅 URL만 있으면 채널에 임의 게시 가능).
 * 그래서 응답은 반드시 이 매퍼를 거친다 — 새 필드는 여기서 명시적으로 추가해야 나간다.
 */

/** 태스크 목록·상세 응답의 태스크 필드 (`TeamTaskDto`·`TaskDetailDto`와 같다) */
export type PublicTask = {
  taskId: number;
  teamId: number;
  taskName: string;
  taskDescription: string | null;
  taskStatus: number;
  actStatus: number;
  startAt: Date | null;
  endAt: Date | null;
  completedAt: Date | null;
  crtdAt: Date;
  crtdBy: number;
  userName: string | null;
};

export function toPublicTask(task: PublicTask): PublicTask {
  return {
    taskId: task.taskId,
    teamId: task.teamId,
    taskName: task.taskName,
    taskDescription: task.taskDescription,
    taskStatus: task.taskStatus,
    actStatus: task.actStatus,
    startAt: task.startAt,
    endAt: task.endAt,
    completedAt: task.completedAt,
    crtdAt: task.crtdAt,
    crtdBy: task.crtdBy,
    userName: task.userName,
  };
}

/** 내 팀 목록 응답의 한 항목 */
export type MyTeamItem = Omit<TeamMemberType, 'telegramChatId' | 'discordWebhookUrl'> & {
  unreadChatCount: number;
};

export function toMyTeamItem(tm: TeamMemberType, unreadChatCount: number): MyTeamItem {
  return {
    teamId: tm.teamId,
    userId: tm.userId,
    joinedAt: tm.joinedAt,
    role: tm.role,
    userActStatus: tm.userActStatus,
    teamName: tm.teamName,
    teamDescription: tm.teamDescription,
    crtdAt: tm.crtdAt,
    actStatus: tm.actStatus,
    leaderId: tm.leaderId,
    unreadChatCount,
  };
}

/**
 * 알림 연동 상태를 역할에 맞게 줄인다.
 *
 * 연동 정보를 바꾸는 API(연동 토큰 발급·웹훅 저장·해제)는 MASTER·MANAGER 전용인데,
 * 상태 조회는 팀 멤버 전체에 열려 있다. 그래서 일반 멤버에게는 연동 여부만 준다 —
 * 미사용 연동 토큰이나 웹훅 URL을 받으면 알림을 가로채거나 채널에 임의 게시할 수 있다.
 * 403이 아니라 축소 응답인 이유: 프론트가 팀 화면 진입 시 역할과 무관하게 조회한다.
 */
export function toLinkStatusForRole<T extends { isLinked: boolean }>(
  status: T,
  role: string,
): T | { isLinked: boolean } {
  if (MANAGEMENT_ROLES.includes(role as RoleKey)) {
    return status;
  }
  return { isLinked: status.isLinked };
}

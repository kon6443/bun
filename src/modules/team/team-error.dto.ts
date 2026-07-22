/**
 * Team Module Error DTOs
 * Separated from team.dto.ts to avoid circular dependency
 *
 * defineDomainError 팩토리로 정의 — 클래스명은 code에서 자동 생성되며
 * 기존 수동 클래스와 동일 (예: TEAM_FORBIDDEN → TeamForbiddenErrorResponseDto)
 */
import { defineDomainError } from '../../common/dto/define-domain-error';

/**
 * 팀을 찾을 수 없음 (404)
 * notification 모듈도 사용하므로 공통(src/common/dto/api-error.dto.ts)으로 승격 (D3).
 * 기존 import 경로 호환을 위해 re-export.
 */
export { TeamNotFoundErrorResponseDto } from '../../common/dto/api-error.dto';

/** 팀 접근 권한 없음 (403) */
export const TeamForbiddenErrorResponseDto = defineDomainError({
  code: 'TEAM_FORBIDDEN',
  status: 403,
  message: '팀에 접근할 권한이 없습니다.',
});

/** 태스크를 찾을 수 없음 (404) */
export const TeamTaskNotFoundErrorResponseDto = defineDomainError({
  code: 'TEAM_TASK_NOT_FOUND',
  status: 404,
  message: '태스크를 찾을 수 없습니다.',
});

/** 태스크 요청 오류 (400) */
export const TeamTaskBadRequestErrorResponseDto = defineDomainError({
  code: 'TEAM_TASK_BAD_REQUEST',
  status: 400,
  message: '태스크 요청이 올바르지 않습니다.',
});

/** 댓글을 찾을 수 없음 (404) */
export const TeamCommentNotFoundErrorResponseDto = defineDomainError({
  code: 'TEAM_COMMENT_NOT_FOUND',
  status: 404,
  message: '댓글을 찾을 수 없습니다.',
});

/** 댓글 권한 없음 (403) */
export const TeamCommentForbiddenErrorResponseDto = defineDomainError({
  code: 'TEAM_COMMENT_FORBIDDEN',
  status: 403,
  message: '댓글에 접근할 권한이 없습니다.',
});

/** 초대를 찾을 수 없음 (404) */
export const TeamInviteNotFoundErrorResponseDto = defineDomainError({
  code: 'TEAM_INVITE_NOT_FOUND',
  status: 404,
  message: '초대 링크를 찾을 수 없습니다.',
});

/** 초대 만료됨 (400) */
export const TeamInviteExpiredErrorResponseDto = defineDomainError({
  code: 'TEAM_INVITE_EXPIRED',
  status: 400,
  message: '만료된 초대 링크입니다.',
});

/** 초대 권한 없음 (403) */
export const TeamInviteForbiddenErrorResponseDto = defineDomainError({
  code: 'TEAM_INVITE_FORBIDDEN',
  status: 403,
  message: '초대 링크를 생성할 권한이 없습니다.',
});

/** 이미 팀 멤버임 (400) */
export const TeamMemberAlreadyExistsErrorResponseDto = defineDomainError({
  code: 'TEAM_MEMBER_ALREADY_EXISTS',
  status: 400,
  message: '이미 팀 멤버입니다.',
});

/** 팀 멤버를 찾을 수 없음 (404) */
export const TeamMemberNotFoundErrorResponseDto = defineDomainError({
  code: 'TEAM_MEMBER_NOT_FOUND',
  status: 404,
  message: '팀 멤버를 찾을 수 없습니다.',
});

/** 역할 변경 권한 없음 (403) */
export const TeamRoleChangeForbiddenErrorResponseDto = defineDomainError({
  code: 'TEAM_ROLE_CHANGE_FORBIDDEN',
  status: 403,
  message: '역할을 변경할 권한이 없습니다.',
});

/** 잘못된 역할 요청 (400) */
export const TeamInvalidRoleErrorResponseDto = defineDomainError({
  code: 'TEAM_INVALID_ROLE',
  status: 400,
  message: '유효하지 않은 역할입니다.',
});

/** 본인 역할 변경 불가 (400) */
export const TeamSelfRoleChangeErrorResponseDto = defineDomainError({
  code: 'TEAM_SELF_ROLE_CHANGE',
  status: 400,
  message: '본인의 역할은 변경할 수 없습니다.',
});

/** 멤버 상태 변경 권한 없음 (403) */
export const TeamMemberStatusChangeForbiddenErrorResponseDto = defineDomainError({
  code: 'TEAM_MEMBER_STATUS_CHANGE_FORBIDDEN',
  status: 403,
  message: '멤버 상태를 변경할 권한이 없습니다.',
});

/** 본인 상태 변경 불가 (400) */
export const TeamSelfStatusChangeErrorResponseDto = defineDomainError({
  code: 'TEAM_SELF_STATUS_CHANGE',
  status: 400,
  message: '본인의 상태는 변경할 수 없습니다.',
});

/** 마스터 상태 변경 불가 (400) */
export const TeamMasterStatusChangeErrorResponseDto = defineDomainError({
  code: 'TEAM_MASTER_STATUS_CHANGE',
  status: 400,
  message: '마스터의 상태는 변경할 수 없습니다.',
});

/** 디스코드 Webhook URL 유효성 검증 실패 (400) */
export const TeamDiscordWebhookInvalidErrorResponseDto = defineDomainError({
  code: 'TEAM_DISCORD_WEBHOOK_INVALID',
  status: 400,
  message: '유효하지 않은 디스코드 Webhook URL입니다.',
});

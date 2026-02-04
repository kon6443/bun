/**
 * Team Module Error DTOs
 * Separated from team.dto.ts to avoid circular dependency
 */
import { ApiProperty } from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../../common/dto/api-error.dto';

/**
 * 팀을 찾을 수 없음 (404)
 */
export class TeamNotFoundErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_NOT_FOUND', enum: ['TEAM_NOT_FOUND'] })
  readonly code: string = 'TEAM_NOT_FOUND';

  constructor(message: string = '팀을 찾을 수 없습니다.') {
    super(404, message, 'TEAM_NOT_FOUND');
  }
}

/**
 * 팀 접근 권한 없음 (403)
 */
export class TeamForbiddenErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_FORBIDDEN', enum: ['TEAM_FORBIDDEN'] })
  readonly code: string = 'TEAM_FORBIDDEN';

  constructor(message: string = '팀에 접근할 권한이 없습니다.') {
    super(403, message, 'TEAM_FORBIDDEN');
  }
}

/**
 * 태스크를 찾을 수 없음 (404)
 */
export class TeamTaskNotFoundErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_TASK_NOT_FOUND', enum: ['TEAM_TASK_NOT_FOUND'] })
  readonly code: string = 'TEAM_TASK_NOT_FOUND';

  constructor(message: string = '태스크를 찾을 수 없습니다.') {
    super(404, message, 'TEAM_TASK_NOT_FOUND');
  }
}

/**
 * 태스크 요청 오류 (400)
 */
export class TeamTaskBadRequestErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_TASK_BAD_REQUEST', enum: ['TEAM_TASK_BAD_REQUEST'] })
  readonly code: string = 'TEAM_TASK_BAD_REQUEST';

  constructor(message: string = '태스크 요청이 올바르지 않습니다.') {
    super(400, message, 'TEAM_TASK_BAD_REQUEST');
  }
}

/**
 * 댓글을 찾을 수 없음 (404)
 */
export class TeamCommentNotFoundErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_COMMENT_NOT_FOUND', enum: ['TEAM_COMMENT_NOT_FOUND'] })
  readonly code: string = 'TEAM_COMMENT_NOT_FOUND';

  constructor(message: string = '댓글을 찾을 수 없습니다.') {
    super(404, message, 'TEAM_COMMENT_NOT_FOUND');
  }
}

/**
 * 댓글 권한 없음 (403)
 */
export class TeamCommentForbiddenErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_COMMENT_FORBIDDEN', enum: ['TEAM_COMMENT_FORBIDDEN'] })
  readonly code: string = 'TEAM_COMMENT_FORBIDDEN';

  constructor(message: string = '댓글에 접근할 권한이 없습니다.') {
    super(403, message, 'TEAM_COMMENT_FORBIDDEN');
  }
}

/**
 * 초대를 찾을 수 없음 (404)
 */
export class TeamInviteNotFoundErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_INVITE_NOT_FOUND', enum: ['TEAM_INVITE_NOT_FOUND'] })
  readonly code: string = 'TEAM_INVITE_NOT_FOUND';

  constructor(message: string = '초대 링크를 찾을 수 없습니다.') {
    super(404, message, 'TEAM_INVITE_NOT_FOUND');
  }
}

/**
 * 초대 만료됨 (400)
 */
export class TeamInviteExpiredErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_INVITE_EXPIRED', enum: ['TEAM_INVITE_EXPIRED'] })
  readonly code: string = 'TEAM_INVITE_EXPIRED';

  constructor(message: string = '만료된 초대 링크입니다.') {
    super(400, message, 'TEAM_INVITE_EXPIRED');
  }
}

/**
 * 초대 권한 없음 (403)
 */
export class TeamInviteForbiddenErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_INVITE_FORBIDDEN', enum: ['TEAM_INVITE_FORBIDDEN'] })
  readonly code: string = 'TEAM_INVITE_FORBIDDEN';

  constructor(message: string = '초대 링크를 생성할 권한이 없습니다.') {
    super(403, message, 'TEAM_INVITE_FORBIDDEN');
  }
}

/**
 * 이미 팀 멤버임 (400)
 */
export class TeamMemberAlreadyExistsErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_MEMBER_ALREADY_EXISTS', enum: ['TEAM_MEMBER_ALREADY_EXISTS'] })
  readonly code: string = 'TEAM_MEMBER_ALREADY_EXISTS';

  constructor(message: string = '이미 팀 멤버입니다.') {
    super(400, message, 'TEAM_MEMBER_ALREADY_EXISTS');
  }
}

/**
 * 팀 멤버를 찾을 수 없음 (404)
 */
export class TeamMemberNotFoundErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_MEMBER_NOT_FOUND', enum: ['TEAM_MEMBER_NOT_FOUND'] })
  readonly code: string = 'TEAM_MEMBER_NOT_FOUND';

  constructor(message: string = '팀 멤버를 찾을 수 없습니다.') {
    super(404, message, 'TEAM_MEMBER_NOT_FOUND');
  }
}

/**
 * 역할 변경 권한 없음 (403)
 */
export class TeamRoleChangeForbiddenErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_ROLE_CHANGE_FORBIDDEN', enum: ['TEAM_ROLE_CHANGE_FORBIDDEN'] })
  readonly code: string = 'TEAM_ROLE_CHANGE_FORBIDDEN';

  constructor(message: string = '역할을 변경할 권한이 없습니다.') {
    super(403, message, 'TEAM_ROLE_CHANGE_FORBIDDEN');
  }
}

/**
 * 잘못된 역할 요청 (400)
 */
export class TeamInvalidRoleErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_INVALID_ROLE', enum: ['TEAM_INVALID_ROLE'] })
  readonly code: string = 'TEAM_INVALID_ROLE';

  constructor(message: string = '유효하지 않은 역할입니다.') {
    super(400, message, 'TEAM_INVALID_ROLE');
  }
}

/**
 * 본인 역할 변경 불가 (400)
 */
export class TeamSelfRoleChangeErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_SELF_ROLE_CHANGE', enum: ['TEAM_SELF_ROLE_CHANGE'] })
  readonly code: string = 'TEAM_SELF_ROLE_CHANGE';

  constructor(message: string = '본인의 역할은 변경할 수 없습니다.') {
    super(400, message, 'TEAM_SELF_ROLE_CHANGE');
  }
}

/**
 * Team Module DTOs
 * All DTOs for team module consolidated into a single file
 * Following NestJS standard DTO pattern
 */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  IsNumber,
  Min,
  Max,
  IsDate,
  IsEnum,
} from 'class-validator';
import { TaskStatus, ActStatus } from '../../common/enums/task-status.enum';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';

// ==================== Types ====================


export type TeamMemberRoleType = 'MASTER' | 'MANAGER' | 'MEMBER';

// ==================== Request DTOs ====================

export class CreateTeamDto {
  @ApiProperty({ description: '팀 이름', example: '개발팀' })
  @IsString()
  @IsNotEmpty()
  teamName: string;

  @ApiProperty({ description: '팀 설명', example: '팀 설명은 최대 100자 까지 입력 가능합니다.' })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  teamDescription: string;

  actStatus: number;

  leaderId: number;
}

export class UpdateTeamDto {
  @ApiProperty({ description: '팀 이름', example: '개발팀', required: false })
  @IsString()
  @IsOptional()
  teamName?: string;

  @ApiProperty({ description: '팀 설명', example: '팀 설명은 최대 100자 까지 입력 가능합니다.', required: false })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  teamDescription?: string;
}

export class CreateTeamTaskDto {
  @ApiProperty({ description: '태스크 이름', example: 'API 개발' })
  @IsString()
  @IsNotEmpty()
  taskName: string;

  @ApiProperty({ description: '태스크 설명', example: '팀 태스크 생성 API 개발', required: false })
  @IsString()
  @IsOptional()
  taskDescription: string;

  @ApiProperty({ description: '태스크 상태', example: TaskStatus.CREATED, default: TaskStatus.CREATED })
  @IsNumber()
  @Min(0)
  @IsOptional()
  taskStatus?: number;

  @ApiProperty({ description: '태스크 시작일', example: '2026-01-01', required: false })
  @IsDate()
  @IsOptional()
  startAt?: Date;

  @ApiProperty({ description: '태스크 종료일', example: '2026-01-01', required: false })
  @IsDate()
  @IsOptional()
  endAt?: Date;
}

export class UpdateTeamTaskDto {
  @ApiProperty({ description: '태스크 이름', example: 'API 개발', required: false })
  @IsString()
  @IsOptional()
  taskName?: string;

  @ApiProperty({ description: '태스크 설명', example: '팀 태스크 생성 API 개발', required: false })
  @IsString()
  @IsOptional()
  taskDescription?: string;

  @ApiProperty({ description: '태스크 시작일', example: '2026-01-01', required: false })
  @IsDate()
  @IsOptional()
  startAt?: Date;

  @ApiProperty({ description: '태스크 종료일', example: '2026-01-31', required: false })
  @IsDate()
  @IsOptional()
  endAt?: Date;
}

export class UpdateTaskStatusDto {
  @ApiProperty({
    description: '태스크 작업 상태',
    example: TaskStatus.IN_PROGRESS,
    enum: TaskStatus,
    enumName: 'TaskStatus',
  })
  @IsNumber()
  @IsEnum(TaskStatus)
  @Min(1)
  @Max(5)
  taskStatus: TaskStatus;
}

export class UpdateTaskActiveStatusDto {
  @ApiProperty({
    description: '태스크 활성 상태',
    example: ActStatus.ACTIVE,
    enum: ActStatus,
    enumName: 'ActStatus',
  })
  @IsNumber()
  @IsEnum(ActStatus)
  @Min(0)
  @Max(1)
  actStatus: ActStatus;
}

export class CreateTaskCommentDto {
  @ApiProperty({ description: '댓글 내용', example: '이 태스크에 대한 의견입니다.' })
  @IsString()
  @IsNotEmpty()
  commentContent: string;
}

export class UpdateTaskCommentDto {
  @ApiProperty({ description: '댓글 내용', example: '수정된 댓글 내용입니다.' })
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  commentContent?: string;
}

export class CreateTeamInviteDto {
  @ApiProperty({
    description: '만료 시간 (현재 시간부터 최대 7일까지만 설정 가능)',
    example: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })
  @IsNotEmpty()
  @IsDate()
  endAt: Date;

  @ApiProperty({ description: '최대 사용 횟수', example: 10 })
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  usageMaxCnt: number;
}

export class AcceptTeamInviteDto {
  @ApiProperty({ description: '초대 토큰', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  @IsString()
  @IsNotEmpty()
  token: string;
}

// ==================== Response DTOs ====================

// --- Team Info ---

export class TeamInfoDto {
  @ApiProperty({ description: '팀 ID', example: 1 })
  teamId: number;

  @ApiProperty({ description: '팀 이름', example: '개발팀' })
  teamName: string;

  @ApiProperty({ description: '팀 설명', example: '팀 설명입니다.', nullable: true })
  teamDescription: string | null;

  @ApiProperty({ description: '리더 ID', example: 1 })
  leaderId: number;

  @ApiProperty({ description: '팀 생성일시', example: '2026-01-01T00:00:00.000Z' })
  crtdAt: Date;

  @ApiProperty({ description: '활성 상태', example: 1 })
  actStatus: number;
}

export class CreateTeamResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '액션', example: '' })
  action: string;
}

export class UpdateTeamResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '수정된 팀 정보', type: TeamInfoDto })
  data: TeamInfoDto;
}

// --- Team Member ---

export class TeamMemberDto {
  @ApiProperty({ description: '팀 ID', example: 1 })
  teamId: number;

  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId: number;

  @ApiProperty({ description: '가입일시', example: '2026-01-01T00:00:00.000Z' })
  joinedAt: Date;

  @ApiProperty({ description: '역할', example: 'MASTER' })
  role: string;

  @ApiProperty({ description: '팀 이름', example: '개발팀' })
  teamName: string;

  @ApiProperty({ description: '팀 설명', example: '팀 설명입니다.', nullable: true })
  teamDescription: string | null;

  @ApiProperty({ description: '팀 생성일시', example: '2026-01-01T00:00:00.000Z' })
  crtdAt: Date;

  @ApiProperty({ description: '활성 상태', example: 1 })
  actStatus: number;

  @ApiProperty({ description: '리더 ID', example: 1 })
  leaderId: number;
}

export class TeamMemberListResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '팀 멤버 목록', type: [TeamMemberDto] })
  data: TeamMemberDto[];
}

// --- Team Users ---

export class TeamUserDto {
  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId: number;

  @ApiProperty({ description: '사용자 이름', example: '홍길동', nullable: true })
  userName: string | null;

  @ApiProperty({ description: '생년월일', example: '1990-01-01', nullable: true })
  birth: Date | null;

  @ApiProperty({ description: '카카오 이메일', example: 'user@example.com', nullable: true })
  kakaoEmail: string | null;

  @ApiProperty({ description: '팀 멤버 권한', example: 'MASTER' })
  role: TeamMemberRoleType;

  @ApiProperty({ description: '생성일시', example: '2026-01-01T00:00:00.000Z' })
  createdDate: Date;

  @ApiProperty({ description: '활성화 여부', example: 1 })
  isActivated: 0 | 1;
}

export class TeamUsersListResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '팀 사용자 목록', type: [TeamUserDto] })
  data: TeamUserDto[];
}

// --- Task ---

export class TeamTaskDto {
  @ApiProperty({ description: '태스크 ID', example: 1 })
  taskId: number;

  @ApiProperty({ description: '팀 ID', example: 1 })
  teamId: number;

  @ApiProperty({ description: '태스크 이름', example: 'API 개발' })
  taskName: string;

  @ApiProperty({ description: '태스크 설명', example: '팀 태스크 생성 API 개발', nullable: true })
  taskDescription: string | null;

  @ApiProperty({ description: '태스크 작업 상태', example: 1 })
  taskStatus: number;

  @ApiProperty({ description: '태스크 활성 상태', example: 1 })
  actStatus: number;

  @ApiProperty({ description: '시작일시', example: '2026-01-01T00:00:00.000Z', nullable: true })
  startAt: Date | null;

  @ApiProperty({ description: '종료일시', example: '2026-01-31T00:00:00.000Z', nullable: true })
  endAt: Date | null;

  @ApiProperty({ description: '생성일시', example: '2026-01-01T00:00:00.000Z' })
  crtdAt: Date;

  @ApiProperty({ description: '생성자 ID', example: 1 })
  crtdBy: number;
}

export class CreateTeamTaskResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '생성된 태스크 정보', type: TeamTaskDto })
  data: TeamTaskDto;
}

export class UpdateTeamTaskResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '수정된 태스크 정보', type: TeamTaskDto })
  data: TeamTaskDto;
}

export class TeamTaskListDataDto {
  @ApiProperty({ description: '팀 정보', type: TeamInfoDto })
  team: TeamInfoDto;

  @ApiProperty({ description: '태스크 목록', type: [TeamTaskDto] })
  tasks: TeamTaskDto[];
}

export class TeamTaskListResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '팀 정보와 태스크 목록', type: TeamTaskListDataDto })
  data: TeamTaskListDataDto;
}

// --- Task Comment ---

export class TaskCommentDto {
  @ApiProperty({ description: '댓글 ID', example: 1 })
  commentId: number;

  @ApiProperty({ description: '팀 ID', example: 1 })
  teamId: number;

  @ApiProperty({ description: '태스크 ID', example: 1 })
  taskId: number;

  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId: number;

  @ApiProperty({ description: '댓글 내용', example: '이 태스크에 대한 의견입니다.' })
  commentContent: string;

  @ApiProperty({ description: '상태 (0: 비활성, 1: 활성)', example: 1 })
  status: number;

  @ApiProperty({ description: '수정일시', example: '2026-01-01T00:00:00.000Z', nullable: true })
  mdfdAt: Date | null;

  @ApiProperty({ description: '생성일시', example: '2026-01-01T00:00:00.000Z' })
  crtdAt: Date;
}

export class TaskCommentWithUserDto {
  @ApiProperty({ description: '댓글 ID', example: 1 })
  commentId: number;

  @ApiProperty({ description: '팀 ID', example: 1 })
  teamId: number;

  @ApiProperty({ description: '태스크 ID', example: 1 })
  taskId: number;

  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId: number;

  @ApiProperty({ description: '작성자 이름', example: '홍길동', nullable: true })
  userName: string | null;

  @ApiProperty({ description: '댓글 내용', example: '이 태스크에 대한 의견입니다.' })
  commentContent: string;

  @ApiProperty({ description: '상태 (0: 비활성, 1: 활성)', example: 1 })
  status: number;

  @ApiProperty({ description: '수정일시', example: '2026-01-01T00:00:00.000Z', nullable: true })
  mdfdAt: Date | null;

  @ApiProperty({ description: '생성일시', example: '2026-01-01T00:00:00.000Z' })
  crtdAt: Date;
}

export class CreateTaskCommentResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '생성된 댓글 정보', type: TaskCommentDto })
  data: TaskCommentDto;
}

export class UpdateTaskCommentResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '수정된 댓글 정보', type: TaskCommentDto })
  data: TaskCommentDto;
}

export class DeleteTaskCommentResponseDto extends ApiSuccessResponseDto {}

export class TaskDetailDto {
  @ApiProperty({ description: '태스크 ID', example: 1 })
  taskId: number;

  @ApiProperty({ description: '팀 ID', example: 1 })
  teamId: number;

  @ApiProperty({ description: '태스크 이름', example: 'API 개발' })
  taskName: string;

  @ApiProperty({ description: '태스크 설명', example: '팀 태스크 생성 API 개발', nullable: true })
  taskDescription: string | null;

  @ApiProperty({ description: '태스크 작업 상태', example: 1 })
  taskStatus: number;

  @ApiProperty({ description: '태스크 활성 상태', example: 1 })
  actStatus: number;

  @ApiProperty({ description: '시작일시', example: '2026-01-01T00:00:00.000Z', nullable: true })
  startAt: Date | null;

  @ApiProperty({ description: '종료일시', example: '2026-01-31T00:00:00.000Z', nullable: true })
  endAt: Date | null;

  @ApiProperty({ description: '생성일시', example: '2026-01-01T00:00:00.000Z' })
  crtdAt: Date;

  @ApiProperty({ description: '생성자 ID', example: 1 })
  crtdBy: number;

  @ApiProperty({ description: '댓글 목록', type: [TaskCommentWithUserDto] })
  comments: TaskCommentWithUserDto[];
}

export class GetTaskDetailResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '태스크 상세 정보', type: TaskDetailDto })
  data: TaskDetailDto;
}

// --- Invite ---

export class CreateTeamInviteDataDto {
  @ApiProperty({ description: '생성된 초대 링크 URL', example: 'https://yourdomain.com/invite/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  inviteLink: string;

  @ApiProperty({ description: '만료 시간', example: '2024-12-31T23:59:59.000Z' })
  endAt: Date;

  @ApiProperty({ description: '최대 사용 횟수', example: 10 })
  usageMaxCnt: number;
}

export class CreateTeamInviteResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '초대 링크 정보', type: CreateTeamInviteDataDto })
  data: CreateTeamInviteDataDto;
}

export class AcceptTeamInviteDataDto {
  @ApiProperty({ description: '가입한 팀 ID', example: 1 })
  teamId: number;

  @ApiProperty({ description: '팀 이름', example: '개발팀' })
  teamName: string;
}

export class AcceptTeamInviteResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '가입한 팀 정보', type: AcceptTeamInviteDataDto })
  data: AcceptTeamInviteDataDto;
}

// --- Telegram ---

export class TelegramLinkDataDto {
  @ApiProperty({ description: '연동 토큰', example: 'a1b2c3d4e5f6...' })
  token: string;

  @ApiProperty({ description: '텔레그램 딥링크 URL', example: 'https://t.me/YourBot?startgroup=a1b2c3d4e5f6...' })
  deepLink: string;

  @ApiProperty({ description: '토큰 만료 시간', example: '2024-12-31T23:59:59.000Z' })
  endAt: Date;
}

export class CreateTelegramLinkResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '연동 정보', type: TelegramLinkDataDto })
  data: TelegramLinkDataDto;
}

export class TelegramStatusDataDto {
  @ApiProperty({ description: '연동 여부', example: true })
  isLinked: boolean;

  @ApiProperty({ description: '연동된 텔레그램 채팅 ID', example: -1001234567890, nullable: true })
  chatId: number | null;

  @ApiProperty({ description: '대기 중인 연동 정보', type: TelegramLinkDataDto, required: false })
  pendingLink?: TelegramLinkDataDto;
}

export class TelegramStatusResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '연동 상태 정보', type: TelegramStatusDataDto })
  data: TelegramStatusDataDto;
}

export class DeleteTelegramLinkResponseDto extends ApiSuccessResponseDto {}

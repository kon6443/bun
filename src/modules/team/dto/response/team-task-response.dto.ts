import { ApiProperty } from '@nestjs/swagger';
import { TaskCommentWithUserResponseDto } from './task-comment-response.dto';

export class TeamTaskResponseDto {
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

export class CreateTeamTaskResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;

  @ApiProperty({ description: '생성된 태스크 정보', type: TeamTaskResponseDto })
  data: TeamTaskResponseDto;
}

export class UpdateTeamTaskResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;

  @ApiProperty({ description: '수정된 태스크 정보', type: TeamTaskResponseDto })
  data: TeamTaskResponseDto;
}

export class TeamTaskListResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;

  @ApiProperty({ description: '태스크 목록', type: [TeamTaskResponseDto] })
  data: TeamTaskResponseDto[];
}

export class TaskDetailResponseDto extends TeamTaskResponseDto {
  @ApiProperty({ description: '댓글 목록', type: [TaskCommentWithUserResponseDto] })
  comments: TaskCommentWithUserResponseDto[];
}

export class GetTaskDetailResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;

  @ApiProperty({ description: '태스크 상세 정보', type: TaskDetailResponseDto })
  data: TaskDetailResponseDto;
}

import { ApiProperty } from '@nestjs/swagger';

export class TaskCommentResponseDto {
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

export class CreateTaskCommentResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;

  @ApiProperty({ description: '생성된 댓글 정보', type: TaskCommentResponseDto })
  data: TaskCommentResponseDto;
}

export class UpdateTaskCommentResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;

  @ApiProperty({ description: '수정된 댓글 정보', type: TaskCommentResponseDto })
  data: TaskCommentResponseDto;
}

export class DeleteTaskCommentResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;
}

export class TaskCommentWithUserResponseDto {
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

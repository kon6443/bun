import { ApiProperty } from '@nestjs/swagger';

export class TeamTaskResponseDto {
  @ApiProperty({ description: '태스크 ID', example: 1 })
  taskId: number;

  @ApiProperty({ description: '팀 ID', example: 1 })
  teamId: number;

  @ApiProperty({ description: '태스크 이름', example: 'API 개발' })
  taskName: string;

  @ApiProperty({ description: '태스크 설명', example: '팀 태스크 생성 API 개발', nullable: true })
  taskDescription: string | null;

  @ApiProperty({ description: '태스크 상태', example: 0 })
  taskStatus: number;

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

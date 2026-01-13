import { ApiProperty } from '@nestjs/swagger';

export class TeamMemberResponseDto {
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

export class TeamMemberListResponseDto {
  @ApiProperty({ description: '팀 멤버 목록', type: [TeamMemberResponseDto] })
  data: TeamMemberResponseDto[];
}

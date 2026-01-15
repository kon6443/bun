import { ApiProperty } from '@nestjs/swagger';
import { TeamMemberRoleType } from '../../team.service';

export class TeamUserResponseDto {
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

export class TeamUsersListResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;

  @ApiProperty({ description: '팀 사용자 목록', type: [TeamUserResponseDto] })
  data: TeamUserResponseDto[];
}

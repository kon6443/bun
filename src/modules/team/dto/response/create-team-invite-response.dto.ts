import { ApiProperty } from '@nestjs/swagger';

export class CreateTeamInviteResponseDto {
  @ApiProperty({ description: '생성된 초대 링크 URL', example: 'https://yourdomain.com/invite/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  inviteLink: string;

  @ApiProperty({ description: '만료 시간', example: '2024-12-31T23:59:59.000Z' })
  endAt: Date;

  @ApiProperty({ description: '최대 사용 횟수', example: 10 })
  usageMaxCnt: number;
}

import { ApiProperty } from '@nestjs/swagger';

export class AcceptTeamInviteResponseDto {
  @ApiProperty({ description: '가입한 팀 ID', example: 1 })
  teamId: number;

  @ApiProperty({ description: '팀 이름', example: '개발팀' })
  teamName: string;

  @ApiProperty({ description: '성공 메시지', example: '팀에 성공적으로 가입했습니다.' })
  message: string;
}

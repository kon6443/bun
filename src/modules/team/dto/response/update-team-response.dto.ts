import { ApiProperty } from '@nestjs/swagger';
import { TeamInfoResponseDto } from './team-task-response.dto';

export class UpdateTeamResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;

  @ApiProperty({ description: '수정된 팀 정보', type: TeamInfoResponseDto })
  data: TeamInfoResponseDto;
}

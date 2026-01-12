import { ApiProperty } from '@nestjs/swagger';

export class CreateTeamResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;

  @ApiProperty({ description: '액션', example: '' })
  action: string;
}

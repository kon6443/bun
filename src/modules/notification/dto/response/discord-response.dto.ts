import { ApiProperty } from '@nestjs/swagger';

export class DiscordResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'DISCORD ROUTER' })
  message: string;
}

export class SendMessageResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;
}

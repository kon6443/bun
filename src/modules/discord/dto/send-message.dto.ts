import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({ description: '메세지 내용', example: '디스코드 전송할 메세지 내용' })
  @IsString()
  @IsNotEmpty()
  message: string;
}



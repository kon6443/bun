import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class CreateTeamDto {
  @ApiProperty({ description: '팀 이름', example: '개발팀' })
  @IsString()
  @IsNotEmpty()
  teamName: string;
  actStatus: number;
  leaderId: number;
}


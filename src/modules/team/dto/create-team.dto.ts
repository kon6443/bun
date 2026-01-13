import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength, IsOptional } from 'class-validator';

export class CreateTeamDto {
  @ApiProperty({ description: '팀 이름', example: '개발팀' })
  @IsString()
  @IsNotEmpty()
  teamName: string;

  @ApiProperty({ description: '팀 설명', example: '팀 설명은 최대 100자 까지 입력 가능합니다.' })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  teamDescription: string;

  actStatus: number;

  leaderId: number;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, MaxLength } from 'class-validator';

export class UpdateTeamDto {
  @ApiProperty({ description: '팀 이름', example: '개발팀', required: false })
  @IsString()
  @IsOptional()
  teamName?: string;

  @ApiProperty({ description: '팀 설명', example: '팀 설명은 최대 100자 까지 입력 가능합니다.', required: false })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  teamDescription?: string;
}

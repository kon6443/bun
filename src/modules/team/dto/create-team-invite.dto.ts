import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsNotEmpty, Min, IsDate } from 'class-validator';

export class CreateTeamInviteDto {
  @ApiProperty({ description: '만료 시간', example: '2026-01-01T00:00:00.000Z' })
  @IsNotEmpty()
  @IsDate()
  endAt: Date;

  @ApiProperty({ description: '최대 사용 횟수', example: 10 })
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  usageMaxCnt: number;
}

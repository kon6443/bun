import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsNotEmpty, Min, IsDate } from 'class-validator';

export class CreateTeamInviteDto {
  @ApiProperty({
    description: '만료 시간 (현재 시간부터 최대 7일까지만 설정 가능)',
    example: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })
  @IsNotEmpty()
  @IsDate()
  endAt: Date;

  @ApiProperty({ description: '최대 사용 횟수', example: 10 })
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  usageMaxCnt: number;
}

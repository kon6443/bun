import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsEnum, Min, Max } from 'class-validator';
import { ActStatus } from '../../../common/enums/task-status.enum';

export class UpdateTaskActiveStatusDto {
  @ApiProperty({
    description: '태스크 활성 상태',
    example: ActStatus.ACTIVE,
    enum: ActStatus,
    enumName: 'ActStatus',
  })
  @IsNumber()
  @IsEnum(ActStatus)
  @Min(0)
  @Max(1)
  actStatus: ActStatus;
}

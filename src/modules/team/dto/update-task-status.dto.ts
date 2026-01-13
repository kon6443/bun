import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsEnum, Min, Max } from 'class-validator';
import { TaskStatus } from '../../../common/enums/task-status.enum';

export class UpdateTaskStatusDto {
  @ApiProperty({
    description: '태스크 작업 상태',
    example: TaskStatus.IN_PROGRESS,
    enum: TaskStatus,
    enumName: 'TaskStatus',
  })
  @IsNumber()
  @IsEnum(TaskStatus)
  @Min(1)
  @Max(5)
  taskStatus: TaskStatus;
}

import { TaskStatus } from '../../../common/enums/task-status.enum';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, Min, IsDate } from 'class-validator';

export class CreateTeamTaskDto {
  @ApiProperty({ description: '태스크 이름', example: 'API 개발' })
  @IsString()
  @IsNotEmpty()
  taskName: string;

  @ApiProperty({ description: '태스크 설명', example: '팀 태스크 생성 API 개발', required: false })
  @IsString()
  @IsOptional()
  taskDescription: string;

  @ApiProperty({ description: '태스크 상태', example: TaskStatus.CREATED, default: TaskStatus.CREATED })
  @IsNumber()
  @Min(0)
  @IsOptional()
  taskStatus?: number;

  @ApiProperty({ description: '태스크 시작일', example: '2026-01-01', required: false })
  @IsDate()
  @IsOptional()
  startAt?: Date;

  @ApiProperty({ description: '태스크 종료일', example: '2026-01-01', required: false })
  @IsDate()
  @IsOptional()
  endAt?: Date;
}

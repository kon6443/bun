import { ApiProperty } from '@nestjs/swagger';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';

// ==================== Response DTOs ====================

export class MainResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '데이터', example: null, nullable: true, type: 'null' })
  data: null;
}

export class HealthCheckDataDto {
  @ApiProperty({ description: '데이터베이스 연결 상태', example: 'connected', enum: ['connected', 'disconnected'] })
  database: string;
}

export class HealthCheckResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '헬스 체크 데이터', type: HealthCheckDataDto })
  data: HealthCheckDataDto;
}

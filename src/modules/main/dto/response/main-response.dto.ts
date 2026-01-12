import { ApiProperty } from '@nestjs/swagger';

export class MainResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;
}

export class HealthCheckResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'CONNECTION HEALTHY' })
  message: string;

  @ApiProperty({ description: '데이터베이스 연결 상태', example: 'connected', enum: ['connected', 'disconnected'] })
  database: string;
}

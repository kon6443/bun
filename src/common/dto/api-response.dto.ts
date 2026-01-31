import { ApiProperty } from '@nestjs/swagger';

// ==================== 성공 응답 ====================

export class ApiSuccessResponseDto {
  @ApiProperty({ example: 'SUCCESS', enum: ['SUCCESS'] })
  code!: 'SUCCESS';

  @ApiProperty({ description: '응답 메시지', example: '' })
  message!: string;
}

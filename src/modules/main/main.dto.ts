import { ApiProperty } from '@nestjs/swagger';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';

// ==================== Response DTOs ====================

export class MainResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '데이터', example: null, nullable: true, type: 'null' })
  data: null;
}

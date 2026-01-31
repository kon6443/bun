import { ApiProperty } from '@nestjs/swagger';
import { ApiSuccessResponseDto } from '../../../../common/dto';

export class UpdateUserDataDto {
  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId!: number;

  @ApiProperty({ description: '사용자 닉네임', example: '홍길동' })
  userName!: string;
}

export class UpdateUserResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: UpdateUserDataDto })
  data!: UpdateUserDataDto;
}

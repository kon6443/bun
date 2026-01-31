import { ApiProperty } from '@nestjs/swagger';
import { ApiSuccessResponseDto } from '../../../../common/dto';

export class UserProfileDataDto {
  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId!: number;

  @ApiProperty({ description: '사용자 닉네임', example: '홍길동' })
  userName!: string;

  @ApiProperty({ description: '카카오 이메일', example: 'user@kakao.com', nullable: true })
  kakaoEmail!: string | null;

  @ApiProperty({ description: '가입일', example: '2024-01-15T09:30:00.000Z' })
  createdDate!: string;
}

export class UserProfileResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: UserProfileDataDto })
  data!: UserProfileDataDto;
}

import { ApiProperty } from '@nestjs/swagger';
import { ApiSuccessResponseDto } from '../../../../common/dto';

export class KakaoSignInUpDataDto {
  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId!: number;

  @ApiProperty({ description: '사용자 닉네임', example: '홍길동' })
  userName!: string;

  @ApiProperty({ description: '로그인 타입', example: 'KAKAO' })
  loginType!: string;

  @ApiProperty({ description: '액세스 토큰', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken!: string;

  @ApiProperty({ description: '토큰 타입', example: 'Bearer' })
  tokenType!: string;
}

export class KakaoSignInUpResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: KakaoSignInUpDataDto })
  data!: KakaoSignInUpDataDto;
}

import { ApiProperty } from '@nestjs/swagger';

export class KakaoSignInUpResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'KAKAO LOGIN SUCCESS' })
  message: string;

  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId: number;

  @ApiProperty({ description: '로그인 타입', example: 'kakao' })
  loginType: string;

  @ApiProperty({ description: '액세스 토큰', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken: string;

  @ApiProperty({ description: '토큰 타입', example: 'Bearer' })
  tokenType: string;
}

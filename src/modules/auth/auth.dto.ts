import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';

// ==================== Request DTOs ====================

export class KakaoSignInUpDto {
  /** @deprecated 서버가 쓰지 않는다 — 신규 가입 닉네임은 랜덤 부여. 구 프론트 호환을 위해 받기만 한다(forbidNonWhitelisted) */
  @ApiProperty({
    description: '(사용 안 함) 카카오 닉네임 — 보내도 무시된다. 신규 가입자 닉네임은 서버가 랜덤으로 부여',
    example: 'kakao_test_nick',
    required: false,
    deprecated: true,
  })
  @IsString()
  @IsOptional()
  kakaoNickname?: string;

  @ApiProperty({ description: '카카오 액세스 토큰', example: 'asefwefhiowehgwioehgow' })
  @IsString()
  @IsNotEmpty()
  accessToken: string;
}

// ==================== Response DTOs ====================

export class KakaoSignInUpDataDto {
  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId: number;

  @ApiProperty({ description: '사용자 닉네임 (신규 가입자는 랜덤 기본 닉네임)', example: '용감한수달4821' })
  userName: string;

  @ApiProperty({ description: '로그인 타입', example: 'KAKAO' })
  loginType: string;

  @ApiProperty({ description: '액세스 토큰', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken: string;

  @ApiProperty({ description: '토큰 타입', example: 'Bearer' })
  tokenType: string;
}

export class KakaoSignInUpResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: KakaoSignInUpDataDto })
  data: KakaoSignInUpDataDto;
}


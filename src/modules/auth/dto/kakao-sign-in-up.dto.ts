import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class KakaoSignInUpDto {
  @ApiProperty({ description: '카카오 닉네임', example: 'kakao_test_nick', required: false })
  @IsString()
  @IsOptional()
  kakaoNickname?: string;

  @ApiProperty({ description: '카카오 액세스 토큰', example: 'asefwefhiowehgwioehgow' })
  @IsString()
  @IsNotEmpty()
  accessToken: string;
}


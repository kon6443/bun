import { Controller, Post, Body, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { KakaoSignInUpDto } from './dto/kakao-sign-in-up.dto';
import { KakaoSignInUpResponseDto } from './dto/response/kakao-sign-in-up-response.dto';

@ApiTags('auth')
@ApiCookieAuth('cookieAuth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post('kakao')
  @ApiOperation({ summary: '카카오 로그인 & 회원가입' })
  // @ApiResponse는 Swagger 문서화용입니다. 실제 HTTP 상태 코드를 변경하지 않습니다.
  // 실제 상태 코드는 @HttpCode() 데코레이터나 return 값으로 결정됩니다.
  @ApiResponse({ status: 200, description: '성공 (기존 사용자 로그인 또는 신규 사용자 회원가입)', type: KakaoSignInUpResponseDto })
  @ApiResponse({ status: 400, description: '나쁜 요청' })
  @ApiResponse({ status: 401, description: '유효하지 않은 앱키나 토큰으로 요청' })
  @ApiResponse({ status: 404, description: '해당 자원을 찾을 수 없음' })
  @ApiResponse({ status: 500, description: '내부 서버 오류' })
  async postKakaoSignInUp(@Body() kakaoUserSign: KakaoSignInUpDto) {
    const { userId, userName, loginType, accessToken } = await this.authService.postKakaoSignInUp({
      kakaoUserSign,
    });
    return {
      code: 'SUCCESS',
      data: {
        userId,
        userName,
        loginType,
        accessToken,
        tokenType: 'Bearer',
      },
      message: '',
    };
  }
}

import { Controller, Post, Body, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { THROTTLE_AUTH_SHORT, THROTTLE_AUTH_LONG } from '../../common/constants/throttle.constants';
import {
  ApiCommonValidationResponse,
  ApiThrottledResponse,
  ApiCommonInternalServerErrorResponse,
} from '../../common/decorators/api-error-response.decorator';
import { AuthService } from './auth.service';
import { KakaoSignInUpDto, KakaoSignInUpResponseDto } from './auth.dto';
import {
  AuthUnauthorizedErrorResponseDto,
  AuthKakaoApiErrorResponseDto,
} from './auth-error.dto';

@ApiTags('auth')
@ApiCookieAuth('cookieAuth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post('kakao')
  @Throttle({ short: THROTTLE_AUTH_SHORT, long: THROTTLE_AUTH_LONG }) // 로그인: 초당 2회, 분당 10회
  @ApiOperation({ summary: '카카오 로그인 & 회원가입' })
  // @ApiResponse는 Swagger 문서화용입니다. 실제 HTTP 상태 코드를 변경하지 않습니다.
  // 실제 상태 코드는 @HttpCode() 데코레이터나 return 값으로 결정됩니다.
  @ApiResponse({ status: 200, description: '성공 (기존 사용자 로그인 또는 신규 사용자 회원가입)', type: KakaoSignInUpResponseDto })
  @ApiResponse({ status: 401, description: '카카오 액세스 토큰 누락 또는 JWT 설정 오류', type: AuthUnauthorizedErrorResponseDto })
  @ApiCommonValidationResponse()
  @ApiThrottledResponse('요청 횟수 초과 (초당 2회 / 분당 10회)')
  @ApiCommonInternalServerErrorResponse('내부 서버 오류')
  @ApiResponse({ status: 502, description: '카카오 인증 실패', type: AuthKakaoApiErrorResponseDto })
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

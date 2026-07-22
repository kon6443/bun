import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import {
  ApiInternalServerErrorResponseDto,
  ApiTooManyRequestsErrorResponseDto,
  ApiValidationErrorResponseDto,
} from '../dto/api-error.dto';
import { AuthUnauthorizedErrorResponseDto } from '../../modules/auth/auth-error.dto';

/**
 * 401 Unauthorized — 인증 토큰 누락/무효
 *
 * JwtAuthGuard 적용된 모든 엔드포인트에서 반복 사용. NestJS 기본
 * `ApiUnauthorizedResponse`와 이름 구분을 위해 `Common` 접두사 사용.
 *
 * 실제 발생 code: AUTH_UNAUTHORIZED(토큰 누락·사용자 없음) | AUTH_INVALID_TOKEN(토큰 무효).
 * 스키마는 대표로 AUTH_UNAUTHORIZED 사용 — 응답 포맷 동일, code만 차이.
 * (모듈 방향 의존(common → modules/auth)은 jwt-auth.guard.ts와 동일 선례)
 */
export const ApiCommonUnauthorizedResponse = () =>
  applyDecorators(
    ApiResponse({
      status: 401,
      description:
        '인증 토큰이 없거나 유효하지 않습니다. (code: AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN)',
      type: AuthUnauthorizedErrorResponseDto,
    }),
  );

/**
 * 422 Validation Error — class-validator 실패
 *
 * @Body / @Query / @Param에 ValidationPipe가 적용된 모든 엔드포인트에서
 * 자동 발생 가능. 각 컨트롤러마다 명세하는 보일러플레이트를 줄임.
 */
export const ApiCommonValidationResponse = () =>
  applyDecorators(
    ApiResponse({
      status: 422,
      description: '요청 값 검증 실패',
      type: ApiValidationErrorResponseDto,
    }),
  );

/**
 * 429 Too Many Requests — 전역 ThrottlerGuard 발생 (D11)
 *
 * 응답 code는 HttpExceptionFilter의 statusCodeMap(429 → TOO_MANY_REQUESTS)이 결정.
 */
export const ApiThrottledResponse = (description = '요청 횟수 초과') =>
  applyDecorators(
    ApiResponse({
      status: 429,
      description,
      type: ApiTooManyRequestsErrorResponseDto,
    }),
  );

/**
 * 500 Internal Server Error — 예기치 못한 서버 오류
 *
 * 사실상 모든 엔드포인트에서 반복 명세되는 보일러플레이트를 줄임.
 */
export const ApiCommonInternalServerErrorResponse = (description = 'INTERNAL SERVER ERROR') =>
  applyDecorators(
    ApiResponse({
      status: 500,
      description,
      type: ApiInternalServerErrorResponseDto,
    }),
  );

import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import {
  ApiUnauthorizedErrorResponseDto,
  ApiValidationErrorResponseDto,
} from '../dto/api-error.dto';

/**
 * 401 Unauthorized — 인증 토큰 누락/무효
 *
 * JwtAuthGuard 적용된 모든 엔드포인트에서 반복 사용. NestJS 기본
 * `ApiUnauthorizedResponse`와 이름 구분을 위해 `Common` 접두사 사용.
 */
export const ApiCommonUnauthorizedResponse = () =>
  applyDecorators(
    ApiResponse({
      status: 401,
      description: '인증 토큰이 없거나 유효하지 않습니다.',
      type: ApiUnauthorizedErrorResponseDto,
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

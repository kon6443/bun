/**
 * Auth Module Error DTOs
 * Separated from auth.dto.ts to avoid circular dependency
 */
import { ApiProperty } from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../../common/dto/api-error.dto';

/**
 * 인증 실패 에러 (401)
 */
export class AuthUnauthorizedErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'AUTH_UNAUTHORIZED', enum: ['AUTH_UNAUTHORIZED'] })
  readonly code: string = 'AUTH_UNAUTHORIZED';

  constructor(message: string = '인증이 필요합니다.') {
    super(401, message, 'AUTH_UNAUTHORIZED');
  }
}

/**
 * 유효하지 않은 토큰 에러 (401)
 */
export class AuthInvalidTokenErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'AUTH_INVALID_TOKEN', enum: ['AUTH_INVALID_TOKEN'] })
  readonly code: string = 'AUTH_INVALID_TOKEN';

  constructor(message: string = '유효하지 않은 토큰입니다.') {
    super(401, message, 'AUTH_INVALID_TOKEN');
  }
}

/**
 * 카카오 API 오류 (502)
 */
export class AuthKakaoApiErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'AUTH_KAKAO_API_ERROR', enum: ['AUTH_KAKAO_API_ERROR'] })
  readonly code: string = 'AUTH_KAKAO_API_ERROR';

  constructor(message: string = '카카오 인증에 실패했습니다.') {
    super(502, message, 'AUTH_KAKAO_API_ERROR');
  }
}

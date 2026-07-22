import { defineDomainError } from './define-domain-error';

// 베이스 클래스는 api-error-base.dto.ts로 분리 (순환 import 방지).
// 기존 import 경로 호환을 위해 re-export.
export { ApiErrorResponseDto } from './api-error-base.dto';

// ==================== 공통 에러 DTO ====================

export const ApiValidationErrorResponseDto = defineDomainError({
  code: 'VALIDATION_ERROR',
  status: 422,
  message: '요청 값이 올바르지 않습니다.',
  name: 'ApiValidationErrorResponseDto',
});

export const ApiNotFoundErrorResponseDto = defineDomainError({
  code: 'NOT_FOUND',
  status: 404,
  message: '리소스를 찾을 수 없습니다.',
  name: 'ApiNotFoundErrorResponseDto',
});

export const ApiForbiddenErrorResponseDto = defineDomainError({
  code: 'FORBIDDEN',
  status: 403,
  message: '접근 권한이 없습니다.',
  name: 'ApiForbiddenErrorResponseDto',
});

// 참고: 공통 401 DTO는 제거됨 — 가드 401은 AuthUnauthorizedErrorResponseDto(AUTH_UNAUTHORIZED)가
// 실제 응답이며, ApiCommonUnauthorizedResponse 데코레이터가 이를 사용한다.
// code 'UNAUTHORIZED'는 필터의 statusCodeMap fallback(비도메인 401)에서만 생성된다.

export const ApiBadRequestErrorResponseDto = defineDomainError({
  code: 'BAD_REQUEST',
  status: 400,
  message: '잘못된 요청입니다.',
  name: 'ApiBadRequestErrorResponseDto',
});

export const ApiInternalServerErrorResponseDto = defineDomainError({
  code: 'INTERNAL_SERVER_ERROR',
  status: 500,
  message: '서버 내부 오류가 발생했습니다.',
  name: 'ApiInternalServerErrorResponseDto',
});

export const ApiBadGatewayErrorResponseDto = defineDomainError({
  code: 'BAD_GATEWAY',
  status: 502,
  message: '외부 서비스 오류가 발생했습니다.',
  name: 'ApiBadGatewayErrorResponseDto',
});

/**
 * 429 Too Many Requests — ThrottlerGuard 발생 (Swagger 명세용, 직접 throw 없음)
 * 실제 응답은 ThrottlerException을 HttpExceptionFilter가 이 포맷으로 변환
 */
export const ApiTooManyRequestsErrorResponseDto = defineDomainError({
  code: 'TOO_MANY_REQUESTS',
  status: 429,
  message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
  name: 'ApiTooManyRequestsErrorResponseDto',
});

/**
 * 팀을 찾을 수 없음 (404)
 *
 * 원래 team 모듈 소속이었으나 notification(telegram/discord) 서비스도
 * 사용하므로 순환 의존 회피를 위해 공통으로 승격 (D3 결정).
 * team 모듈에서는 team-error.dto.ts가 re-export.
 */
export const TeamNotFoundErrorResponseDto = defineDomainError({
  code: 'TEAM_NOT_FOUND',
  status: 404,
  message: '팀을 찾을 수 없습니다.',
});

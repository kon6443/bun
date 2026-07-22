/**
 * Auth Module Error DTOs
 * Separated from auth.dto.ts to avoid circular dependency
 *
 * defineDomainError 팩토리로 정의 — 클래스명은 code에서 자동 생성되며
 * 기존 수동 클래스와 동일 (예: AUTH_UNAUTHORIZED → AuthUnauthorizedErrorResponseDto)
 */
import { defineDomainError } from '../../common/dto/define-domain-error';

/** 인증 실패 에러 (401) */
export const AuthUnauthorizedErrorResponseDto = defineDomainError({
  code: 'AUTH_UNAUTHORIZED',
  status: 401,
  message: '인증이 필요합니다.',
});

/** 유효하지 않은 토큰 에러 (401) */
export const AuthInvalidTokenErrorResponseDto = defineDomainError({
  code: 'AUTH_INVALID_TOKEN',
  status: 401,
  message: '유효하지 않은 토큰입니다.',
});

/** 카카오 API 오류 (502) */
export const AuthKakaoApiErrorResponseDto = defineDomainError({
  code: 'AUTH_KAKAO_API_ERROR',
  status: 502,
  message: '카카오 인증에 실패했습니다.',
});

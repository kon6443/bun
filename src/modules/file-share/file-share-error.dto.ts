/**
 * File Share Module Error DTOs
 *
 * D1 결정: 인증 관련 에러는 단일 코드 FILE_SHARE_UNAUTHORIZED로 통합
 * (message만 차이 — 프론트 연동 계획 없음, 코드 분기 가치 없음)
 */
import { defineDomainError } from '../../common/dto/define-domain-error';

/** 인증 실패 (401) — shareId/apiKey 누락·불일치 통합 */
export const FileShareUnauthorizedErrorResponseDto = defineDomainError({
  code: 'FILE_SHARE_UNAUTHORIZED',
  status: 401,
  message: '인증이 필요합니다.',
});

/** 접근 거부 (403) — 경로 탐색 공격 차단 */
export const FileShareForbiddenErrorResponseDto = defineDomainError({
  code: 'FILE_SHARE_FORBIDDEN',
  status: 403,
  message: '접근이 거부되었습니다.',
});

/** 파일을 찾을 수 없음 (404) */
export const FileShareFileNotFoundErrorResponseDto = defineDomainError({
  code: 'FILE_SHARE_FILE_NOT_FOUND',
  status: 404,
  message: '파일을 찾을 수 없습니다.',
});

/** 파일 형식 오류 (400) — 디렉토리 등 파일이 아닌 대상 */
export const FileShareInvalidFileTypeErrorResponseDto = defineDomainError({
  code: 'FILE_SHARE_INVALID_FILE_TYPE',
  status: 400,
  message: '파일이 아닙니다.',
});

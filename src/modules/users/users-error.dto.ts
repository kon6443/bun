/**
 * Users Module Error DTOs
 */
import { defineDomainError } from '../../common/dto/define-domain-error';

/** 사용자를 찾을 수 없음 (404) */
export const UserNotFoundErrorResponseDto = defineDomainError({
  code: 'USER_NOT_FOUND',
  status: 404,
  message: '사용자를 찾을 수 없습니다.',
});

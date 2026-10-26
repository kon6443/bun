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

/** 카탈로그에 없는 스킨 아이템 (422) — details: { slot, id } */
export const UserSkinUnknownErrorResponseDto = defineDomainError({
  code: 'USER_SKIN_UNKNOWN',
  status: 422,
  message: '없는 스킨입니다.',
});

/** 아직 얻지 않은 스킨 아이템 (403) — details: { slot, id }. 업적·출석 아이템용(지금 카탈로그는 모두 무료) */
export const UserSkinNotOwnedErrorResponseDto = defineDomainError({
  code: 'USER_SKIN_NOT_OWNED',
  status: 403,
  message: '아직 얻지 않은 스킨입니다.',
});

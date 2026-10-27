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

/** 한 단계를 건너뛴 강화 (409) — details: { slot, id, level(현재 레벨) }. 다른 탭에서 이미 바뀐 상태 등 — 다시 불러와 고른다 */
export const UserSkinLevelMismatchErrorResponseDto = defineDomainError({
  code: 'USER_SKIN_LEVEL_MISMATCH',
  status: 409,
  message: '스킨 레벨이 바뀌었습니다. 다시 불러온 뒤 강화해 주세요.',
});

/** 강화할 포인트 부족 (409) — details: { balance, cost } */
export const UserPointsInsufficientErrorResponseDto = defineDomainError({
  code: 'USER_POINTS_INSUFFICIENT',
  status: 409,
  message: '포인트가 부족합니다.',
});

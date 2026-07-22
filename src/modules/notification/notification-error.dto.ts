/**
 * Notification Module Error DTOs
 * Separated from notification.dto.ts to avoid circular dependency
 *
 * defineDomainError 팩토리로 정의 — 클래스명은 code에서 자동 생성되며
 * 기존 수동 클래스와 동일
 */
import { defineDomainError } from '../../common/dto/define-domain-error';

/** 텔레그램 설정 오류 (500) */
export const NotificationTelegramConfigErrorResponseDto = defineDomainError({
  code: 'NOTIFICATION_TELEGRAM_CONFIG_ERROR',
  status: 500,
  message: '텔레그램 설정이 올바르지 않습니다.',
});

/** 텔레그램 API 오류 (502) */
export const NotificationTelegramApiErrorResponseDto = defineDomainError({
  code: 'NOTIFICATION_TELEGRAM_API_ERROR',
  status: 502,
  message: '텔레그램 서비스 오류가 발생했습니다.',
});

/** 텔레그램 연동 링크 유효하지 않음 (400) */
export const NotificationTelegramLinkInvalidErrorResponseDto = defineDomainError({
  code: 'NOTIFICATION_TELEGRAM_LINK_INVALID',
  status: 400,
  message: '유효하지 않은 텔레그램 연동 링크입니다.',
});

/** 텔레그램 이미 연동됨 (400) */
export const NotificationTelegramAlreadyLinkedErrorResponseDto = defineDomainError({
  code: 'NOTIFICATION_TELEGRAM_ALREADY_LINKED',
  status: 400,
  message: '이미 텔레그램이 연동되어 있습니다.',
});

/** 텔레그램 연동 해제 처리 오류 (500) */
export const NotificationTelegramUnlinkErrorResponseDto = defineDomainError({
  code: 'NOTIFICATION_TELEGRAM_UNLINK_ERROR',
  status: 500,
  message: '연동 해제 처리 중 오류가 발생했습니다.',
});

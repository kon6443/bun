/**
 * Notification Module Error DTOs
 * Separated from notification.dto.ts to avoid circular dependency
 */
import { ApiProperty } from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../../common/dto/api-error.dto';

/**
 * 텔레그램 설정 오류 (500)
 */
export class NotificationTelegramConfigErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'NOTIFICATION_TELEGRAM_CONFIG_ERROR', enum: ['NOTIFICATION_TELEGRAM_CONFIG_ERROR'] })
  readonly code: string = 'NOTIFICATION_TELEGRAM_CONFIG_ERROR';

  constructor(message: string = '텔레그램 설정이 올바르지 않습니다.') {
    super(500, message, 'NOTIFICATION_TELEGRAM_CONFIG_ERROR');
  }
}

/**
 * 텔레그램 API 오류 (502)
 */
export class NotificationTelegramApiErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'NOTIFICATION_TELEGRAM_API_ERROR', enum: ['NOTIFICATION_TELEGRAM_API_ERROR'] })
  readonly code: string = 'NOTIFICATION_TELEGRAM_API_ERROR';

  constructor(message: string = '텔레그램 서비스 오류가 발생했습니다.') {
    super(502, message, 'NOTIFICATION_TELEGRAM_API_ERROR');
  }
}

/**
 * 텔레그램 연동 링크 유효하지 않음 (400)
 */
export class NotificationTelegramLinkInvalidErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'NOTIFICATION_TELEGRAM_LINK_INVALID', enum: ['NOTIFICATION_TELEGRAM_LINK_INVALID'] })
  readonly code: string = 'NOTIFICATION_TELEGRAM_LINK_INVALID';

  constructor(message: string = '유효하지 않은 텔레그램 연동 링크입니다.') {
    super(400, message, 'NOTIFICATION_TELEGRAM_LINK_INVALID');
  }
}

/**
 * 텔레그램 이미 연동됨 (400)
 */
export class NotificationTelegramAlreadyLinkedErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'NOTIFICATION_TELEGRAM_ALREADY_LINKED', enum: ['NOTIFICATION_TELEGRAM_ALREADY_LINKED'] })
  readonly code: string = 'NOTIFICATION_TELEGRAM_ALREADY_LINKED';

  constructor(message: string = '이미 텔레그램이 연동되어 있습니다.') {
    super(400, message, 'NOTIFICATION_TELEGRAM_ALREADY_LINKED');
  }
}

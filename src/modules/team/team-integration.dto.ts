import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';

/** 팀 알림 연동(텔레그램·디스코드) 요청·응답 DTO — TeamIntegrationController */

// --- Telegram ---

export class TelegramLinkDataDto {
  @ApiProperty({ description: '연동 토큰', example: 'a1b2c3d4e5f6...' })
  token: string;

  @ApiProperty({ description: '텔레그램 딥링크 URL', example: 'https://t.me/YourBot?startgroup=a1b2c3d4e5f6...' })
  deepLink: string;

  @ApiProperty({ description: '토큰 만료 시간', example: '2024-12-31T23:59:59.000Z' })
  endAt: Date;
}

export class CreateTelegramLinkResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '연동 정보', type: TelegramLinkDataDto })
  data: TelegramLinkDataDto;
}

export class TelegramStatusDataDto {
  @ApiProperty({ description: '연동 여부', example: true })
  isLinked: boolean;

  @ApiProperty({
    description: '연동된 텔레그램 채팅 ID — MASTER·MANAGER에게만 포함',
    example: -1001234567890,
    nullable: true,
    required: false,
  })
  chatId?: number | null;

  @ApiProperty({
    description: '대기 중인 연동 정보 — MASTER·MANAGER에게만 포함',
    type: TelegramLinkDataDto,
    required: false,
  })
  pendingLink?: TelegramLinkDataDto;
}

export class TelegramStatusResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '연동 상태 정보', type: TelegramStatusDataDto })
  data: TelegramStatusDataDto;
}

export class DeleteTelegramLinkResponseDto extends ApiSuccessResponseDto {}

// --- Discord ---

export class SaveDiscordWebhookDto {
  @ApiProperty({ description: '디스코드 채널 Webhook URL', example: 'https://discord.com/api/webhooks/123456/abcdef...' })
  @IsString()
  @IsNotEmpty()
  webhookUrl: string;
}

export class DiscordStatusDataDto {
  @ApiProperty({ description: '연동 여부', example: true })
  isLinked: boolean;

  @ApiProperty({
    description: '등록된 Webhook URL — MASTER·MANAGER에게만 포함',
    example: 'https://discord.com/api/webhooks/...',
    nullable: true,
    required: false,
  })
  webhookUrl?: string | null;
}

export class DiscordStatusResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ description: '디스코드 연동 상태', type: DiscordStatusDataDto })
  data: DiscordStatusDataDto;
}

export class SaveDiscordWebhookResponseDto extends ApiSuccessResponseDto {}

export class DeleteDiscordWebhookResponseDto extends ApiSuccessResponseDto {}

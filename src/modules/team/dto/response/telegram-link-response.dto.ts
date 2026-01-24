import { ApiProperty } from '@nestjs/swagger';

export class TelegramLinkResponseDto {
  @ApiProperty({ description: '연동 토큰', example: 'a1b2c3d4e5f6...' })
  token: string;

  @ApiProperty({ description: '텔레그램 딥링크 URL', example: 'https://t.me/YourBot?startgroup=a1b2c3d4e5f6...' })
  deepLink: string;

  @ApiProperty({ description: '토큰 만료 시간', example: '2024-12-31T23:59:59.000Z' })
  endAt: Date;
}

export class CreateTelegramLinkResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;

  @ApiProperty({ description: '연동 정보', type: TelegramLinkResponseDto })
  data: TelegramLinkResponseDto;
}

export class TelegramStatusDataDto {
  @ApiProperty({ description: '연동 여부', example: true })
  isLinked: boolean;

  @ApiProperty({ description: '연동된 텔레그램 채팅 ID', example: -1001234567890, nullable: true })
  chatId: number | null;

  @ApiProperty({ description: '대기 중인 연동 정보', type: TelegramLinkResponseDto, required: false })
  pendingLink?: TelegramLinkResponseDto;
}

export class TelegramStatusResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;

  @ApiProperty({ description: '연동 상태 정보', type: TelegramStatusDataDto })
  data: TelegramStatusDataDto;
}

export class DeleteTelegramLinkResponseDto {
  @ApiProperty({ description: '응답 메시지', example: 'SUCCESS' })
  message: string;
}

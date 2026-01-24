import { ApiProperty } from '@nestjs/swagger';

export class TelegramChatDto {
  @ApiProperty({ description: '채팅 ID', example: -1001234567890 })
  id: number;

  @ApiProperty({ description: '채팅 제목 (그룹인 경우)', required: false })
  title?: string;

  @ApiProperty({ description: '채팅 유형', example: 'supergroup' })
  type: string;
}

export class TelegramUserDto {
  @ApiProperty({ description: '사용자 ID', example: 123456789 })
  id: number;

  @ApiProperty({ description: '이름', example: 'John' })
  first_name: string;

  @ApiProperty({ description: '사용자명', required: false })
  username?: string;
}

export class TelegramChatMemberDto {
  @ApiProperty({ description: '사용자 정보', type: TelegramUserDto })
  user: TelegramUserDto;

  @ApiProperty({ description: '멤버 상태', example: 'member' })
  status: string;
}

export class TelegramMyChatMemberDto {
  @ApiProperty({ description: '채팅 정보', type: TelegramChatDto })
  chat: TelegramChatDto;

  @ApiProperty({ description: '이벤트를 발생시킨 사용자', type: TelegramUserDto })
  from: TelegramUserDto;

  @ApiProperty({ description: '이벤트 발생 시간 (Unix timestamp)', example: 1704067200 })
  date: number;

  @ApiProperty({ description: '이전 멤버 상태', type: TelegramChatMemberDto })
  old_chat_member: TelegramChatMemberDto;

  @ApiProperty({ description: '새 멤버 상태', type: TelegramChatMemberDto })
  new_chat_member: TelegramChatMemberDto;
}

export class TelegramEntityDto {
  @ApiProperty({ description: '엔티티 유형', example: 'bot_command' })
  type: string;

  @ApiProperty({ description: '시작 오프셋', example: 0 })
  offset: number;

  @ApiProperty({ description: '길이', example: 6 })
  length: number;
}

export class TelegramMessageDto {
  @ApiProperty({ description: '채팅 정보', type: TelegramChatDto })
  chat: TelegramChatDto;

  @ApiProperty({ description: '메시지 텍스트', required: false })
  text?: string;

  @ApiProperty({ description: '메시지 엔티티', type: [TelegramEntityDto], required: false })
  entities?: TelegramEntityDto[];
}

export class TelegramWebhookDto {
  @ApiProperty({ description: '업데이트 ID', example: 123456789 })
  update_id: number;

  @ApiProperty({ description: '봇 멤버 상태 변경 이벤트', type: TelegramMyChatMemberDto, required: false })
  my_chat_member?: TelegramMyChatMemberDto;

  @ApiProperty({ description: '메시지 이벤트', type: TelegramMessageDto, required: false })
  message?: TelegramMessageDto;
}

export class TelegramWebhookResponseDto {
  @ApiProperty({ description: '처리 성공 여부', example: true })
  success: boolean;

  @ApiProperty({ description: '응답 메시지', example: '연동이 완료되었습니다.' })
  message: string;
}

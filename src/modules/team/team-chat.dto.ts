/**
 * 팀 채팅 REST DTO — 계약: docs/tasks/team-chat-persistence/DESIGN.md §7
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsPositive, Max, Min } from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';
import { CHAT_HISTORY_DEFAULT_LIMIT, CHAT_HISTORY_MAX_LIMIT } from '../../common/constants/chat.constants';

// --- 이력 조회 ---

/** 이력 조회 조건 — beforeId·afterId는 미포함(exclusive)이고 둘 중 하나만 쓴다 */
export class GetChatMessagesQueryDto {
  @ApiPropertyOptional({ description: '이 ID보다 이전 메시지 (미포함). afterId와 동시 사용 불가', example: 101 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  beforeId?: number;

  @ApiPropertyOptional({ description: '이 ID보다 이후 메시지 (미포함, 재연결 시 빈 구간 채우기). beforeId와 동시 사용 불가', example: 120 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  afterId?: number;

  @ApiPropertyOptional({
    description: `조회 개수 (기본 ${CHAT_HISTORY_DEFAULT_LIMIT}, 최대 ${CHAT_HISTORY_MAX_LIMIT})`,
    example: CHAT_HISTORY_DEFAULT_LIMIT,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CHAT_HISTORY_MAX_LIMIT)
  limit?: number;
}

/** 메시지 항목 — 소켓 chatReceived 페이로드와 같은 형태 */
export class ChatMessageItemDto {
  @ApiProperty({ description: '메시지 ID (팀 안에서 단조 증가, 읽음 커서의 기준값)', example: 101 })
  messageId: number;

  @ApiProperty({ description: '보낸 클라이언트가 생성한 ID', example: '3f1c2b9e-0a4d-4f7e-9a1b-2c3d4e5f6a7b' })
  clientMsgId: string;

  @ApiProperty({ description: '팀 ID', example: 1 })
  teamId: number;

  @ApiProperty({ description: '보낸 사용자 ID', example: 1 })
  userId: number;

  @ApiProperty({ description: '보낸 사용자 표시 이름', example: '홍길동' })
  userName: string;

  @ApiProperty({ description: '메시지 본문', example: '회의 3시에 합니다.' })
  message: string;

  @ApiProperty({ description: '전송 시각 (ISO, UTC)', example: '2026-10-14T06:00:00.000Z' })
  timestamp: string;
}

export class ChatMessagesDto {
  @ApiProperty({ description: '메시지 목록 (오래된 것부터)', type: [ChatMessageItemDto] })
  messages: ChatMessageItemDto[];

  @ApiProperty({ description: '요청 방향(beforeId·기본 = 과거, afterId = 최신)에 메시지가 더 있는지', example: true })
  hasMore: boolean;
}

export class ChatMessagesResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: ChatMessagesDto })
  data: ChatMessagesDto;
}

// --- 읽음 상태 ---

export class ChatMemberReadStateDto {
  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId: number;

  @ApiProperty({ description: '표시 이름', example: '홍길동' })
  userName: string;

  @ApiProperty({ description: '마지막으로 읽은 메시지 ID (0 = 아무것도 안 읽음)', example: 104 })
  lastReadMessageId: number;
}

export class ChatReadStateDto {
  @ApiProperty({ description: '팀 최신 메시지 ID (메시지가 없으면 0)', example: 104 })
  latestMessageId: number;

  @ApiProperty({ description: '내가 마지막으로 읽은 메시지 ID', example: 102 })
  myLastReadMessageId: number;

  @ApiProperty({ description: '내 안읽음 수 (남이 보낸 메시지만)', example: 2 })
  myUnreadCount: number;

  @ApiProperty({ description: '활성 멤버별 읽음 위치 (본인 포함)', type: [ChatMemberReadStateDto] })
  members: ChatMemberReadStateDto[];
}

export class ChatReadStateResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: ChatReadStateDto })
  data: ChatReadStateDto;
}

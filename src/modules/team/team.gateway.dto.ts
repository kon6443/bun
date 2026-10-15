import { IsByteLength, IsInt, IsNotEmpty, IsNumber, IsPositive, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { CHAT_MESSAGE_MAX_BYTES, CHAT_MESSAGE_MAX_LENGTH } from '../../common/constants/chat.constants';

/**
 * 팀 room 참가 요청 DTO
 *
 * NestJS 정석: class-validator 데코레이터로 WebSocket 메시지 검증
 */
export class JoinTeamDto {
  @IsNumber({}, { message: 'teamId는 숫자여야 합니다.' })
  @IsPositive({ message: 'teamId는 양수여야 합니다.' })
  teamId: number;
}

/**
 * 팀 room 퇴장 요청 DTO
 */
export class LeaveTeamDto {
  @IsNumber({}, { message: 'teamId는 숫자여야 합니다.' })
  @IsPositive({ message: 'teamId는 양수여야 합니다.' })
  teamId: number;
}

/**
 * 채팅 메시지 전송 DTO
 *
 * teamId는 받지 않는다 — 서버가 소켓에 캐싱된 teamId로 room을 식별한다.
 */
export class ChatMessageDto {
  // 앞뒤 공백 제거 후 검증 → 공백-only 메시지 차단 (boundary 검증 1회)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'message는 문자열이어야 합니다.' })
  @IsNotEmpty({ message: 'message는 비어있을 수 없습니다.' })
  @MaxLength(CHAT_MESSAGE_MAX_LENGTH, { message: `message는 ${CHAT_MESSAGE_MAX_LENGTH}자를 초과할 수 없습니다.` })
  // 글자 수로는 이모지 변형 선택자(U+FE0F)를 0자로 센다 — 페이로드 크기는 바이트로 따로 막는다
  @IsByteLength(1, CHAT_MESSAGE_MAX_BYTES, { message: 'message가 너무 깁니다.' })
  message: string;

  @IsString({ message: 'clientMsgId는 문자열이어야 합니다.' })
  @IsNotEmpty({ message: 'clientMsgId는 비어있을 수 없습니다.' })
  // 컬럼이 VARCHAR2(64 BYTE)라 글자 수가 아니라 바이트로 막는다 — 다바이트 문자가 섞이면 저장 단계 ORA-12899
  @IsByteLength(1, 64, { message: 'clientMsgId는 64바이트를 초과할 수 없습니다.' })
  clientMsgId: string;
}

/**
 * 채팅 읽음 위치 갱신 DTO — 이 ID 이하의 메시지를 모두 읽었다
 */
export class ChatReadDto {
  @IsInt({ message: 'lastReadMessageId는 정수여야 합니다.' })
  @IsPositive({ message: 'lastReadMessageId는 양수여야 합니다.' })
  lastReadMessageId: number;
}

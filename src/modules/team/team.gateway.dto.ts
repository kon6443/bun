import { IsNotEmpty, IsNumber, IsPositive, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

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
  @MaxLength(200, { message: 'message는 200자를 초과할 수 없습니다.' })
  message: string;

  @IsString({ message: 'clientMsgId는 문자열이어야 합니다.' })
  @IsNotEmpty({ message: 'clientMsgId는 비어있을 수 없습니다.' })
  @MaxLength(64, { message: 'clientMsgId는 64자를 초과할 수 없습니다.' })
  clientMsgId: string;
}

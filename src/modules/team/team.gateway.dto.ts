import { IsNumber, IsPositive } from 'class-validator';

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

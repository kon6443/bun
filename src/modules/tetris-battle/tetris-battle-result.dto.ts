import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDefined, IsIn, IsInt, IsObject, IsString, Matches, Max, Min, ValidateNested } from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';
import { BATTLE_ENGINE_VERSION, MAX_BATTLE_FRAMES, MAX_GARBAGE_EVENTS } from './battle-engine';
import { MAX_INPUT_LENGTH, SEED_MAX } from './battle-engine/engine';

// ==================== Request ====================

/** 대전 리플레이 (DESIGN §15) — 범위·재현 가능 여부는 simulateBattleReplay가 최종 판정 */
export class BattleReplayDto {
  @ApiProperty({ description: `대전 래퍼 버전 — 현재 ${BATTLE_ENGINE_VERSION}만 받는다`, example: BATTLE_ENGINE_VERSION })
  // 다른 버전은 형식 오류(422)로 거절한다(리뷰 L1): 서버가 그 버전 래퍼를 갖고 있지 않아 검증 자체가 불가능하고
  // (INVALID로 저장하면 엉뚱한 값이 NUMBER(5)를 넘어 저장이 영구 실패할 수 있었다), 클라이언트 업데이트가 필요한 상황이다
  @IsIn([BATTLE_ENGINE_VERSION])
  battleEngineVersion: number;

  @ApiProperty({ description: '매치 seed (matchStarting으로 받은 값)', example: 12345 })
  @IsInt()
  @Min(0)
  @Max(SEED_MAX)
  seed: number;

  @ApiProperty({ description: 'DAS (프레임)', example: 10 })
  @IsInt()
  das: number;

  @ApiProperty({ description: 'ARR (프레임)', example: 2 })
  @IsInt()
  arr: number;

  @ApiProperty({ description: `진행 프레임 (탈락이면 탈락 프레임, 1~${MAX_BATTLE_FRAMES})`, example: 3600 })
  @IsInt()
  @Min(1)
  @Max(MAX_BATTLE_FRAMES)
  frames: number;

  @ApiProperty({ description: `입력 로그 [deltaFrame, actionCode, ...] (길이 ${MAX_INPUT_LENGTH} 이하)`, type: [Number] })
  @IsArray()
  @ArrayMaxSize(MAX_INPUT_LENGTH)
  @IsInt({ each: true })
  inputs: number[];

  @ApiProperty({ description: `받은 가비지 [deltaFrame, id, lines, hole, ...] (이벤트 ${MAX_GARBAGE_EVENTS}개 이하)`, type: [Number] })
  @IsArray()
  @ArrayMaxSize(MAX_GARBAGE_EVENTS * 4)
  @IsInt({ each: true })
  garbage: number[];
}

export class SubmitBattleReplayDto {
  @ApiProperty({ description: '방 입장 때 받은 재연결 토큰 (base64url 32자)', example: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{32}$/)
  playerToken: string;

  @ApiProperty({ type: BattleReplayDto })
  // 값이 없으면 ValidateNested가 검증을 건너뛴다 — 형식 오류로 막는다
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => BattleReplayDto)
  replay: BattleReplayDto;
}

// ==================== Response ====================

export class BattleReplaySubmittedDto {
  @ApiProperty({ enum: ['VERIFIED', 'INVALID'], description: '이 리플레이의 검증 결과 (INVALID여도 201 — 재시도 무의미)' })
  verdict: 'VERIFIED' | 'INVALID';
}

export class BattleReplaySubmittedResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: BattleReplaySubmittedDto }) data: BattleReplaySubmittedDto;
}

export class BattleMatchPlayerDto {
  @ApiProperty({ example: 'p1' }) playerId: string;
  @ApiProperty({ example: '테트리스왕' }) name: string;
  @ApiProperty({ example: 1 }) place: number;
  @ApiProperty({ example: 2 }) kos: number;
  @ApiProperty({ example: 18 }) sent: number;
  @ApiProperty({ example: 7 }) received: number;
  @ApiProperty({ example: 64 }) pieces: number;
  @ApiProperty({ example: 4 }) maxCombo: number;
  @ApiProperty({ example: 5400 }) frames: number;
  @ApiPropertyOptional({ enum: ['topout', 'disconnect', 'leave'], nullable: true }) koReason: 'topout' | 'disconnect' | 'leave' | null;
  @ApiProperty({ enum: ['VERIFIED', 'MISSING'], description: '경기가 VERIFIED라 INVALID 참가자는 없다. 재생은 VERIFIED만' })
  verdict: 'VERIFIED' | 'MISSING';
}

export class BattleMatchDto {
  @ApiProperty({ example: 'AbCdEfGhIjKlMnOp' }) matchId: string;
  @ApiProperty({ example: '한판 해요' }) roomName: string;
  @ApiProperty({ example: 3 }) playerCount: number;
  @ApiProperty({ description: '경기 시작 (UTC ISO)' }) startedAt: Date;
  @ApiProperty({ description: '경기 종료 (UTC ISO)' }) endedAt: Date;
  @ApiProperty({ type: [BattleMatchPlayerDto], description: '순위 오름차순' }) players: BattleMatchPlayerDto[];
}

export class BattleMatchResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: BattleMatchDto }) data: BattleMatchDto;
}

export class BattleReplayDetailDto {
  @ApiProperty() matchId: string;
  @ApiProperty() playerId: string;
  @ApiProperty() battleEngineVersion: number;
  @ApiProperty() seed: number;
  @ApiProperty() das: number;
  @ApiProperty() arr: number;
  @ApiProperty() frames: number;
  @ApiProperty({ type: [Number] }) inputs: number[];
  @ApiProperty({ type: [Number] }) garbage: number[];
}

export class BattleReplayDetailResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: BattleReplayDetailDto }) data: BattleReplayDetailDto;
}

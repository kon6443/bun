import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';
import { BATTLE_ENGINE_VERSION, MAX_BATTLE_FRAMES, MAX_GARBAGE_EVENTS } from './battle-engine';
import { ARR_MAX, ARR_MIN, DAS_MAX, DAS_MIN, MAX_INPUT_LENGTH, SEED_MAX } from './battle-engine/engine';
import { MATCH_LIST_DEFAULT_LIMIT, MATCH_LIST_MAX_LIMIT } from './tetris-battle.constants';

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

  // 범위 밖이면 422 — 엔진이 INVALID_HEADER로 INVALID를 저장하게 두지 않는다(tetris-audit BE-12)
  @ApiProperty({ description: `DAS (프레임, ${DAS_MIN}~${DAS_MAX})`, example: 10 })
  @IsInt()
  @Min(DAS_MIN)
  @Max(DAS_MAX)
  das: number;

  @ApiProperty({ description: `ARR (프레임, ${ARR_MIN}~${ARR_MAX})`, example: 2 })
  @IsInt()
  @Min(ARR_MIN)
  @Max(ARR_MAX)
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
  @ApiProperty({
    enum: ['VERIFIED', 'MISSING', 'INVALID'],
    description: '리플레이 판정 — 재생은 VERIFIED만. INVALID(검증 실패)여도 순위·통계는 서버 기록 그대로다',
  })
  verdict: 'VERIFIED' | 'MISSING' | 'INVALID';
}

export class BattleMatchDto {
  @ApiProperty({ example: 'AbCdEfGhIjKlMnOp' }) matchId: string;
  @ApiProperty({ example: '한판 해요' }) roomName: string;
  @ApiProperty({ example: 3 }) playerCount: number;
  @ApiProperty({ description: '경기 시작 (UTC ISO)' }) startedAt: Date;
  @ApiProperty({ description: '경기 종료 (UTC ISO)' }) endedAt: Date;
  @ApiProperty({ description: '검증 실패(INVALID) 참가자가 있는 경기' }) disputed: boolean;
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

// ==================== 대전 입구 (D-025) ====================

export class ListBattleMatchesQueryDto {
  @ApiPropertyOptional({ description: `개수 (1~${MATCH_LIST_MAX_LIMIT}, 기본 ${MATCH_LIST_DEFAULT_LIMIT})`, example: MATCH_LIST_DEFAULT_LIMIT })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MATCH_LIST_MAX_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ description: '직전 응답의 nextCursor (불투명 문자열 — 그대로 전달). 없으면 첫 페이지' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

export class BattleLobbyDto {
  @ApiProperty({ description: '입장 가능한 대기 중 방 수', example: 3 }) waitingRooms: number;
  @ApiProperty({ description: '경기 중·결과 화면인 방 수(입장 불가)', example: 1 }) playingRooms: number;
}

export class BattleLobbyResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: BattleLobbyDto }) data: BattleLobbyDto;
}

export class BattleMatchListPlayerDto {
  @ApiProperty({ example: '테트리스왕' }) name: string;
  @ApiProperty({ example: 1 }) place: number;
}

export class BattleMatchListItemDto {
  @ApiProperty({ example: 'AbCdEfGhIjKlMnOp' }) matchId: string;
  @ApiProperty({ example: '한판 해요' }) roomName: string;
  @ApiProperty({ example: 3 }) playerCount: number;
  @ApiProperty({ description: '경기 종료 (UTC ISO)' }) endedAt: Date;
  @ApiProperty({ description: '검증 실패(INVALID) 참가자가 있는 경기' }) disputed: boolean;
  @ApiProperty({ description: '1위 이름 — 항상 문자열(1위가 없는 경기는 목록에 나오지 않는다)', example: '테트리스왕' }) winnerName: string;
  @ApiProperty({ type: [BattleMatchListPlayerDto], description: '순위 오름차순' }) players: BattleMatchListPlayerDto[];
}

export class BattleMatchListDto {
  @ApiProperty({ type: [BattleMatchListItemDto], description: '최근 저장 순(CRTD_AT DESC, MATCH_ID DESC)' }) items: BattleMatchListItemDto[];
  @ApiPropertyOptional({ description: '다음 페이지 커서 — 없으면 null(마지막 페이지)', nullable: true }) nextCursor: string | null;
}

export class BattleMatchListResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: BattleMatchListDto }) data: BattleMatchListDto;
}

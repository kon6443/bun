import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';
import type { Action, MatchConfig } from './engine';
import { MATCH_LIST_DEFAULT_LIMIT, MATCH_LIST_MAX_LIMIT } from './fortress.constants';
import { FortressTankSkinDto } from './fortress-skin.dto';

/**
 * 포트리스 결과·리플레이 REST DTO (docs/tasks/fortress DESIGN §12). 응답 DTO는 Swagger 명세용 타입이다(api-http.md).
 * 시각은 UTC ISO. userId는 싣지 않는다.
 */

// ==================== Request ====================

export class ListFortressMatchesQueryDto {
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

// ==================== Response ====================

export class FortressMatchResultDto {
  @ApiProperty({ enum: ['win', 'draw'], description: '승리(개인·팀) · 무승부' }) kind: 'win' | 'draw';
  @ApiProperty({ type: Number, nullable: true, enum: [0, 1], description: 'team 모드 승리 팀. ffa·무승부는 null' }) team: 0 | 1 | null;
}

export class FortressMatchPlayerDto {
  @ApiProperty({ example: 'p1' }) playerId: string;
  @ApiProperty({ example: '포병대장' }) name: string;
  @ApiProperty({ description: '엔진 slot (0~3, 입장 순서)', example: 0 }) slot: number;
  @ApiProperty({ type: Number, nullable: true, enum: [0, 1], description: 'team 모드 팀, ffa는 null' }) team: 0 | 1 | null;
  @ApiProperty({ description: '탱크 종류 (엔진 TANKS 인덱스)', example: 1 }) tankId: number;
  @ApiProperty({ description: '종료 시 남은 HP', example: 42 }) hp: number;
  @ApiProperty({ description: '자기 턴 발사로 다른 팀에게 깎은 HP 합', example: 180 }) damage: number;
  @ApiProperty({ description: '자기 턴 발사로 다른 팀 탱크를 죽인 수', example: 1 }) kos: number;
  @ApiProperty({ description: '순위 (같은 값은 같은 순위 — 1, 1, 3)', example: 1 }) place: number;
}

export class FortressMatchDto {
  @ApiProperty({ example: 'AbCdEfGhIjKlMnOp' }) matchId: string;
  @ApiProperty({ type: String, nullable: true, example: '한판 해요', description: '방 이름 (모르면 null)' }) roomName: string | null;
  @ApiProperty({ enum: ['ffa', 'team'] }) mode: 'ffa' | 'team';
  @ApiProperty({ example: 'hills' }) mapId: string;
  @ApiProperty({ example: 12345 }) seed: number;
  @ApiProperty({ description: '경기를 돌린 엔진 버전', example: 1 }) engineVersion: number;
  @ApiProperty({ example: 2 }) playerCount: number;
  @ApiProperty({ description: '끝난 턴 수', example: 14 }) turns: number;
  @ApiProperty({ type: FortressMatchResultDto }) result: FortressMatchResultDto;
  @ApiProperty({ description: '경기 시작 (UTC ISO)' }) startedAt: Date;
  @ApiProperty({ description: '경기 종료 (UTC ISO)' }) endedAt: Date;
  @ApiProperty({ type: [FortressMatchPlayerDto], description: '순위 오름차순, 같으면 slot 순' }) players: FortressMatchPlayerDto[];
}

export class FortressMatchResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: FortressMatchDto }) data: FortressMatchDto;
}

export class FortressMatchSlotDto {
  @ApiProperty({ example: 0 }) slot: number;
  @ApiProperty({ example: 'p1' }) playerId: string;
  @ApiProperty({ example: '포병대장' }) name: string;
  @ApiProperty({ type: FortressTankSkinDto, description: '경기 시작 때 고정한 탱크 스킨 (F7 전에 저장된 리플레이는 default Lv1)' }) skin: FortressTankSkinDto;
}

export class FortressReplayDto {
  @ApiProperty({ description: '경기 ID = 리플레이 id', example: 'AbCdEfGhIjKlMnOp' }) matchId: string;
  @ApiProperty({ description: '엔진 버전 — 클라이언트 ENGINE_VERSION과 다르면 재생 불가 안내', example: 1 }) engineVersion: number;
  @ApiProperty({
    description: '엔진 MatchConfig 그대로 — createMatch(config)',
    example: { seed: 12345, mapId: 'hills', mode: 'ffa', players: [{ slot: 0, team: 0, tankId: 0 }, { slot: 1, team: 0, tankId: 1 }] },
  })
  config: MatchConfig;
  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description: '엔진 Action 목록(fire·skip·resign) 그대로 — simulateMatch(config, actions)',
    example: [{ kind: 'fire', move: 0, angle: 45, power: 60, weaponId: 0 }, { kind: 'skip' }],
  })
  actions: Action[];
  @ApiProperty({ type: [FortressMatchSlotDto], description: 'slot별 참가자 이름·경기 시작 때 고정한 탱크 스킨' }) slots: FortressMatchSlotDto[];
  @ApiProperty({ description: '마지막 행동 적용 후 stateHash (재생 결과 대조용)', example: '1a2b3c4d' }) stateHash: string;
}

export class FortressReplayResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: FortressReplayDto }) data: FortressReplayDto;
}

export class FortressMatchListPlayerDto {
  @ApiProperty({ example: '포병대장' }) name: string;
  @ApiProperty({ example: 0 }) slot: number;
  @ApiProperty({ type: Number, nullable: true, enum: [0, 1] }) team: 0 | 1 | null;
  @ApiProperty({ example: 1 }) place: number;
}

export class FortressMatchListItemDto {
  @ApiProperty({ example: 'AbCdEfGhIjKlMnOp' }) matchId: string;
  @ApiProperty({ type: String, nullable: true, example: '한판 해요' }) roomName: string | null;
  @ApiProperty({ enum: ['ffa', 'team'] }) mode: 'ffa' | 'team';
  @ApiProperty({ example: 'hills' }) mapId: string;
  @ApiProperty({ example: 2 }) playerCount: number;
  @ApiProperty({ example: 14 }) turns: number;
  @ApiProperty({ type: FortressMatchResultDto }) result: FortressMatchResultDto;
  @ApiProperty({ description: '경기 종료 (UTC ISO)' }) endedAt: Date;
  @ApiProperty({ type: [FortressMatchListPlayerDto], description: '순위 오름차순, 같으면 slot 순' }) players: FortressMatchListPlayerDto[];
}

export class FortressMatchListDto {
  @ApiProperty({ type: [FortressMatchListItemDto], description: '최근 저장 순(CRTD_AT DESC, MATCH_ID DESC)' }) items: FortressMatchListItemDto[];
  @ApiPropertyOptional({ type: String, description: '다음 페이지 커서 — 없으면 null(마지막 페이지)', nullable: true }) nextCursor: string | null;
}

export class FortressMatchListResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: FortressMatchListDto }) data: FortressMatchListDto;
}

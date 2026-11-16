import { IsString, IsNotEmpty, IsNumber, IsIn, IsOptional, MaxLength, Min, Max } from 'class-validator';

/**
 * 입력 상한 — 프론트 정상 최대값(docs/tasks/refactor-perf-survey-2026-11 WORKLOG Q3)에 여유를 둔 값.
 * 낚시 결과·상태는 같은 맵 전원에게 그대로 중계되므로 길이·크기에 상한이 없으면 한 소켓이 큰 문자열을 뿌릴 수 있다.
 */
/** 맵 id — 현재 맵은 하나, 형식 제한 없이 길이만 */
const MAP_ID_MAX_LENGTH = 64;
/** 낚시 포인트 id — 프론트 'point-1'~'point-5' (최대 7자) */
const POINT_ID_MAX_LENGTH = 32;
/** 물고기 이름 — 프론트 최장 5자('무지개송어') */
const FISH_NAME_MAX_LENGTH = 20;
/** 크기(cm) — 프론트 최대 200 */
const FISH_SIZE_MAX = 1_000;
/** 무게(g) — 프론트 최대 30000 */
const FISH_WEIGHT_MAX = 100_000;

export class JoinMapDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAP_ID_MAX_LENGTH)
  mapId: string;
}

export class LeaveMapDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAP_ID_MAX_LENGTH)
  mapId: string;
}

export class MoveDto {
  @IsNumber()
  @Min(0)
  @Max(2000)
  x: number;

  @IsNumber()
  @Min(0)
  @Max(2000)
  y: number;

  @IsString()
  @IsIn(['left', 'right'])
  direction: 'left' | 'right';
}

export class FishingStateDto {
  @IsString()
  @IsIn(['idle', 'casting', 'waiting', 'bite', 'challenge', 'success', 'fail'])
  state: 'idle' | 'casting' | 'waiting' | 'bite' | 'challenge' | 'success' | 'fail';

  @IsString()
  @IsOptional()
  @MaxLength(POINT_ID_MAX_LENGTH)
  pointId?: string;
}

export class ChatMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  message: string;
}

export class CatchResultDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(FISH_NAME_MAX_LENGTH)
  fishName: string;

  @IsString()
  @IsIn(['common', 'uncommon', 'rare', 'epic', 'legendary'])
  grade: string;

  @IsNumber()
  @Min(0)
  @Max(FISH_SIZE_MAX)
  size: number;

  @IsNumber()
  @Min(0)
  @Max(FISH_WEIGHT_MAX)
  weight: number;
}

import { IsString, IsNotEmpty, IsNumber, IsIn, IsOptional, MaxLength, Min, Max } from 'class-validator';

export class JoinMapDto {
  @IsString()
  @IsNotEmpty()
  mapId: string;
}

export class LeaveMapDto {
  @IsString()
  @IsNotEmpty()
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
  fishName: string;

  @IsString()
  @IsIn(['common', 'uncommon', 'rare', 'epic', 'legendary'])
  grade: string;

  @IsNumber()
  @Min(0)
  size: number;

  @IsNumber()
  @Min(0)
  weight: number;
}

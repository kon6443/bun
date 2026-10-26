import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, Length, IsOptional } from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';

// ==================== Request DTOs ====================

export class UpdateUserDto {
  @ApiProperty({
    description: '사용자 닉네임',
    example: '홍길동',
    minLength: 1,
    maxLength: 20,
  })
  @IsString({ message: '닉네임은 문자열이어야 합니다.' })
  @IsNotEmpty({ message: '닉네임은 필수 입력 항목입니다.' })
  @Length(1, 20, { message: '닉네임은 1자 이상 20자 이하여야 합니다.' })
  userName: string;
}

/** 슬롯 일부만 바꾼다 — 보낸 슬롯만 장착. 아이템 id 검사(카탈로그·보유)는 서비스가 한다 (docs/tasks/tetris-skins D-003) */
export class UpdateUserSkinsDto {
  @ApiPropertyOptional({ description: '블록 스킨 id', example: 'gameboy' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  block?: string;

  @ApiPropertyOptional({ description: '이펙트 스킨 id', example: 'neon' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  effect?: string;

  @ApiPropertyOptional({ description: '판 배경 스킨 id', example: 'default' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  board?: string;

  @ApiPropertyOptional({ description: '화면 배경 스킨 id', example: 'high-contrast' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  background?: string;
}

// ==================== Response DTOs ====================

export class UserProfileDataDto {
  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId: number;

  @ApiProperty({ description: '사용자 닉네임', example: '홍길동' })
  userName: string;

  @ApiProperty({ description: '카카오 이메일', example: 'user@kakao.com', nullable: true })
  kakaoEmail: string | null;

  @ApiProperty({ description: '가입일', example: '2024-01-15T09:30:00.000Z' })
  createdDate: string;
}

export class UserProfileResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: UserProfileDataDto })
  data: UserProfileDataDto;
}

export class UpdateUserDataDto {
  @ApiProperty({ description: '사용자 ID', example: 1 })
  userId: number;

  @ApiProperty({ description: '사용자 닉네임', example: '홍길동' })
  userName: string;
}

export class UpdateUserResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: UpdateUserDataDto })
  data: UpdateUserDataDto;
}

export class TetrisSkinSetDto {
  @ApiProperty({ description: '블록 스킨 id', example: 'default' }) block: string;
  @ApiProperty({ description: '이펙트 스킨 id', example: 'default' }) effect: string;
  @ApiProperty({ description: '판 배경 스킨 id', example: 'default' }) board: string;
  @ApiProperty({ description: '화면 배경 스킨 id', example: 'default' }) background: string;
}

export class SkinCatalogEntryDto {
  @ApiProperty({ description: '아이템 id', example: 'gameboy' }) id: string;
  @ApiProperty({ description: '획득 방식 — default(기본)·free(누구나). 업적·출석은 이후 추가', example: 'free' }) unlock: string;
  @ApiProperty({ description: '이 사용자가 장착할 수 있는지', example: true }) owned: boolean;
}

export class SkinCatalogDto {
  @ApiProperty({ type: [SkinCatalogEntryDto] }) block: SkinCatalogEntryDto[];
  @ApiProperty({ type: [SkinCatalogEntryDto] }) effect: SkinCatalogEntryDto[];
  @ApiProperty({ type: [SkinCatalogEntryDto] }) board: SkinCatalogEntryDto[];
  @ApiProperty({ type: [SkinCatalogEntryDto] }) background: SkinCatalogEntryDto[];
}

export class UserSkinsDataDto {
  @ApiProperty({ type: TetrisSkinSetDto, description: '슬롯별 장착 아이템 — 장착하지 않은 슬롯은 default' }) equipped: TetrisSkinSetDto;
  @ApiProperty({ type: SkinCatalogDto, description: '슬롯별 아이템 목록(서버 카탈로그 순서)과 보유 여부' }) catalog: SkinCatalogDto;
}

export class UserSkinsResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: UserSkinsDataDto })
  data: UserSkinsDataDto;
}

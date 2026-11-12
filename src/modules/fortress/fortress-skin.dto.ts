import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Length, Max, Min } from 'class-validator';
import { ApiSuccessResponseDto } from '../../common/dto/api-response.dto';
import { SKIN_MAX_LEVEL, SKIN_MIN_LEVEL } from '../users/skin-catalog';

/**
 * 포트리스 탱크 스킨·경기 포인트 REST DTO (docs/tasks/fortress DESIGN §13). 응답 DTO는 Swagger 명세용 타입이다(api-http.md)
 */

// ==================== Request ====================

export class EquipFortressSkinDto {
  @ApiProperty({ description: '탱크 스킨 아이템 id', example: 'desert' })
  @IsString()
  @Length(1, 64)
  skinId: string;
}

export class UpgradeFortressSkinDto {
  @ApiProperty({ description: '탱크 스킨 아이템 id', example: 'desert' })
  @IsString()
  @Length(1, 64)
  skinId: string;

  @ApiProperty({ description: `목표 레벨 (${SKIN_MIN_LEVEL + 1}~${SKIN_MAX_LEVEL}) — 이미 그 레벨 이상이면 차감 없이 지금 상태`, example: 2 })
  @IsInt()
  @Min(SKIN_MIN_LEVEL + 1)
  @Max(SKIN_MAX_LEVEL)
  level: number;
}

// ==================== Response ====================

export class FortressTankSkinDto {
  @ApiProperty({ description: '아이템 id — 프론트는 모르는 id를 default로 그린다', example: 'desert' }) id: string;
  @ApiProperty({ description: '레벨 1~5', example: 2 }) level: number;
}

export class FortressSkinPointsDto {
  @ApiProperty({ description: '적립 합계', example: 120000 }) earned: number;
  @ApiProperty({ description: '소비 합계(양수)', example: 100000 }) spent: number;
  @ApiProperty({ description: '쓸 수 있는 포인트', example: 20000 }) balance: number;
}

export class FortressSkinItemDto {
  @ApiProperty({ example: 'desert' }) id: string;
  @ApiProperty({ enum: ['default', 'free'], description: '획득 방식' }) unlock: 'default' | 'free';
  @ApiProperty() owned: boolean;
  @ApiProperty() equipped: boolean;
  @ApiProperty({ description: '내 레벨 1~5', example: 1 }) level: number;
  @ApiProperty({ type: Number, nullable: true, description: '한 단계 올리는 비용 — 만렙이면 null', example: 100000 }) nextCost: number | null;
}

export class FortressSkinsDto {
  @ApiProperty({ type: FortressTankSkinDto, description: '장착 중인 탱크 스킨과 그 레벨 — 대기실·경기·리플레이에서 남에게도 보인다' })
  equipped: FortressTankSkinDto;
  @ApiProperty({ type: FortressSkinPointsDto, description: '공용 포인트 지갑' }) points: FortressSkinPointsDto;
  @ApiProperty({ example: SKIN_MAX_LEVEL }) maxLevel: number;
  @ApiProperty({ type: [Number], description: '[i] = Lv(i+1) → Lv(i+2) 비용', example: [100000, 200000, 700000, 2000000] }) levelCosts: number[];
  @ApiProperty({ type: [FortressSkinItemDto] }) items: FortressSkinItemDto[];
}

export class FortressSkinsResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: FortressSkinsDto }) data: FortressSkinsDto;
}

export class FortressMatchPointsDto {
  @ApiProperty({ example: 'AbCdEfGhIjKlMnOp' }) matchId: string;
  @ApiProperty({ description: '내가 로그인 상태로 참가했는지(경기 시작 때 기준) — false면 earned 0' }) participant: boolean;
  @ApiProperty({ description: '이 경기로 적립된 포인트 — 무효 경기·기권·일일 상한 소진이면 0', example: 50000 }) earned: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '적립 내역(참가·승리·KO·같은 상대 감쇠·일일 상한) — 적립이 없으면 null',
    example: '포트리스 경기 AbCdEfGhIjKlMnOp · 참가 20,000 · 승리 30,000',
  })
  memo: string | null;
}

export class FortressMatchPointsResponseDto extends ApiSuccessResponseDto {
  @ApiProperty({ type: FortressMatchPointsDto }) data: FortressMatchPointsDto;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, Length } from 'class-validator';
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

import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, Length } from 'class-validator';

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

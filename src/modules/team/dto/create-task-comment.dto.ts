import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class CreateTaskCommentDto {
  @ApiProperty({ description: '댓글 내용', example: '이 태스크에 대한 의견입니다.' })
  @IsString()
  @IsNotEmpty()
  commentContent: string;
}

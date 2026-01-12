import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class UpdateTaskCommentDto {
  @ApiProperty({ description: '댓글 내용', example: '수정된 댓글 내용입니다.' })
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  commentContent?: string;
}

import { HttpException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

export class ApiSuccessResponseDto {
  @ApiProperty({ example: 'SUCCESS', enum: ['SUCCESS'] })
  code!: 'SUCCESS';

  @ApiProperty({ description: '응답 메시지', example: '' })
  message!: string;
}

export abstract class ApiErrorResponseDto extends HttpException {
  abstract code: string;

  constructor(status: number, message: string) {
    super(message, status);
  }
}

export class ApiValidationErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'VALIDATION_ERROR', enum: ['VALIDATION_ERROR'] })
  code!: 'VALIDATION_ERROR';

  @ApiProperty({ example: '요청 값이 올바르지 않습니다.' })
  message!: string;

  constructor() {
    super(422, '요청 값이 올바르지 않습니다.');
    this.code = 'VALIDATION_ERROR';
  }
}

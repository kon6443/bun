import { HttpException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 에러 응답 베이스 클래스
 * HttpException을 상속하여 NestJS 예외 처리 흐름 유지
 */
export abstract class ApiErrorResponseDto extends HttpException {
  abstract readonly code: string;

  constructor(status: number, message: string, code: string) {
    // 문자열만 전달하여 Swagger 분석 시 순환 참조 방지
    super(message, status);
    (this as any).code = code;
  }

  getErrorCode(): string {
    return this.code;
  }

  // 예외 필터에서 사용할 응답 객체 생성
  getErrorResponse(): { code: string; message: string } {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

// ==================== 공통 에러 DTO ====================

export class ApiValidationErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'VALIDATION_ERROR', enum: ['VALIDATION_ERROR'] })
  readonly code: string = 'VALIDATION_ERROR';

  @ApiProperty({ example: '요청 값이 올바르지 않습니다.' })
  declare message: string;

  constructor(message: string = '요청 값이 올바르지 않습니다.') {
    super(422, message, 'VALIDATION_ERROR');
  }
}

export class ApiNotFoundErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'NOT_FOUND', enum: ['NOT_FOUND'] })
  readonly code: string = 'NOT_FOUND';

  constructor(message: string = '리소스를 찾을 수 없습니다.') {
    super(404, message, 'NOT_FOUND');
  }
}

export class ApiForbiddenErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'FORBIDDEN', enum: ['FORBIDDEN'] })
  readonly code: string = 'FORBIDDEN';

  constructor(message: string = '접근 권한이 없습니다.') {
    super(403, message, 'FORBIDDEN');
  }
}

export class ApiUnauthorizedErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'UNAUTHORIZED', enum: ['UNAUTHORIZED'] })
  readonly code: string = 'UNAUTHORIZED';

  constructor(message: string = '인증이 필요합니다.') {
    super(401, message, 'UNAUTHORIZED');
  }
}

export class ApiBadRequestErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'BAD_REQUEST', enum: ['BAD_REQUEST'] })
  readonly code: string = 'BAD_REQUEST';

  constructor(message: string = '잘못된 요청입니다.') {
    super(400, message, 'BAD_REQUEST');
  }
}

export class ApiInternalServerErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'INTERNAL_SERVER_ERROR', enum: ['INTERNAL_SERVER_ERROR'] })
  readonly code: string = 'INTERNAL_SERVER_ERROR';

  constructor(message: string = '서버 내부 오류가 발생했습니다.') {
    super(500, message, 'INTERNAL_SERVER_ERROR');
  }
}

export class ApiBadGatewayErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'BAD_GATEWAY', enum: ['BAD_GATEWAY'] })
  readonly code: string = 'BAD_GATEWAY';

  constructor(message: string = '외부 서비스 오류가 발생했습니다.') {
    super(502, message, 'BAD_GATEWAY');
  }
}

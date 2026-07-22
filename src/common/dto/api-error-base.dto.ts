import { HttpException } from '@nestjs/common';

/**
 * 에러 응답 베이스 클래스
 * HttpException을 상속하여 NestJS 예외 처리 흐름 유지
 *
 * details: 도메인별 부가 컨텍스트 (validation 필드 목록, retry-after 등).
 *          정의 시점이 아닌 throw 시점에 옵션으로 전달. filter가 응답에 포함.
 *
 * 파일 분리 이유: api-error.dto.ts가 defineDomainError 팩토리를 사용하고
 * 팩토리는 이 베이스를 상속하므로, 베이스를 분리하지 않으면 순환 import 발생.
 */
export abstract class ApiErrorResponseDto extends HttpException {
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code: string, details?: unknown) {
    // 문자열만 전달하여 Swagger 분석 시 순환 참조 방지
    super(message, status);
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  // 예외 필터에서 사용할 응답 객체 생성
  getErrorResponse(): { code: string; message: string; details?: unknown } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

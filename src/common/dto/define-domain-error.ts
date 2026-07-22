import { ApiProperty } from '@nestjs/swagger';
import { ApiErrorResponseDto } from './api-error-base.dto';

interface DefineDomainErrorOptions {
  code: string;
  status: number;
  message: string;
  /**
   * 클래스명(=Swagger 스키마명) 오버라이드.
   * 기본은 code에서 자동 생성 (모듈 접두사 포함 code는 자동 유도 가능 — TEAM_NOT_FOUND 등).
   * 모듈 접두사가 없는 공통 코드는 'Api' 접두사를 code로 유도할 수 없으므로
   * **공통 DTO(api-error.dto.ts)는 항상 name을 명시해야 한다**
   * (예: 'NOT_FOUND' → name: 'ApiNotFoundErrorResponseDto').
   */
  name?: string;
}

interface ThrowOptions {
  message?: string;
  details?: unknown;
}

interface DomainErrorClass {
  new (messageOrOptions?: string | ThrowOptions): ApiErrorResponseDto;
  readonly errorCode: string;
  readonly status: number;
  readonly defaultMessage: string;
}

function codeToClassName(code: string): string {
  // 말미 '_ERROR'는 접미사 'ErrorResponseDto'와 중복되므로 제거
  // (예: AUTH_KAKAO_API_ERROR → AuthKakaoApiErrorResponseDto)
  const pascal = code
    .replace(/_ERROR$/, '')
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `${pascal}ErrorResponseDto`;
}

export function defineDomainError(options: DefineDomainErrorOptions): DomainErrorClass {
  const { code, status, message: defaultMessage, name } = options;

  class DomainError extends ApiErrorResponseDto {
    @ApiProperty({ example: code, enum: [code] })
    readonly code: string = code;

    @ApiProperty({ example: defaultMessage })
    declare message: string;

    constructor(messageOrOptions?: string | ThrowOptions) {
      const opts: ThrowOptions =
        typeof messageOrOptions === 'string'
          ? { message: messageOrOptions }
          : (messageOrOptions ?? {});
      super(status, opts.message ?? defaultMessage, code, opts.details);
    }

    static readonly errorCode = code;
    static readonly status = status;
    static readonly defaultMessage = defaultMessage;
  }

  Object.defineProperty(DomainError, 'name', { value: name ?? codeToClassName(code) });
  return DomainError as unknown as DomainErrorClass;
}

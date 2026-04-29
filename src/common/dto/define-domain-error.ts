import { ApiProperty } from '@nestjs/swagger';
import { ApiErrorResponseDto } from './api-error.dto';

interface DefineDomainErrorOptions {
  code: string;
  status: number;
  message: string;
}

interface DomainErrorClass {
  new (message?: string): ApiErrorResponseDto;
  readonly errorCode: string;
  readonly status: number;
  readonly defaultMessage: string;
}

function codeToClassName(code: string): string {
  const pascal = code
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `${pascal}ErrorResponseDto`;
}

export function defineDomainError(options: DefineDomainErrorOptions): DomainErrorClass {
  const { code, status, message: defaultMessage } = options;

  class DomainError extends ApiErrorResponseDto {
    @ApiProperty({ example: code, enum: [code] })
    readonly code: string = code;

    @ApiProperty({ example: defaultMessage })
    declare message: string;

    constructor(message?: string) {
      super(status, message ?? defaultMessage, code);
    }

    static readonly errorCode = code;
    static readonly status = status;
    static readonly defaultMessage = defaultMessage;
  }

  Object.defineProperty(DomainError, 'name', { value: codeToClassName(code) });
  return DomainError as unknown as DomainErrorClass;
}

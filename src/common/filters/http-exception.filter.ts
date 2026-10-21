import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiErrorResponseDto } from '../dto/api-error.dto';
import { toErrorDetail } from '../utils/error.utils';

interface HttpExceptionBody {
  message?: string;
}

/**
 * HTTP 상태 코드를 기본 에러 코드로 매핑
 */
function getDefaultErrorCode(status: number): string {
  const statusCodeMap: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    413: 'PAYLOAD_TOO_LARGE',
    415: 'UNSUPPORTED_MEDIA_TYPE',
    422: 'VALIDATION_ERROR',
    429: 'TOO_MANY_REQUESTS',
    500: 'INTERNAL_SERVER_ERROR',
    502: 'BAD_GATEWAY',
    503: 'SERVICE_UNAVAILABLE',
  };
  return statusCodeMap[status] || 'UNKNOWN_ERROR';
}

/**
 * Express 미들웨어(body-parser 등)가 던지는 http-errors 형태의 클라이언트 오류.
 * HttpException이 아니라서 따로 판별하지 않으면 500으로 잘못 나간다 (예: 본문 크기 초과 413, 지원하지 않는 문자셋 415).
 * JSON 문법 오류(SyntaxError)는 Nest가 필터 전에 BadRequestException으로 바꾸므로 이 분기에 오지 않는다.
 * `expose: true`는 http-errors가 "클라이언트에 알려도 되는 오류"로 표시한 것이다.
 */
interface ExposedClientError extends Error {
  status: number;
  expose: true;
  type?: string;
}

function isExposedClientError(exception: unknown): exception is ExposedClientError {
  if (!(exception instanceof Error)) {
    return false;
  }
  const { status, expose } = exception as Partial<ExposedClientError>;
  return expose === true && typeof status === 'number' && status >= 400 && status < 500;
}

/** 미들웨어 오류 메시지는 영어 원문 대신 고정 한국어 문구로 — 원문에 내부 정보가 섞일 수 있다 */
function getClientErrorMessage(status: number): string {
  if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
    return '요청 본문이 너무 큽니다.';
  }
  return '요청 형식이 올바르지 않습니다.';
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : isExposedClientError(exception)
          ? exception.status
          : HttpStatus.INTERNAL_SERVER_ERROR;

    // 에러 코드 및 메시지 추출
    let code: string;
    let message: string;
    let details: unknown;

    if (exception instanceof ApiErrorResponseDto) {
      // 커스텀 에러 DTO인 경우 — 직렬화는 베이스 클래스 헬퍼로 일원화
      const errorBody = exception.getErrorResponse();
      code = errorBody.code;
      message = errorBody.message;
      details = errorBody.details;
    } else if (exception instanceof HttpException) {
      // 일반 HttpException인 경우
      const exceptionResponse = exception.getResponse();
      code = getDefaultErrorCode(status);
      message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : (exceptionResponse as HttpExceptionBody).message || exception.message;
    } else if (isExposedClientError(exception)) {
      // 미들웨어(body-parser)의 클라이언트 오류 — 413·400 등 상태 그대로
      code = getDefaultErrorCode(status);
      message = getClientErrorMessage(status);
    } else {
      // 알 수 없는 에러인 경우
      code = 'INTERNAL_SERVER_ERROR';
      message = '서버 내부 오류가 발생했습니다.';
    }

    const errorResponse = {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      timestamp: new Date().toISOString(),
    };

    // 에러 로깅 (레벨 분리)
    const logMessage = `${request.method} ${request.url} - ${JSON.stringify(errorResponse)}`;
    if (status >= 500) {
      if (exception instanceof Error) {
        this.logger.error(logMessage, exception.stack);
      } else {
        // 알 수 없는 예외: 원본 객체 전체 로깅 — 객체를 그대로 넘기면 Nest Logger가 버리므로 직렬화한다
        this.logger.error(`${logMessage} | 원본 예외:`, toErrorDetail(exception));
      }
    } else {
      this.logger.warn(logMessage);
    }

    response.status(status).json(errorResponse);
  }
}





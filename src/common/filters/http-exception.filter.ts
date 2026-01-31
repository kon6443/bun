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
    422: 'VALIDATION_ERROR',
    500: 'INTERNAL_SERVER_ERROR',
    502: 'BAD_GATEWAY',
    503: 'SERVICE_UNAVAILABLE',
  };
  return statusCodeMap[status] || 'UNKNOWN_ERROR';
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
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // 에러 코드 및 메시지 추출
    let code: string;
    let message: string;

    if (exception instanceof ApiErrorResponseDto) {
      // 커스텀 에러 DTO인 경우
      const exceptionResponse = exception.getResponse() as { code: string; message: string };
      code = exceptionResponse.code || exception.getErrorCode();
      message = exceptionResponse.message || exception.message;
    } else if (exception instanceof HttpException) {
      // 일반 HttpException인 경우
      const exceptionResponse = exception.getResponse();
      code = getDefaultErrorCode(status);
      message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : (exceptionResponse as any).message || exception.message;
    } else {
      // 알 수 없는 에러인 경우
      code = 'INTERNAL_SERVER_ERROR';
      message = '서버 내부 오류가 발생했습니다.';
    }

    const errorResponse = {
      code,
      message,
      timestamp: new Date().toISOString(),
    };

    // 에러 로깅 (레벨 분리)
    const logMessage = `${request.method} ${request.url} - ${JSON.stringify(errorResponse)}`;
    if (status >= 500) {
      this.logger.error(
        logMessage,
        exception instanceof Error ? exception.stack : JSON.stringify(exception),
      );
    } else {
      this.logger.warn(logMessage);
    }

    response.status(status).json(errorResponse);
  }
}





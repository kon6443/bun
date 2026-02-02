import { Catch, ArgumentsHost, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

/**
 * WebSocket 예외 응답 타입
 */
interface WsErrorResponse {
  code: string;
  message: string;
  timestamp: string;
}

/**
 * WebSocket 전용 예외 필터
 *
 * NestJS 정석 패턴:
 * - BaseWsExceptionFilter 상속
 * - 예외 발생 시 클라이언트에 'error' 이벤트로 전달
 * - 구조화된 에러 응답 제공
 */
@Catch()
export class WsExceptionFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger(WsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    const errorResponse = this.createErrorResponse(exception);

    this.logger.error(
      `WebSocket Error [${client.id}]: ${errorResponse.message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    // 클라이언트에 에러 이벤트 전송
    client.emit('error', errorResponse);
  }

  /**
   * 예외를 구조화된 에러 응답으로 변환
   */
  private createErrorResponse(exception: unknown): WsErrorResponse {
    const timestamp = new Date().toISOString();

    // WsException인 경우
    if (exception instanceof WsException) {
      const error = exception.getError();
      if (typeof error === 'string') {
        return {
          code: 'WS_ERROR',
          message: error,
          timestamp,
        };
      }
      if (typeof error === 'object' && error !== null) {
        return {
          code: (error as any).code || 'WS_ERROR',
          message: (error as any).message || '알 수 없는 WebSocket 오류',
          timestamp,
        };
      }
    }

    // 일반 Error인 경우
    if (exception instanceof Error) {
      return {
        code: 'WS_ERROR',
        message: exception.message,
        timestamp,
      };
    }

    // 기타
    return {
      code: 'WS_UNKNOWN_ERROR',
      message: '알 수 없는 오류가 발생했습니다.',
      timestamp,
    };
  }
}

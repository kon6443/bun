import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';
import { FortressError } from './fortress.errors';
import { ErrorPayload, FortressAck, FortressErrorCode, FortressServerEvents } from './fortress.events';

type ErrorAck = Extract<FortressAck<never>, { ok: false }>;

/**
 * `/fortress` 전용 예외 필터 — 실패를 **ack `{ ok: false, code, message }`**로 돌려준다(테트리스 대전 필터와 같은 규칙).
 * ack 없이 보낸 요청이면 `error` 이벤트 `{ code, message, timestamp }`로 보낸다.
 *
 * - `FortressError` → 그 code
 * - `BadRequestException`(핸들러 ValidationPipe 실패) → INVALID_PAYLOAD
 * - 그 외 → INTERNAL_ERROR (내부 메시지 노출 안 함, 스택 로그)
 */
@Catch()
export class FortressWsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(FortressWsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    const response = this.toErrorAck(exception, client.id);

    const ack: unknown = host.getArgs()[2];
    if (typeof ack === 'function') {
      (ack as (payload: ErrorAck) => void)(response);
      return;
    }
    const payload: ErrorPayload = { code: response.code, message: response.message, timestamp: new Date().toISOString() };
    client.emit(FortressServerEvents.ERROR, payload);
  }

  private toErrorAck(exception: unknown, socketId: string): ErrorAck {
    if (exception instanceof FortressError) {
      this.logger.debug(`[Fortress] ${exception.code} socket=${socketId}`);
      return this.fail(exception.code, exception.message);
    }
    if (exception instanceof BadRequestException) {
      this.logger.debug(`[Fortress] INVALID_PAYLOAD socket=${socketId}: ${JSON.stringify(exception.getResponse())}`);
      return this.fail('INVALID_PAYLOAD', '요청 형식이 올바르지 않습니다.');
    }
    this.logger.error(
      `[Fortress] 처리 중 오류 socket=${socketId}: ${exception instanceof Error ? exception.message : String(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    return this.fail('INTERNAL_ERROR', '서버 내부 오류가 발생했습니다.');
  }

  private fail(code: FortressErrorCode, message: string): ErrorAck {
    return { ok: false, code, message };
  }
}

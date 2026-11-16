import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { handleGameWsException } from '../game-room/game-room-socket';
import { FortressError } from './fortress.errors';
import { FortressErrorCode, FortressServerEvents } from './fortress.events';

/**
 * `/fortress` 전용 예외 필터 — 실패를 ack `{ ok: false, code, message }`로, ack가 없으면 `error` 이벤트로 돌려준다.
 * 규칙은 게임 공용 handleGameWsException(테트리스 대전과 같다): FortressError → 그 code, ValidationPipe 실패 → INVALID_PAYLOAD, 그 외 → INTERNAL_ERROR
 */
@Catch()
export class FortressWsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(FortressWsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    handleGameWsException<FortressErrorCode>(exception, host, {
      logger: this.logger,
      label: '[Fortress]',
      errorEvent: FortressServerEvents.ERROR,
      domainError: e => (e instanceof FortressError ? { code: e.code, message: e.message } : null),
      invalidPayloadCode: 'INVALID_PAYLOAD',
      internalErrorCode: 'INTERNAL_ERROR',
    });
  }
}

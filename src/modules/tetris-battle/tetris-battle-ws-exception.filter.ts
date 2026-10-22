import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';
import { TetrisBattleError } from './tetris-battle.errors';
import { TetrisBattleAck, TetrisBattleErrorCode, TetrisBattleServerEvents } from './tetris-battle.events';

type ErrorAck = Extract<TetrisBattleAck<never>, { ok: false }>;

/**
 * `/tetris-battle` 전용 예외 필터 — 실패를 **ack `{ ok: false, code, message }`**로 돌려준다(DESIGN §16).
 *
 * 공용 `WsExceptionFilter`는 `error` 이벤트만 보내서 클라이언트의 ack 콜백이 끝내 불리지 않는다.
 * Nest WS 핸들러 인자는 `[client, data, ack, pattern]`이라 ack 콜백을 여기서 직접 부른다.
 * ack 없이 보낸 요청이면 `error` 이벤트로 보낸다(공용 필터와 같은 형태 + timestamp).
 *
 * - `TetrisBattleError` → 그 code
 * - `BadRequestException`(핸들러 ValidationPipe 실패) → INVALID_PAYLOAD
 * - 그 외 → INTERNAL_ERROR (내부 메시지 노출 안 함, 스택 로그)
 */
@Catch()
export class TetrisBattleWsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(TetrisBattleWsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    const response = this.toErrorAck(exception, client.id);

    const ack: unknown = host.getArgs()[2];
    if (typeof ack === 'function') {
      (ack as (payload: ErrorAck) => void)(response);
      return;
    }
    client.emit(TetrisBattleServerEvents.ERROR, {
      code: response.code,
      message: response.message,
      timestamp: new Date().toISOString(),
    });
  }

  private toErrorAck(exception: unknown, socketId: string): ErrorAck {
    if (exception instanceof TetrisBattleError) {
      this.logger.debug(`[TetrisBattle] ${exception.code} socket=${socketId}`);
      return this.fail(exception.code, exception.message);
    }
    if (exception instanceof BadRequestException) {
      this.logger.debug(`[TetrisBattle] INVALID_PAYLOAD socket=${socketId}: ${JSON.stringify(exception.getResponse())}`);
      return this.fail('INVALID_PAYLOAD', '요청 형식이 올바르지 않습니다.');
    }
    this.logger.error(
      `[TetrisBattle] 처리 중 오류 socket=${socketId}: ${exception instanceof Error ? exception.message : String(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    return this.fail('INTERNAL_ERROR', '서버 내부 오류가 발생했습니다.');
  }

  private fail(code: TetrisBattleErrorCode, message: string): ErrorAck {
    return { ok: false, code, message };
  }
}

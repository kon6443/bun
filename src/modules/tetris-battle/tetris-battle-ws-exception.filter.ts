import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { handleGameWsException } from '../game-room/game-room-socket';
import { TetrisBattleError } from './tetris-battle.errors';
import { TetrisBattleErrorCode, TetrisBattleServerEvents } from './tetris-battle.events';

/**
 * `/tetris-battle` 전용 예외 필터 — 실패를 ack `{ ok: false, code, message }`로, ack가 없으면 `error` 이벤트로 돌려준다(DESIGN §16).
 * 규칙은 게임 공용 handleGameWsException(포트리스와 같다): TetrisBattleError → 그 code, ValidationPipe 실패 → INVALID_PAYLOAD, 그 외 → INTERNAL_ERROR
 */
@Catch()
export class TetrisBattleWsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(TetrisBattleWsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    handleGameWsException<TetrisBattleErrorCode>(exception, host, {
      logger: this.logger,
      label: '[TetrisBattle]',
      errorEvent: TetrisBattleServerEvents.ERROR,
      domainError: e => (e instanceof TetrisBattleError ? { code: e.code, message: e.message } : null),
      invalidPayloadCode: 'INVALID_PAYLOAD',
      internalErrorCode: 'INTERNAL_ERROR',
    });
  }
}

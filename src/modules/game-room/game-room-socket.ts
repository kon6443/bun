import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { JwtPayload, verify } from 'jsonwebtoken';
import { Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';

type AccessTokenPayload = JwtPayload & { sub: number };

/**
 * 게임 대전 소켓의 로그인 판정 (게임 공용 — 테트리스 대전·포트리스 WS 가드). **접속을 거부하지 않는다**(비로그인 참가 허용).
 *
 * - `handshake.auth.token`(또는 Bearer 헤더)이 유효하고 활성 유저면 그 userId
 * - 없거나 무효(만료·서명 오류 포함)면 게스트 null — fishing 정책과 같다
 * - DB 일시 오류는 게스트로 확정하지 않고 `unavailable()`을 던진다 — 확정하면 이 소켓은 끝까지 게스트라
 *   좌석 넘겨받기·결과 귀속이 깨진다(테트리스 games-polish BT-03). 가드가 authResolved를 세우기 전에 던지므로 다음 이벤트에서 다시 조회한다
 */
export async function resolveGameSocketUserId(
  client: Socket,
  secret: string | undefined,
  userRepository: Repository<User>,
  unavailable: () => Error,
): Promise<number | null> {
  const token = extractSocketToken(client);
  if (!token || !secret) return null;

  let payload: AccessTokenPayload;
  try {
    payload = verify(token, secret) as AccessTokenPayload;
  } catch {
    return null;
  }
  if (!payload?.sub) return null;

  try {
    const user = await userRepository.findOne({ where: { userId: payload.sub, isActivated: 1 } });
    return user ? user.userId : null;
  } catch {
    throw unavailable();
  }
}

function extractSocketToken(client: Socket): string | null {
  const authToken: unknown = client.handshake.auth?.token;
  if (typeof authToken === 'string' && authToken) return authToken;

  const authHeader = client.handshake.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) return authHeader.slice(7);

  return null;
}

/** 실패 ack 모양 — 각 게임 events.ts의 Ack 실패 갈래와 같다 */
export interface GameErrorAck<TCode extends string> {
  ok: false;
  code: TCode;
  message: string;
}

export interface GameWsExceptionOptions<TCode extends string> {
  logger: Logger;
  /** 로그 머리표 — 예: '[Fortress]' */
  label: string;
  /** ack 없이 보낸 요청에 보낼 이벤트 이름 */
  errorEvent: string;
  /** 게임 도메인 에러면 그 code·message */
  domainError: (exception: unknown) => { code: TCode; message: string } | null;
  invalidPayloadCode: TCode;
  internalErrorCode: TCode;
}

/**
 * 게임 대전 WS 예외 처리 (게임 공용) — 실패를 **ack `{ ok: false, code, message }`**로 돌려준다.
 * 공용 `WsExceptionFilter`는 `error` 이벤트만 보내서 클라이언트의 ack 콜백이 끝내 불리지 않는다.
 * Nest WS 핸들러 인자는 `[client, data, ack, pattern]`이라 ack 콜백을 여기서 직접 부른다.
 * ack 없이 보낸 요청이면 `error` 이벤트 `{ code, message, timestamp }`로 보낸다.
 *
 * - 도메인 에러 → 그 code
 * - `BadRequestException`(핸들러 ValidationPipe 실패) → invalidPayloadCode
 * - 그 외 → internalErrorCode (내부 메시지 노출 안 함, 스택 로그)
 */
export function handleGameWsException<TCode extends string>(
  exception: unknown,
  host: ArgumentsHost,
  options: GameWsExceptionOptions<TCode>,
): void {
  const client = host.switchToWs().getClient<Socket>();
  const response = toErrorAck(exception, client.id, options);

  const ack: unknown = host.getArgs()[2];
  if (typeof ack === 'function') {
    (ack as (payload: GameErrorAck<TCode>) => void)(response);
    return;
  }
  client.emit(options.errorEvent, {
    code: response.code,
    message: response.message,
    timestamp: new Date().toISOString(),
  });
}

function toErrorAck<TCode extends string>(
  exception: unknown,
  socketId: string,
  options: GameWsExceptionOptions<TCode>,
): GameErrorAck<TCode> {
  const { logger, label } = options;
  const domain = options.domainError(exception);
  if (domain) {
    logger.debug(`${label} ${domain.code} socket=${socketId}`);
    return { ok: false, code: domain.code, message: domain.message };
  }
  if (exception instanceof BadRequestException) {
    logger.debug(`${label} INVALID_PAYLOAD socket=${socketId}: ${JSON.stringify(exception.getResponse())}`);
    return { ok: false, code: options.invalidPayloadCode, message: '요청 형식이 올바르지 않습니다.' };
  }
  logger.error(
    `${label} 처리 중 오류 socket=${socketId}: ${exception instanceof Error ? exception.message : String(exception)}`,
    exception instanceof Error ? exception.stack : undefined,
  );
  return { ok: false, code: options.internalErrorCode, message: '서버 내부 오류가 발생했습니다.' };
}

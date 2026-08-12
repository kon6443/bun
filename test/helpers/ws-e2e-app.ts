import { INestApplication, Provider, Type } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { io, Socket } from 'socket.io-client';

/**
 * WebSocket E2E용 앱 부팅 헬퍼.
 *
 * HTTP E2E(`e2e-app.ts`)와 결정적으로 다른 점은 **실제로 포트를 연다**는 것이다.
 * supertest는 `app.getHttpServer()`에 직접 요청을 주입하지만, 소켓은 진짜 핸드셰이크가
 * 필요하므로 `listen(0)`으로 OS가 준 빈 포트에 붙는다.
 *
 * Redis는 쓰지 않는다 — `RedisIoAdapter`는 멀티 레플리카 브로드캐스트용이고,
 * 단일 프로세스 테스트에서는 Socket.IO 기본 어댑터로 충분하다. 덕분에 이 스펙도
 * 외부 의존성 없이 돈다.
 *
 * **가드를 override하지 않는다.** WS 인증(핸드셰이크 토큰 추출 → 검증 → 유저 조회)이
 * 실제 소켓 위에서 동작하는지가 검증 대상이기 때문이다. 대신 `providers`로
 * ConfigService(JWT_SECRET)와 User Repository를 넣어야 한다.
 */
export interface CreateWsAppOptions {
  gateways: Type<unknown>[];
  providers?: Provider[];
}

export interface WsE2eApp {
  app: INestApplication;
  moduleRef: TestingModule;
  /** 네임스페이스에 소켓을 연결한다. 연결 성공까지 기다린 뒤 반환 */
  connect: (options?: { token?: string; namespace?: string }) => Promise<Socket>;
  /** 열린 소켓을 모두 끊고 서버를 닫는다 — 안 하면 Jest가 종료되지 않는다 */
  close: () => Promise<void>;
}

/** 이벤트 하나를 기다린다. 안 오면 타임아웃으로 실패시켜 테스트가 멈추지 않게 한다 */
export const waitFor = <T>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`'${event}' 이벤트가 ${timeoutMs}ms 안에 오지 않았다`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

/**
 * 이벤트가 **오지 않아야** 함을 확인한다.
 * "안 온다"는 기다려봐야 알 수 있어서, 짧은 관찰 창을 두고 그 안에 안 오면 통과로 본다.
 */
export const expectNoEvent = async (
  socket: Socket,
  event: string,
  windowMs = 300,
): Promise<void> => {
  let received: unknown;
  const handler = (payload: unknown) => {
    received = payload ?? true;
  };
  socket.on(event, handler);
  await new Promise((r) => setTimeout(r, windowMs));
  socket.off(event, handler);
  if (received !== undefined) {
    throw new Error(`'${event}' 이벤트가 오면 안 되는데 도착했다: ${JSON.stringify(received)}`);
  }
};

/** emit 후 서버의 ack(핸들러 반환값)을 기다린다 */
export const emitWithAck = <T>(socket: Socket, event: string, payload: unknown, timeoutMs = 3000) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`'${event}' ack이 ${timeoutMs}ms 안에 오지 않았다`)),
      timeoutMs,
    );
    socket.emit(event, payload, (ack: T) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });

export const createWsApp = async ({
  gateways,
  providers = [],
}: CreateWsAppOptions): Promise<WsE2eApp> => {
  const moduleRef = await Test.createTestingModule({
    providers: [...gateways, ...providers],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  await app.listen(0);

  const { port } = app.getHttpServer().address() as AddressInfo;
  const sockets: Socket[] = [];

  const connect = ({ token, namespace = '/teams' }: { token?: string; namespace?: string } = {}) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = io(`http://127.0.0.1:${port}${namespace}`, {
        // websocket만 쓴다 — polling 폴백은 테스트를 느리고 불안정하게 만든다
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        ...(token ? { auth: { token } } : {}),
      });
      sockets.push(socket);

      const timer = setTimeout(() => reject(new Error('소켓 연결 타임아웃')), 3000);
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

  const close = async () => {
    for (const s of sockets) {
      s.removeAllListeners();
      s.disconnect();
    }
    await app.close();
  };

  return { app, moduleRef, connect, close };
};

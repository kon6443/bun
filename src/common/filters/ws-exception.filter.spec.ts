import { ArgumentsHost, Logger } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { WsExceptionFilter } from './ws-exception.filter';

/**
 * WS는 HTTP status가 없어 클라이언트가 오직 `code`로 분기한다.
 * 따라서 code 매핑이 이 필터의 핵심 계약이다.
 * 또한 응답 메시지에 내부 오류 원문이 새지 않아야 한다(HTTP 필터와 동일 정책).
 */
describe('WsExceptionFilter', () => {
  let filter: WsExceptionFilter;
  let emit: jest.Mock;
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new WsExceptionFilter();
    emit = jest.fn();

    host = {
      switchToWs: () => ({ getClient: () => ({ id: 'socket-1', emit }) as unknown as Socket }),
    } as unknown as ArgumentsHost;

    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** emit('error', payload)의 payload에서 timestamp를 뗀 나머지 */
  const emittedBody = () => {
    expect(emit).toHaveBeenCalledWith('error', expect.any(Object));
    const [event, payload] = emit.mock.calls[0];
    expect(event).toBe('error');
    const { timestamp, ...rest } = payload;
    expect(typeof timestamp).toBe('string');
    return rest;
  };

  describe('WsException', () => {
    it('객체 payload의 code·message를 그대로 전달해야 함', () => {
      filter.catch(
        new WsException({ code: 'CHAT_NOT_JOINED', message: '채팅방에 참여하지 않았습니다.' }),
        host,
      );

      expect(emittedBody()).toEqual({
        code: 'CHAT_NOT_JOINED',
        message: '채팅방에 참여하지 않았습니다.',
      });
    });

    it('문자열 payload는 WS_ERROR로 감싸야 함', () => {
      filter.catch(new WsException('문자열 에러'), host);

      expect(emittedBody()).toEqual({ code: 'WS_ERROR', message: '문자열 에러' });
    });

    it('code가 없는 객체는 WS_ERROR로 보완해야 함', () => {
      filter.catch(new WsException({ message: '코드 없음' }), host);

      expect(emittedBody()).toEqual({ code: 'WS_ERROR', message: '코드 없음' });
    });

    it('message가 없는 객체는 기본 메시지로 보완해야 함', () => {
      filter.catch(new WsException({ code: 'ONLY_CODE' }), host);

      expect(emittedBody()).toEqual({
        code: 'ONLY_CODE',
        message: '알 수 없는 WebSocket 오류',
      });
    });
  });

  describe('일반 Error — 내부 정보 비노출', () => {
    it('원본 메시지를 응답에 넣지 않아야 함', () => {
      filter.catch(new Error('ORA-00001: unique constraint violated'), host);

      expect(emittedBody()).toEqual({
        code: 'WS_ERROR',
        message: '서버 내부 오류가 발생했습니다.',
      });
    });

    it('로그에는 원본 메시지와 스택을 남겨야 함 (디버깅 가능해야 하므로)', () => {
      const error = new Error('ORA-00001');

      filter.catch(error, host);

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining('ORA-00001'),
        error.stack,
      );
    });
  });

  describe('기타 예외', () => {
    it.each([
      ['문자열 throw', 'plain string'],
      ['null throw', null],
      ['객체 throw', { weird: true }],
    ])('%s → WS_UNKNOWN_ERROR', (_desc, exception) => {
      filter.catch(exception, host);

      expect(emittedBody()).toEqual({
        code: 'WS_UNKNOWN_ERROR',
        message: '알 수 없는 오류가 발생했습니다.',
      });
    });
  });
});

import { ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';
import { defineDomainError } from '../dto/define-domain-error';

const TestDomainError = defineDomainError({
  code: 'TEST_DOMAIN_ERROR',
  status: 404,
  message: '테스트 도메인 에러',
});

/**
 * 이 필터는 모든 에러 응답의 형식을 결정하는 단일 지점이다.
 * 프론트가 `code`로 분기하므로 code·message·status 계약이 깨지면 전 화면이 영향을 받는다.
 */
describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;
  let json: jest.Mock;
  let status: jest.Mock;
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    json = jest.fn();
    status = jest.fn(() => ({ json }));

    host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ method: 'GET', url: '/api/v1/teams' }),
      }),
    } as unknown as ArgumentsHost;

    // 필터는 정상 동작 중에도 로그를 남긴다 — 테스트 출력이 더러워지지 않게 막는다
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** 응답 본문에서 timestamp를 뗀 나머지 — timestamp는 매 호출마다 달라 비교 대상이 아니다 */
  const responseBody = () => {
    const { timestamp, ...rest } = json.mock.calls[0][0];
    expect(typeof timestamp).toBe('string');
    return rest;
  };

  describe('도메인 에러 DTO (ApiErrorResponseDto 계열)', () => {
    it('DTO에 정의된 code·message·status를 그대로 사용해야 함', () => {
      filter.catch(new TestDomainError(), host);

      expect(status).toHaveBeenCalledWith(404);
      expect(responseBody()).toEqual({
        code: 'TEST_DOMAIN_ERROR',
        message: '테스트 도메인 에러',
      });
    });

    it('throw 시점에 넘긴 message로 덮어쓸 수 있어야 함', () => {
      filter.catch(new TestDomainError('구체적인 사유'), host);

      expect(responseBody()).toEqual({
        code: 'TEST_DOMAIN_ERROR',
        message: '구체적인 사유',
      });
    });

    // throw 시점 옵션은 문자열(message만) 또는 { message, details } 객체 두 형태를 받는다
    it('details를 넘기면 응답에 포함해야 함', () => {
      filter.catch(
        new TestDomainError({ message: '사유', details: { field: 'teamName' } }),
        host,
      );

      expect(responseBody()).toEqual({
        code: 'TEST_DOMAIN_ERROR',
        message: '사유',
        details: { field: 'teamName' },
      });
    });

    it('details만 넘기면 기본 message가 유지되어야 함', () => {
      filter.catch(new TestDomainError({ details: ['a', 'b'] }), host);

      expect(responseBody()).toEqual({
        code: 'TEST_DOMAIN_ERROR',
        message: '테스트 도메인 에러',
        details: ['a', 'b'],
      });
    });

    it('details가 없으면 응답에 키 자체가 없어야 함 (null로 새지 않게)', () => {
      filter.catch(new TestDomainError(), host);

      expect(responseBody()).not.toHaveProperty('details');
    });
  });

  describe('일반 HttpException', () => {
    it.each([
      [400, 'BAD_REQUEST'],
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [409, 'CONFLICT'],
      [422, 'VALIDATION_ERROR'],
      [429, 'TOO_MANY_REQUESTS'],
      [500, 'INTERNAL_SERVER_ERROR'],
      [502, 'BAD_GATEWAY'],
      [503, 'SERVICE_UNAVAILABLE'],
    ])('status %i → code %s', (httpStatus, expectedCode) => {
      filter.catch(new HttpException('메시지', httpStatus), host);

      expect(status).toHaveBeenCalledWith(httpStatus);
      expect(responseBody()).toEqual({ code: expectedCode, message: '메시지' });
    });

    it('매핑에 없는 status는 UNKNOWN_ERROR로 표기해야 함', () => {
      filter.catch(new HttpException('teapot', 418), host);

      expect(responseBody()).toEqual({ code: 'UNKNOWN_ERROR', message: 'teapot' });
    });

    it('객체 형태 응답의 message 필드를 추출해야 함', () => {
      filter.catch(
        new HttpException({ message: '검증 실패', statusCode: 400 }, HttpStatus.BAD_REQUEST),
        host,
      );

      expect(responseBody()).toEqual({ code: 'BAD_REQUEST', message: '검증 실패' });
    });
  });

  describe('알 수 없는 예외', () => {
    /**
     * 여기서 원본 메시지가 새면 Oracle 에러(ORA-xxxxx)·스택 등 내부 정보가
     * 클라이언트에 노출된다. 500 + 고정 메시지로 수렴해야 한다.
     */
    it.each([
      ['일반 Error', new Error('ORA-00001: unique constraint violated')],
      ['문자열 throw', 'something broke'],
      ['null throw', null],
      ['객체 throw', { weird: true }],
    ])('%s → 500 + 고정 메시지, 원본 비노출', (_desc, exception) => {
      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(500);
      expect(responseBody()).toEqual({
        code: 'INTERNAL_SERVER_ERROR',
        message: '서버 내부 오류가 발생했습니다.',
      });
    });
  });

  describe('미들웨어 클라이언트 오류 (body-parser의 http-errors)', () => {
    /**
     * body-parser가 던지는 모양 그대로 — HttpException이 아니어서 예전에는 500으로 나갔다.
     * JSON 문법 오류(SyntaxError)는 여기 오지 않는다 — Nest가 필터 전에 BadRequestException으로 바꾼다(E2E games 400 케이스)
     */
    const middlewareError = (status: number, type: string, message: string) =>
      Object.assign(new Error(message), { status, statusCode: status, expose: true, type });

    it.each([
      ['본문 크기 초과', middlewareError(413, 'entity.too.large', 'request entity too large'), 413, 'PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다.'],
      ['지원하지 않는 문자셋', middlewareError(415, 'charset.unsupported', 'unsupported charset "EUC-KR"'), 415, 'UNSUPPORTED_MEDIA_TYPE', '요청 형식이 올바르지 않습니다.'],
    ])('%s → 원래 4xx 상태 + 고정 한국어 메시지 (원문 비노출)', (_desc, exception, expectedStatus, code, message) => {
      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(expectedStatus);
      expect(responseBody()).toEqual({ code, message });
      expect(Logger.prototype.warn).toHaveBeenCalled();
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it.each([
      ['expose 없는 4xx 모양', Object.assign(new Error('x'), { status: 413 })],
      ['expose가 있어도 5xx', Object.assign(new Error('x'), { status: 503, expose: true })],
    ])('%s는 클라이언트 오류로 보지 않고 500으로 수렴해야 함', (_desc, exception) => {
      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(500);
    });
  });

  describe('로깅 레벨 분리', () => {
    it('5xx는 error로 기록해야 함', () => {
      filter.catch(new Error('boom'), host);

      expect(Logger.prototype.error).toHaveBeenCalled();
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    it('4xx는 warn으로 기록해야 함 (에러 로그를 클라이언트 실수로 오염시키지 않게)', () => {
      filter.catch(new TestDomainError(), host);

      expect(Logger.prototype.warn).toHaveBeenCalled();
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('Error 인스턴스면 스택을 함께 기록해야 함', () => {
      const error = new Error('boom');

      filter.catch(error, host);

      expect(Logger.prototype.error).toHaveBeenCalledWith(expect.any(String), error.stack);
    });

    it('Error가 아닌 예외는 직렬화해 기록해야 함 — 객체를 그대로 넘기면 Nest Logger가 버린다', () => {
      filter.catch({ reason: 'pool exhausted' }, host);

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('pool exhausted'),
      );
    });
  });
});

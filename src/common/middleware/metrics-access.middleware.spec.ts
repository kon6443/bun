import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { MetricsAccessMiddleware } from './metrics-access.middleware';

type BuildRequestInit = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
};

function buildRequest(init: BuildRequestInit = {}): Request {
  return {
    headers: init.headers ?? {},
    socket: { remoteAddress: init.socket?.remoteAddress },
  } as unknown as Request;
}

describe('MetricsAccessMiddleware', () => {
  let middleware: MetricsAccessMiddleware;
  let next: jest.Mock;
  const res = {} as Response;

  beforeEach(() => {
    middleware = new MetricsAccessMiddleware();
    next = jest.fn();
    jest.spyOn(middleware['logger'], 'warn').mockImplementation(() => undefined);
  });

  describe('허용 (overlay/localhost IP + 프록시 헤더 없음)', () => {
    it.each([
      ['Docker overlay 시작 대역', '10.0.0.1'],
      ['Docker overlay 중간 대역', '10.255.100.50'],
      ['Docker overlay 끝 대역', '10.255.255.254'],
      ['localhost IPv4', '127.0.0.1'],
      ['localhost IPv4 변형', '127.10.20.30'],
      ['localhost IPv6', '::1'],
      ['IPv4-mapped overlay', '::ffff:10.0.0.5'],
      ['IPv4-mapped localhost', '::ffff:127.0.0.1'],
    ])('%s(%s) → next() 호출', (_desc, ip) => {
      const req = buildRequest({ socket: { remoteAddress: ip } });

      expect(() => middleware.use(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('차단 — 프록시 헤더 존재 (overlay IP여도)', () => {
    it.each([
      ['XFF 단일', { 'x-forwarded-for': '203.0.113.5' }],
      ['XFF 체인', { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }],
      ['X-Real-IP', { 'x-real-ip': '203.0.113.5' }],
      [
        'XFF + X-Real-IP',
        { 'x-forwarded-for': '203.0.113.5', 'x-real-ip': '10.0.0.1' },
      ],
      ['XFF 배열 (Express 파싱)', { 'x-forwarded-for': ['203.0.113.5', '10.0.0.1'] }],
    ])('%s → ForbiddenException', (_desc, headers) => {
      const req = buildRequest({
        headers,
        socket: { remoteAddress: '10.0.0.1' },
      });

      expect(() => middleware.use(req, res, next)).toThrow(ForbiddenException);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('차단 — 비허용 IP', () => {
    it.each([
      ['외부 IPv4', '203.0.113.5'],
      ['사설 대역 172.16.x (Swarm overlay 아님)', '172.16.0.1'],
      ['사설 대역 192.168.x', '192.168.1.1'],
      ['외부 IPv6', '2001:db8::1'],
      ['IPv4-mapped 외부', '::ffff:203.0.113.5'],
      ['::1 prefix 다른 IPv6', '::1234:abcd'],
      ['1로 시작하는 공인 IPv4', '1.2.3.4'],
      ['빈 문자열', ''],
      ['옥텟 4자리 (잘못된 포맷)', '10.1234.5.6'],
    ])('%s(%s) → ForbiddenException', (_desc, ip) => {
      const req = buildRequest({ socket: { remoteAddress: ip } });

      expect(() => middleware.use(req, res, next)).toThrow(ForbiddenException);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('에지 케이스', () => {
    it('remoteAddress가 undefined → 차단', () => {
      const req = buildRequest({ socket: {} });

      expect(() => middleware.use(req, res, next)).toThrow(ForbiddenException);
      expect(next).not.toHaveBeenCalled();
    });

    it('XFF 빈 문자열은 헤더 없는 것으로 취급 → overlay IP면 허용', () => {
      const req = buildRequest({
        headers: { 'x-forwarded-for': '' },
        socket: { remoteAddress: '10.0.0.1' },
      });

      expect(() => middleware.use(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('허용 IP + 프록시 헤더 동시 존재 → 헤더 우선 차단', () => {
      const req = buildRequest({
        headers: { 'x-real-ip': '10.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' },
      });

      expect(() => middleware.use(req, res, next)).toThrow(ForbiddenException);
      expect(next).not.toHaveBeenCalled();
    });
  });
});

import {
  ForbiddenException,
  Injectable,
  Logger,
  NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * /metrics 엔드포인트 접근 제한 미들웨어 (3중 방어의 2~3번째).
 *
 * 방어 계층:
 *  1차: Caddy — /api/v1/metrics 경로 외부 요청 404 응답 (Caddyfile).
 *  2차: XFF / X-Real-IP 헤더 존재 시 즉시 차단 — 외부 요청은 Caddy가 XFF를
 *       반드시 주입하므로, overlay 내부 Prometheus 요청에는 XFF가 없음.
 *  3차: req.socket.remoteAddress — TCP 실제 연결 IP가 Swarm overlay / localhost
 *       대역인지 검증.
 *
 * 두 검사(XFF + IP)를 모두 요구하는 이유:
 *  - XFF 단독: overlay 내부 악의적 컨테이너가 XFF 없이 접근 가능.
 *  - IP 단독: Caddy 우회 시 외부 IP만 차단 → XFF 누락 탐지 실패.
 *  - 조합: "XFF 없음 + overlay/localhost IP" 통과 → Prometheus만 허용.
 */
@Injectable()
export class MetricsAccessMiddleware implements NestMiddleware {
  // 허용 대역:
  //  - Docker Swarm overlay: 10.0.0.0/8
  //  - Localhost: 127.0.0.0/8, ::1
  //  - IPv4-mapped IPv6: ::ffff:10.x, ::ffff:127.x
  // 엄격 매칭: IPv6 ::1은 정확히 일치, IPv4 대역은 옥텟 경계 구분.
  private static readonly ALLOWED_IP_REGEX =
    /^(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3}|::ffff:10(?:\.\d{1,3}){3})$/;

  private readonly logger = new Logger(MetricsAccessMiddleware.name);

  use(req: Request, _res: Response, next: NextFunction): void {
    const xff = req.headers['x-forwarded-for'];
    const xRealIp = req.headers['x-real-ip'];

    if (xff || xRealIp) {
      this.logger.warn(
        `metrics access denied (proxy headers): xff=${this.formatHeader(xff)} xRealIp=${this.formatHeader(xRealIp)} remoteIp=${req.socket.remoteAddress ?? '-'}`,
      );
      throw new ForbiddenException('Forbidden');
    }

    const remoteIp = req.socket.remoteAddress ?? '';

    if (!MetricsAccessMiddleware.ALLOWED_IP_REGEX.test(remoteIp)) {
      this.logger.warn(
        `metrics access denied (remote ip not allowed): remoteIp=${remoteIp || '-'} userAgent=${this.formatHeader(req.headers['user-agent'])}`,
      );
      throw new ForbiddenException('Forbidden');
    }

    next();
  }

  private formatHeader(value: string | string[] | undefined): string {
    if (value === undefined) return '-';
    return Array.isArray(value) ? value.join(',') : value;
  }
}

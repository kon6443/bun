import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { JwtPayload, verify } from 'jsonwebtoken';
import { extractHttpAccessToken } from '../utils/access-token.utils';
import { ApiTooManyRequestsErrorResponseDto } from '../dto/api-error.dto';

/**
 * 커스텀 ThrottlerGuard (APP_GUARD로 전역 등록)
 *
 * 글로벌 설정: 초당 5회(short) + 분당 60회(long). 카운터는 Redis 공유(`RedisThrottlerStorage`).
 * 식별 방식:
 *   - 로그인 유저: `user-{userId}` — 같은 와이파이·통신사 공인 IP 뒤의 다른 사용자와 한도를 나누지 않는다
 *   - 비로그인(토큰 없음·무효): `req.ip`
 *
 * 전역 가드는 라우트의 `@UseGuards(JwtAuthGuard)`보다 **먼저** 실행돼 `request.user`가 아직 없다.
 * 그래서 여기서 토큰 **서명만** 직접 검증해 userId를 얻는다(DB 조회 없음 — 탈퇴 여부는 이후 JwtAuthGuard가 본다).
 *
 * `req.ip`는 `main.ts`의 `trust proxy 1`에 따라 **바로 앞 프록시가 붙인** X-Forwarded-For 값이다
 * (브라우저 → Caddy, 또는 브라우저 → Caddy → Next 서버가 넘긴 사용자 IP).
 * X-Forwarded-For의 **첫 값**은 요청자가 임의로 넣을 수 있어 키로 쓰지 않는다.
 *
 * 엔드포인트별 오버라이드: @Throttle(), @SkipThrottle() 데코레이터
 */
@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = this.resolveUserId(req);
    if (userId !== null) {
      return `user-${userId}`;
    }

    return (req['ip'] as string) || 'unknown';
  }

  /**
   * 한도 초과 — 라이브러리 기본(ThrottlerException, message "ThrottlerException: Too Many Requests")이 그대로 응답에 실려
   * 화면에 영어 원문이 보였다(game-settings D-002). Swagger 명세와 같은 도메인 오류(한국어 message)를 던진다.
   * Retry-After 등 헤더는 부모가 이 호출 전에 이미 붙였다
   */
  protected async throwThrottlingException(): Promise<void> {
    throw new ApiTooManyRequestsErrorResponseDto();
  }

  /** 유효한 액세스 토큰의 sub(userId). 토큰이 없거나 서명·만료 검증에 실패하면 null */
  private resolveUserId(req: Record<string, unknown>): number | null {
    const token = extractHttpAccessToken(
      req as { cookies?: Record<string, unknown>; headers?: Record<string, unknown> },
    );
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!token || !secret) {
      return null;
    }

    try {
      const payload = verify(token, secret) as JwtPayload & { sub?: number };
      return typeof payload.sub === 'number' ? payload.sub : null;
    } catch {
      return null;
    }
  }
}

import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * 커스텀 ThrottlerGuard (APP_GUARD로 전역 등록)
 *
 * 글로벌 설정: 초당 5회(short) + 분당 60회(long)
 * 식별 방식:
 *   - 로그인 유저: userId 기반 카운트 (JwtAuthGuard가 request.user 설정)
 *   - 비로그인 유저: IP 기반 카운트 (X-Forwarded-For 우선)
 *
 * 엔드포인트별 오버라이드: @Throttle(), @SkipThrottle() 데코레이터
 */
@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    // JwtAuthGuard가 설정한 request.user가 있으면 userId 사용
    const user = req['user'] as { userId?: number } | undefined;
    if (user?.userId) {
      return `user-${user.userId}`;
    }

    // 비로그인: X-Forwarded-For 헤더 우선, 없으면 IP
    const forwarded = req['headers'] as Record<string, string> | undefined;
    const forwardedFor = forwarded?.['x-forwarded-for'];
    if (forwardedFor) {
      return forwardedFor.split(',')[0].trim();
    }

    return (req['ip'] as string) || 'unknown';
  }
}

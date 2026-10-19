/**
 * HTTP 요청에서 액세스 토큰을 꺼낸다 — Cookie(`access_token`) 우선, 없으면 `Authorization: Bearer`.
 *
 * `JwtAuthGuard`(인증)와 `CustomThrottlerGuard`(스로틀 키)가 **같은 규칙**으로 토큰을 찾아야
 * "인증된 그 사용자"로 카운트된다. 두 곳이 따로 구현하면 우선순위가 어긋날 수 있어 여기 한 곳에 둔다.
 */
export function extractHttpAccessToken(request: {
  cookies?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}): string | null {
  const cookieToken = request.cookies?.['access_token'];
  if (cookieToken && typeof cookieToken === 'string') {
    return cookieToken;
  }

  const authHeader = request.headers?.['authorization'];
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

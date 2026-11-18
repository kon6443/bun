import { JwtPayload, verify } from 'jsonwebtoken';

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

/** 우리 서버가 발급한 액세스 토큰의 페이로드 — 가드·스로틀이 같은 타입을 쓴다 */
export type AccessTokenPayload = JwtPayload & {
  sub: number;
  loginType?: string;
};

/**
 * 서명 검증 결과 — 실패 사유만 돌려주고 에러 모양(HTTP DTO·WsException·게스트 폴백)은 호출자가 정한다.
 * - NO_SECRET: 서버에 JWT_SECRET이 없다
 * - INVALID: 서명·만료 검증 실패
 * - NO_SUBJECT: 서명은 맞는데 sub가 없다
 */
export type AccessTokenVerification =
  | { ok: true; payload: AccessTokenPayload }
  | { ok: false; reason: 'NO_SECRET' | 'INVALID' | 'NO_SUBJECT' };

/**
 * 액세스 토큰 서명 검증 — HTTP·WS 가드, 게임 소켓, 스로틀 키가 **같은 규칙**으로 판정하도록 한 곳에 둔다
 * (인증 규칙을 바꿀 때 한 곳을 빠뜨리지 않게 — playbook 클러스터 1)
 */
export function verifyAccessToken(token: string, secret: string | undefined): AccessTokenVerification {
  if (!secret) return { ok: false, reason: 'NO_SECRET' };
  let decoded: string | JwtPayload;
  try {
    decoded = verify(token, secret);
  } catch {
    return { ok: false, reason: 'INVALID' };
  }
  if (typeof decoded !== 'object' || !decoded.sub) return { ok: false, reason: 'NO_SUBJECT' };
  return { ok: true, payload: decoded as AccessTokenPayload };
}

/**
 * 소켓 handshake에서 액세스 토큰을 꺼낸다 — `handshake.auth.token` 우선, 없으면 `Authorization: Bearer`.
 * /teams·/fishing·게임 대전 소켓이 같은 규칙을 쓴다 (HTTP는 extractHttpAccessToken)
 */
export function extractSocketAccessToken(client: {
  handshake: { auth?: Record<string, unknown>; headers?: Record<string, unknown> };
}): string | null {
  const authToken = client.handshake.auth?.token;
  if (authToken && typeof authToken === 'string') {
    return authToken;
  }

  const authHeader = client.handshake.headers?.['authorization'];
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

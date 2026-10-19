import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';
import { sign } from 'jsonwebtoken';
import { CustomThrottlerGuard } from './custom-throttler.guard';

const SECRET = 'test-jwt-secret';

/**
 * 스로틀 키 — 사용자별로 갈라져야 한도가 사용자 단위로 걸린다.
 *  - 로그인 사용자: 토큰 서명을 검증해 `user-{id}` (전역 가드라 request.user가 아직 없다)
 *  - 그 외: `trust proxy 1`이 해석한 `req.ip` — X-Forwarded-For 첫 값은 위조 가능하므로 쓰지 않는다
 */
describe('CustomThrottlerGuard.getTracker', () => {
  const guard = new CustomThrottlerGuard(
    { throttlers: [] },
    {} as ThrottlerStorage,
    new Reflector(),
    { get: (key: string) => (key === 'JWT_SECRET' ? SECRET : undefined) } as ConfigService,
  );
  const getTracker = (req: Record<string, unknown>) =>
    (guard as unknown as { getTracker: (r: Record<string, unknown>) => Promise<string> }).getTracker(req);
  const token = (sub: number, secret = SECRET) => sign({ sub, loginType: 'KAKAO' }, secret, { expiresIn: '1h' });

  it('쿠키 토큰이 유효하면 userId로 센다 (같은 IP의 다른 사용자와 분리)', async () => {
    const req = { ip: '203.0.113.7', cookies: { access_token: token(42) }, headers: {} };

    await expect(getTracker(req)).resolves.toBe('user-42');
  });

  it('Bearer 토큰도 같은 규칙으로 userId', async () => {
    const req = { ip: '203.0.113.7', headers: { authorization: `Bearer ${token(7)}` } };

    await expect(getTracker(req)).resolves.toBe('user-7');
  });

  it('서명이 틀린 토큰은 IP로 센다 (위조 토큰으로 남의 한도를 쓰지 못하게)', async () => {
    const req = { ip: '203.0.113.7', cookies: { access_token: token(42, 'other-secret') }, headers: {} };

    await expect(getTracker(req)).resolves.toBe('203.0.113.7');
  });

  it('만료된 토큰은 IP로 센다', async () => {
    const expired = sign({ sub: 42, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
    const req = { ip: '203.0.113.7', cookies: { access_token: expired }, headers: {} };

    await expect(getTracker(req)).resolves.toBe('203.0.113.7');
  });

  it('비로그인은 req.ip로 센다', async () => {
    await expect(getTracker({ ip: '203.0.113.7', headers: {} })).resolves.toBe('203.0.113.7');
  });

  it('X-Forwarded-For 첫 값을 위조해도 키가 바뀌지 않아야 함', async () => {
    const req = { ip: '203.0.113.7', headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' } };

    // 이전 구현은 첫 값(1.2.3.4)을 키로 써서 요청마다 바꾸면 한도를 우회할 수 있었다
    await expect(getTracker(req)).resolves.toBe('203.0.113.7');
  });

  it('ip가 없으면 unknown', async () => {
    await expect(getTracker({ headers: {} })).resolves.toBe('unknown');
  });
});

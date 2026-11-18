import { sign } from 'jsonwebtoken';
import { extractHttpAccessToken, extractSocketAccessToken, verifyAccessToken } from './access-token.utils';

const SECRET = 'test-secret';

/**
 * 가드 5곳(HTTP·Optional·Viewer, /teams WS, /fishing, 게임 대전 소켓, 스로틀 키)이 이 판정을 공유한다 —
 * 실패 사유가 바뀌면 각 가드의 에러 메시지·게스트 폴백이 함께 바뀐다
 */
describe('verifyAccessToken', () => {
  it('유효한 토큰이면 페이로드를 돌려준다', () => {
    const result = verifyAccessToken(sign({ sub: 43, loginType: 'kakao' }, SECRET), SECRET);
    expect(result).toEqual({ ok: true, payload: expect.objectContaining({ sub: 43, loginType: 'kakao' }) });
  });

  it('JWT_SECRET이 없으면 NO_SECRET — 검증을 시도하지 않는다', () => {
    expect(verifyAccessToken(sign({ sub: 43 }, SECRET), undefined)).toEqual({ ok: false, reason: 'NO_SECRET' });
  });

  it.each([
    ['다른 비밀키로 서명', () => sign({ sub: 43 }, 'other')],
    ['만료', () => sign({ sub: 43 }, SECRET, { expiresIn: -10 })],
    ['토큰 형식 아님', () => 'not-a-jwt'],
  ])('%s이면 INVALID', (_desc, make) => {
    expect(verifyAccessToken(make(), SECRET)).toEqual({ ok: false, reason: 'INVALID' });
  });

  it.each([
    ['sub 없음', () => sign({ loginType: 'kakao' }, SECRET)],
    ['문자열 페이로드', () => sign('plain', SECRET)],
  ])('%s이면 NO_SUBJECT', (_desc, make) => {
    expect(verifyAccessToken(make(), SECRET)).toEqual({ ok: false, reason: 'NO_SUBJECT' });
  });
});

describe('extractSocketAccessToken', () => {
  it('handshake.auth.token을 Bearer 헤더보다 먼저 쓴다', () => {
    expect(
      extractSocketAccessToken({ handshake: { auth: { token: 'from-auth' }, headers: { authorization: 'Bearer from-header' } } }),
    ).toBe('from-auth');
  });

  it('auth.token이 없으면 Bearer 헤더', () => {
    expect(extractSocketAccessToken({ handshake: { auth: {}, headers: { authorization: 'Bearer from-header' } } })).toBe('from-header');
  });

  it.each([
    ['아무것도 없음', { auth: {}, headers: {} }],
    ['Bearer 접두가 아님', { auth: {}, headers: { authorization: 'Basic abc' } }],
    ['auth.token이 문자열이 아님', { auth: { token: 123 }, headers: {} }],
  ])('%s이면 null', (_desc, handshake) => {
    expect(extractSocketAccessToken({ handshake })).toBeNull();
  });
});

describe('extractHttpAccessToken', () => {
  it('쿠키를 Bearer 헤더보다 먼저 쓴다', () => {
    expect(extractHttpAccessToken({ cookies: { access_token: 'cookie' }, headers: { authorization: 'Bearer header' } })).toBe('cookie');
  });
});

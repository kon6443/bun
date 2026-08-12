import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { verify, JwtPayload } from 'jsonwebtoken';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { UsersController } from '../src/modules/users/users.controller';
import { UsersService } from '../src/modules/users/users.service';
import { User } from '../src/entities/User';
import { createUser } from '../src/entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../src/common/__spec__/mock-repository';
import { createE2eApp, E2eApp } from './helpers/e2e-app';

const JWT_SECRET = 'e2e-test-secret';
const KAKAO_ID = '987654321';
const KAKAO_TOKEN = 'kakao-access-token';

/**
 * 로그인 플로우를 HTTP 경계에서 검증한다.
 *
 * 여기서만 확인할 수 있는 것이 하나 있다 — **발급한 토큰이 실제로 가드를 통과하는가.**
 * `auth.service.spec.ts`는 토큰의 payload를 검사하고 `jwt-auth.guard.spec.ts`는 가드 로직을
 * 검사하지만, 둘이 맞물리는지는 아무도 확인하지 않았다. 발급 쪽이 `sub`를 빼거나 서명 비밀을
 * 다르게 쓰면 **로그인은 성공하는데 그 토큰으로 아무것도 못 하는** 상태가 되고,
 * 단위 테스트는 양쪽 다 통과한다.
 *
 * 그래서 이 스펙만 `useRealAuthGuard: true`로 진짜 가드를 태운다.
 */
describe('E2E 인증 (카카오 로그인)', () => {
  let e2e: E2eApp;
  let app: INestApplication;
  let userRepository: MockRepository<User>;
  let fetchMock: jest.SpyInstance;

  /** 카카오 사용자 조회 API 응답 고정 */
  const mockKakaoApi = (ok = true, body: unknown = { id: Number(KAKAO_ID) }) =>
    (fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok,
      status: ok ? 200 : 401,
      json: jest.fn().mockResolvedValue(body),
    } as unknown as Response));

  beforeEach(async () => {
    userRepository = createMockRepository<User>();
    mockKakaoApi();

    e2e = await createE2eApp({
      controllers: [AuthController, UsersController],
      useRealAuthGuard: true,
      providers: [
        AuthService,
        UsersService,
        { provide: getRepositoryToken(User), useValue: userRepository },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((k: string) => (k === 'JWT_SECRET' ? JWT_SECRET : undefined)) },
        },
      ],
    });
    app = e2e.app;
  });

  afterEach(async () => {
    await app.close();
  });

  const login = (body: Record<string, unknown> = { accessToken: KAKAO_TOKEN }) =>
    request(app.getHttpServer()).post(e2e.url('/auth/kakao')).send(body);

  describe('신규 가입', () => {
    beforeEach(() => {
      // 카카오 ID로 조회했을 때 기존 유저가 없는 상태 (getUserBy는 find({where})를 쓴다)
      userRepository.find.mockResolvedValue([]);
      userRepository.create.mockImplementation((d) => d as User);
      userRepository.save.mockResolvedValue(createUser({ userId: 100, userName: null }));
    });

    it('카카오 토큰으로 가입하고 JWT를 반환해야 함', async () => {
      const res = await login({ accessToken: KAKAO_TOKEN, kakaoNickname: '신규유저' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        code: 'SUCCESS',
        data: {
          userId: 100,
          userName: '신규유저',
          loginType: 'KAKAO',
          tokenType: 'Bearer',
          accessToken: expect.any(String),
        },
      });
    });

    it('닉네임이 없으면 기본 표시명을 만들어야 함', async () => {
      const res = await login({ accessToken: KAKAO_TOKEN });

      expect(res.body.data.userName).toBe('사용자100');
    });
  });

  describe('기존 사용자 로그인', () => {
    beforeEach(() => {
      userRepository.find.mockResolvedValue([
        createUser({ userId: 42, userName: '기존유저', kakaoId: KAKAO_ID }),
      ]);
    });

    it('가입 없이 기존 userId로 로그인해야 함', async () => {
      const res = await login();

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ userId: 42, userName: '기존유저' });
      // 이미 있는 사용자를 또 만들면 중복 계정이 생긴다
      expect(userRepository.save).not.toHaveBeenCalled();
    });

    it('발급된 토큰에 가드가 요구하는 sub가 들어 있어야 함', async () => {
      const res = await login();

      const payload = verify(res.body.data.accessToken as string, JWT_SECRET) as JwtPayload;
      // JwtAuthGuard는 payload.sub이 없으면 차단한다(초대 토큰으로 인증 우회 방지) —
      // 발급 쪽이 sub를 빼면 로그인은 되는데 아무 API도 못 쓰는 상태가 된다
      expect(payload.sub).toBe(42);
      expect(payload.loginType).toBe('KAKAO');
    });

    /**
     * 이 스펙의 핵심 — 발급과 검증이 실제로 맞물리는지.
     * 단위 테스트는 양쪽을 따로 보므로 이 조합은 여기서만 확인된다.
     */
    it('발급된 토큰으로 보호된 API에 접근할 수 있어야 함', async () => {
      const loginRes = await login();
      const token = loginRes.body.data.accessToken as string;
      // 가드가 토큰의 sub로 활성 유저를 조회한다
      userRepository.findOne.mockResolvedValue(createUser({ userId: 42, userName: '기존유저' }));

      const res = await request(app.getHttpServer())
        .get(e2e.url('/users/me'))
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });

    it('토큰 없이 보호된 API에 접근하면 401이어야 함', async () => {
      const res = await request(app.getHttpServer()).get(e2e.url('/users/me'));

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: expect.stringContaining('AUTH_') });
    });

    it('위조된 토큰은 거부해야 함', async () => {
      const res = await request(app.getHttpServer())
        .get(e2e.url('/users/me'))
        .set('Authorization', 'Bearer forged.token.value');

      expect(res.status).toBe(401);
    });
  });

  describe('실패 경로', () => {
    it('카카오 토큰이 없으면 검증 단계에서 거부해야 함', async () => {
      const res = await login({});

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      // 카카오 API를 부르기도 전에 막혀야 한다
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('카카오가 토큰을 거부하면 502여야 함', async () => {
      mockKakaoApi(false);

      const res = await login();

      // 우리 서버 문제가 아니라 외부 인증 실패임을 구분해 알린다
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ code: 'AUTH_KAKAO_API_ERROR' });
    });

    it('허용되지 않은 필드를 보내면 거부해야 함', async () => {
      const res = await login({ accessToken: KAKAO_TOKEN, isAdmin: true });

      // 권한 필드를 실어 보내는 시도가 파이프에서 막힌다
      expect(res.status).toBe(422);
    });
  });
});

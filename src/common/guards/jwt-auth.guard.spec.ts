import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { sign } from 'jsonwebtoken';
import { JwtAuthGuard } from './jwt-auth.guard';
import { User } from '../../entities/User';
import { createUser } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../__spec__/mock-repository';
import {
  AuthUnauthorizedErrorResponseDto,
  AuthInvalidTokenErrorResponseDto,
} from '../../modules/auth/auth-error.dto';

const SECRET = 'test-jwt-secret';

/** 실제 서명된 액세스 토큰 — verify를 모킹하지 않고 진짜 검증 경로를 통과시킨다. */
const signAccessToken = (
  payload: Record<string, unknown> = { sub: 1, loginType: 'KAKAO' },
  expiresIn: string | number = '1h',
) => sign(payload, SECRET, { expiresIn } as never);

const buildContext = (request: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as ExecutionContext;

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let userRepository: MockRepository<User>;

  beforeEach(async () => {
    userRepository = createMockRepository<User>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        { provide: ConfigService, useValue: { get: jest.fn(() => SECRET) } },
        { provide: getRepositoryToken(User), useValue: userRepository },
      ],
    }).compile();

    guard = module.get(JwtAuthGuard);
  });

  describe('토큰 추출 — cookie 우선, Bearer 헤더 보조', () => {
    it('cookie의 access_token으로 인증되어야 함', async () => {
      const user = createUser();
      userRepository.findOne.mockResolvedValue(user);
      const request = { cookies: { access_token: signAccessToken() }, headers: {} };

      await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
    });

    it('cookie가 없으면 Authorization Bearer 헤더로 폴백해야 함', async () => {
      userRepository.findOne.mockResolvedValue(createUser());
      const request = { cookies: {}, headers: { authorization: `Bearer ${signAccessToken()}` } };

      await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
    });

    it('cookie와 헤더에 서로 다른 토큰이 있으면 cookie를 우선해야 함', async () => {
      userRepository.findOne.mockResolvedValue(createUser({ userId: 7 }));
      const request = {
        cookies: { access_token: signAccessToken({ sub: 7 }) },
        headers: { authorization: `Bearer ${signAccessToken({ sub: 99 })}` },
      };

      await guard.canActivate(buildContext(request));

      // cookie의 sub(7)로 조회했다면 cookie 우선이 지켜진 것
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { userId: 7, isActivated: 1 },
      });
    });

    it.each([
      ['cookie·헤더 모두 없음', { cookies: {}, headers: {} }],
      ['cookies 자체가 undefined', { headers: {} }],
      ['Bearer 접두사 없는 헤더', { cookies: {}, headers: { authorization: 'abc.def.ghi' } }],
      ['헤더가 문자열이 아님(배열)', { cookies: {}, headers: { authorization: ['Bearer x'] } }],
    ])('%s → AuthUnauthorizedErrorResponseDto', async (_desc, request) => {
      await expect(guard.canActivate(buildContext(request))).rejects.toThrow(
        AuthUnauthorizedErrorResponseDto,
      );
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('토큰 검증', () => {
    it('서명이 다른 토큰은 차단해야 함', async () => {
      const forged = sign({ sub: 1 }, 'wrong-secret', { expiresIn: '1h' });
      const request = { cookies: { access_token: forged }, headers: {} };

      await expect(guard.canActivate(buildContext(request))).rejects.toThrow(
        AuthInvalidTokenErrorResponseDto,
      );
    });

    it('만료된 토큰은 차단해야 함', async () => {
      const expired = sign({ sub: 1 }, SECRET, { expiresIn: -10 });
      const request = { cookies: { access_token: expired }, headers: {} };

      await expect(guard.canActivate(buildContext(request))).rejects.toThrow(
        AuthInvalidTokenErrorResponseDto,
      );
    });

    /**
     * 회귀 방어: 초대 토큰(payload = {teamId, userId, jti})은 같은 JWT_SECRET으로
     * 서명되므로 서명 검증만으로는 통과한다. sub 필수 검증이 유일한 방어선이다.
     * 이 테스트가 깨지면 초대 링크를 가진 사람이 그 userId로 인증될 수 있다.
     */
    it('sub이 없는 토큰(초대 토큰 등)은 서명이 유효해도 차단해야 함', async () => {
      const inviteToken = signAccessToken({ teamId: 1, userId: 2, jti: 'abc' });
      const request = { cookies: { access_token: inviteToken }, headers: {} };

      await expect(guard.canActivate(buildContext(request))).rejects.toThrow(
        AuthInvalidTokenErrorResponseDto,
      );
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });

    it('JWT_SECRET이 설정되지 않으면 차단해야 함', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          JwtAuthGuard,
          { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
          { provide: getRepositoryToken(User), useValue: userRepository },
        ],
      }).compile();
      const guardWithoutSecret = module.get(JwtAuthGuard);
      const request = { cookies: { access_token: signAccessToken() }, headers: {} };

      await expect(
        guardWithoutSecret.canActivate(buildContext(request)),
      ).rejects.toThrow(AuthInvalidTokenErrorResponseDto);
    });
  });

  describe('사용자 조회', () => {
    it('활성 사용자만 조회해야 함 (isActivated: 1 조건 포함)', async () => {
      userRepository.findOne.mockResolvedValue(createUser({ userId: 42 }));
      const request = { cookies: { access_token: signAccessToken({ sub: 42 }) }, headers: {} };

      await guard.canActivate(buildContext(request));

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { userId: 42, isActivated: 1 },
      });
    });

    it('토큰은 유효하지만 사용자가 없으면 차단해야 함 (탈퇴·비활성)', async () => {
      userRepository.findOne.mockResolvedValue(null);
      const request = { cookies: { access_token: signAccessToken() }, headers: {} };

      await expect(guard.canActivate(buildContext(request))).rejects.toThrow(
        AuthUnauthorizedErrorResponseDto,
      );
    });

    it('인증 성공 시 request.user에 조회된 사용자를 주입해야 함', async () => {
      const user = createUser({ userId: 1, userName: '홍길동' });
      userRepository.findOne.mockResolvedValue(user);
      const request: { cookies: { access_token: string }; headers: object; user?: User } = {
        cookies: { access_token: signAccessToken() },
        headers: {},
      };

      await guard.canActivate(buildContext(request));

      // @CurrentUser() 데코레이터가 이 값을 읽는다 — 주입이 빠지면 컨트롤러가 undefined를 받는다
      expect(request.user).toBe(user);
    });
  });
});

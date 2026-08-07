import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { sign } from 'jsonwebtoken';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { User } from '../../entities/User';
import { createUser } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../__spec__/mock-repository';
import { AuthInvalidTokenErrorResponseDto } from '../../modules/auth/auth-error.dto';

const SECRET = 'test-jwt-secret';

const buildContext = (request: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as ExecutionContext;

/**
 * OptionalJwtAuthGuard의 계약은 "토큰이 없으면 익명 통과, 있으면 엄격 검증"이다.
 * 두 번째 절반이 무너지면 잘못된 토큰이 익명으로 취급되어 조용히 통과하므로
 * 양쪽 분기를 모두 고정한다.
 */
describe('OptionalJwtAuthGuard', () => {
  let guard: OptionalJwtAuthGuard;
  let userRepository: MockRepository<User>;

  beforeEach(async () => {
    userRepository = createMockRepository<User>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OptionalJwtAuthGuard,
        { provide: ConfigService, useValue: { get: jest.fn(() => SECRET) } },
        { provide: getRepositoryToken(User), useValue: userRepository },
      ],
    }).compile();

    guard = module.get(OptionalJwtAuthGuard);
  });

  describe('토큰 없음 → 익명 통과', () => {
    it.each([
      ['cookie·헤더 모두 없음', { cookies: {}, headers: {} }],
      ['cookies 자체가 undefined', { headers: {} }],
      ['Bearer 접두사 없는 헤더', { cookies: {}, headers: { authorization: 'abc' } }],
    ])('%s → true, DB 조회 없음', async (_desc, request) => {
      await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });

    it('익명 통과 시 request.user를 주입하지 않아야 함', async () => {
      const request: { cookies: object; headers: object; user?: User } = {
        cookies: {},
        headers: {},
      };

      await guard.canActivate(buildContext(request));

      expect(request.user).toBeUndefined();
    });
  });

  describe('토큰 있음 → 부모 가드의 엄격 검증 적용', () => {
    it('유효한 토큰이면 user를 주입하고 통과해야 함', async () => {
      const user = createUser({ userId: 5 });
      userRepository.findOne.mockResolvedValue(user);
      const request: { cookies: { access_token: string }; headers: object; user?: User } = {
        cookies: { access_token: sign({ sub: 5 }, SECRET, { expiresIn: '1h' }) },
        headers: {},
      };

      await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
      expect(request.user).toBe(user);
    });

    // 여기서 true를 반환하면 "잘못된 토큰 = 익명"이 되어 검증이 무의미해진다
    it('위조된 토큰은 익명 통과가 아니라 차단해야 함', async () => {
      const request = {
        cookies: { access_token: sign({ sub: 1 }, 'wrong-secret', { expiresIn: '1h' }) },
        headers: {},
      };

      await expect(guard.canActivate(buildContext(request))).rejects.toThrow(
        AuthInvalidTokenErrorResponseDto,
      );
    });

    it('sub이 없는 토큰은 차단해야 함', async () => {
      const request = {
        cookies: { access_token: sign({ teamId: 1, userId: 2 }, SECRET, { expiresIn: '1h' }) },
        headers: {},
      };

      await expect(guard.canActivate(buildContext(request))).rejects.toThrow(
        AuthInvalidTokenErrorResponseDto,
      );
    });
  });
});

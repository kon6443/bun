import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { sign } from 'jsonwebtoken';
import { ViewerJwtAuthGuard } from './viewer-jwt-auth.guard';
import { User } from '../../entities/User';
import { createUser } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../__spec__/mock-repository';

const SECRET = 'test-jwt-secret';

const buildContext = (request: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as ExecutionContext;

type TestRequest = { cookies: Record<string, string>; headers: Record<string, string>; user?: User };

/**
 * ViewerJwtAuthGuard의 계약은 "유효한 토큰이면 사용자 주입, 그 외 인증 실패는 비로그인 통과, 인증 외 오류는 그대로"다.
 * 공개 조회에 붙으므로 인증 실패가 401로 새면 목록 자체가 막힌다.
 */
describe('ViewerJwtAuthGuard', () => {
  let guard: ViewerJwtAuthGuard;
  let userRepository: MockRepository<User>;

  beforeEach(async () => {
    userRepository = createMockRepository<User>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ViewerJwtAuthGuard,
        { provide: ConfigService, useValue: { get: jest.fn(() => SECRET) } },
        { provide: getRepositoryToken(User), useValue: userRepository },
      ],
    }).compile();

    guard = module.get(ViewerJwtAuthGuard);
  });

  it('유효한 토큰 → 사용자를 주입한다', async () => {
    const user = createUser({ userId: 7 });
    userRepository.findOne.mockResolvedValue(user);
    const request: TestRequest = { cookies: {}, headers: { authorization: `Bearer ${sign({ sub: 7 }, SECRET)}` } };

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(request.user).toBe(user);
  });

  it.each([
    ['토큰 없음', { cookies: {}, headers: {} }],
    ['서명이 다른 토큰', { cookies: {}, headers: { authorization: `Bearer ${sign({ sub: 7 }, 'other-secret')}` } }],
    ['만료된 토큰', { cookies: { access_token: sign({ sub: 7, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET) }, headers: {} }],
  ])('%s → 비로그인 통과, 사용자 없음', async (_desc, request: TestRequest) => {
    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(request.user).toBeUndefined();
  });

  it('없는·비활성 사용자의 토큰 → 비로그인 통과', async () => {
    userRepository.findOne.mockResolvedValue(null);
    const request: TestRequest = { cookies: {}, headers: { authorization: `Bearer ${sign({ sub: 7 }, SECRET)}` } };

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(request.user).toBeUndefined();
  });

  it('인증 외 오류(DB 장애)는 삼키지 않는다', async () => {
    userRepository.findOne.mockRejectedValue(new Error('ORA-03113'));
    const request: TestRequest = { cookies: {}, headers: { authorization: `Bearer ${sign({ sub: 7 }, SECRET)}` } };

    await expect(guard.canActivate(buildContext(request))).rejects.toThrow('ORA-03113');
  });
});

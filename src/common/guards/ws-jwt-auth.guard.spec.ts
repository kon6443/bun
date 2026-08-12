import { ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WsException } from '@nestjs/websockets';
import { sign } from 'jsonwebtoken';
import { WsJwtGuard, AuthenticatedSocket } from './ws-jwt-auth.guard';
import { User } from '../../entities/User';
import { createUser } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../__spec__/mock-repository';

const SECRET = 'test-jwt-secret';

const signToken = (payload: Record<string, unknown> = { sub: 1 }) =>
  sign(payload, SECRET, { expiresIn: '1h' });

const buildClient = (handshake: Record<string, unknown>) =>
  ({ id: 'socket-1', handshake, data: {} }) as unknown as AuthenticatedSocket;

const buildContext = (client: AuthenticatedSocket): ExecutionContext =>
  ({
    switchToWs: () => ({ getClient: () => client }),
  }) as ExecutionContext;

/**
 * WS 가드는 HTTP 가드와 검증 로직이 같지만 **별도 구현**이다.
 * 한쪽만 고치는 실수를 막기 위해 sub 필수 검증 등 핵심 계약을 양쪽 모두에 고정한다.
 * 실패는 예외 타입이 아니라 WsException의 code로 구분되므로 code까지 검증한다.
 */
describe('WsJwtGuard', () => {
  let guard: WsJwtGuard;
  let userRepository: MockRepository<User>;

  beforeEach(async () => {
    userRepository = createMockRepository<User>();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WsJwtGuard,
        { provide: ConfigService, useValue: { get: jest.fn(() => SECRET) } },
        { provide: getRepositoryToken(User), useValue: userRepository },
      ],
    }).compile();

    guard = module.get(WsJwtGuard);
  });

  afterEach(() => jest.restoreAllMocks());

  /** WsException의 payload에서 code를 꺼낸다 */
  const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
      throw new Error('예외가 발생하지 않았습니다');
    } catch (error) {
      expect(error).toBeInstanceOf(WsException);
      return ((error as WsException).getError() as { code: string }).code;
    }
  };

  describe('토큰 추출 — handshake.auth.token 우선, Bearer 헤더 보조', () => {
    it('handshake.auth.token으로 인증되어야 함', async () => {
      userRepository.findOne.mockResolvedValue(createUser());
      const client = buildClient({ auth: { token: signToken() }, headers: {} });

      await expect(guard.canActivate(buildContext(client))).resolves.toBe(true);
    });

    it('auth.token이 없으면 Authorization 헤더로 폴백해야 함', async () => {
      userRepository.findOne.mockResolvedValue(createUser());
      const client = buildClient({
        auth: {},
        headers: { authorization: `Bearer ${signToken()}` },
      });

      await expect(guard.canActivate(buildContext(client))).resolves.toBe(true);
    });

    it('둘 다 있으면 auth.token을 우선해야 함', async () => {
      userRepository.findOne.mockResolvedValue(createUser({ userId: 3 }));
      const client = buildClient({
        auth: { token: signToken({ sub: 3 }) },
        headers: { authorization: `Bearer ${signToken({ sub: 88 })}` },
      });

      await guard.canActivate(buildContext(client));

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { userId: 3, isActivated: 1 },
      });
    });

    it.each([
      ['auth·헤더 모두 없음', { auth: {}, headers: {} }],
      ['auth 자체가 undefined', { headers: {} }],
      ['Bearer 접두사 없음', { auth: {}, headers: { authorization: 'abc' } }],
    ])('%s → AUTH_UNAUTHORIZED', async (_desc, handshake) => {
      const code = await codeOf(guard.canActivate(buildContext(buildClient(handshake))));

      expect(code).toBe('AUTH_UNAUTHORIZED');
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('토큰 검증', () => {
    it('위조된 토큰은 AUTH_INVALID_TOKEN으로 차단해야 함', async () => {
      const forged = sign({ sub: 1 }, 'wrong-secret', { expiresIn: '1h' });
      const client = buildClient({ auth: { token: forged }, headers: {} });

      await expect(codeOf(guard.canActivate(buildContext(client)))).resolves.toBe(
        'AUTH_INVALID_TOKEN',
      );
    });

    it('만료된 토큰은 AUTH_INVALID_TOKEN으로 차단해야 함', async () => {
      const expired = sign({ sub: 1 }, SECRET, { expiresIn: -10 });
      const client = buildClient({ auth: { token: expired }, headers: {} });

      await expect(codeOf(guard.canActivate(buildContext(client)))).resolves.toBe(
        'AUTH_INVALID_TOKEN',
      );
    });

    // HTTP 가드와 동일한 회귀 방어 — 초대 토큰(sub 없음)으로 WS 인증이 뚫리면 안 된다
    it('sub이 없는 토큰(초대 토큰 등)은 차단해야 함', async () => {
      const client = buildClient({
        auth: { token: signToken({ teamId: 1, userId: 2, jti: 'x' }) },
        headers: {},
      });

      await expect(codeOf(guard.canActivate(buildContext(client)))).resolves.toBe(
        'AUTH_INVALID_TOKEN',
      );
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('사용자 조회 및 주입', () => {
    it('사용자가 없으면 AUTH_UNAUTHORIZED로 차단해야 함', async () => {
      userRepository.findOne.mockResolvedValue(null);
      const client = buildClient({ auth: { token: signToken() }, headers: {} });

      await expect(codeOf(guard.canActivate(buildContext(client)))).resolves.toBe(
        'AUTH_UNAUTHORIZED',
      );
    });

    it('인증 성공 시 client.data.user에 주입해야 함 (Gateway가 이 값을 읽는다)', async () => {
      const user = createUser({ userId: 1 });
      userRepository.findOne.mockResolvedValue(user);
      const client = buildClient({ auth: { token: signToken() }, headers: {} });

      await guard.canActivate(buildContext(client));

      expect(client.data.user).toBe(user);
    });
  });
});

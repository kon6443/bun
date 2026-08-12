import { ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { sign } from 'jsonwebtoken';
import { FishingWsGuard, FishingSocket } from './fishing-ws.guard';
import { User } from '../../entities/User';
import { createUser } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';

const SECRET = 'test-jwt-secret';

const signToken = (payload: Record<string, unknown> = { sub: 1 }, expiresIn: string | number = '1h') =>
  sign(payload, SECRET, { expiresIn } as never);

const buildClient = (
  handshake: Record<string, unknown> = { auth: {}, headers: {} },
  id = 'socket-abc',
) => ({ id, handshake, data: {} }) as unknown as FishingSocket;

const buildContext = (client: FishingSocket): ExecutionContext =>
  ({ switchToWs: () => ({ getClient: () => client }) }) as ExecutionContext;

/**
 * 다른 가드와 달리 이 가드는 **접속을 거부하지 않는다**(게스트 허용).
 * 따라서 "차단되는가"가 아니라 **"인증/게스트 중 어느 쪽으로 분류되는가"**가 계약이다.
 * 특히 guestId가 음수라는 불변식이 깨지면 게스트가 실제 유저 ID와 충돌한다.
 */
describe('FishingWsGuard', () => {
  let guard: FishingWsGuard;
  let userRepository: MockRepository<User>;

  beforeEach(async () => {
    userRepository = createMockRepository<User>();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FishingWsGuard,
        { provide: ConfigService, useValue: { get: jest.fn(() => SECRET) } },
        { provide: getRepositoryToken(User), useValue: userRepository },
      ],
    }).compile();

    guard = module.get(FishingWsGuard);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('인증 유저', () => {
    it('유효한 토큰 + 존재하는 유저 → user 주입, isAuthenticated true', async () => {
      const user = createUser({ userId: 10 });
      userRepository.findOne.mockResolvedValue(user);
      const client = buildClient({ auth: { token: signToken({ sub: 10 }) }, headers: {} });

      await expect(guard.canActivate(buildContext(client))).resolves.toBe(true);
      expect(client.data.user).toBe(user);
      expect(client.data.isAuthenticated).toBe(true);
      expect(client.data.guestId).toBeUndefined();
    });

    it('Authorization Bearer 헤더로도 인증되어야 함', async () => {
      userRepository.findOne.mockResolvedValue(createUser());
      const client = buildClient({
        auth: {},
        headers: { authorization: `Bearer ${signToken()}` },
      });

      await guard.canActivate(buildContext(client));

      expect(client.data.isAuthenticated).toBe(true);
    });

    it('활성 유저만 조회해야 함', async () => {
      userRepository.findOne.mockResolvedValue(createUser({ userId: 4 }));
      const client = buildClient({ auth: { token: signToken({ sub: 4 }) }, headers: {} });

      await guard.canActivate(buildContext(client));

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { userId: 4, isActivated: 1 },
      });
    });
  });

  describe('게스트로 강등되는 경우 — 항상 통과하되 인증으로 오인되지 않아야 함', () => {
    it.each([
      ['토큰 없음', { auth: {} }],
      ['위조된 토큰', { auth: { token: sign({ sub: 1 }, 'wrong', { expiresIn: '1h' }) } }],
      ['만료된 토큰', { auth: { token: signToken({ sub: 1 }, -10) } }],
      ['sub 없는 토큰', { auth: { token: signToken({ teamId: 1, userId: 2 }) } }],
    ])('%s → 게스트', async (_desc, handshake) => {
      const client = buildClient({ headers: {}, ...handshake });

      await expect(guard.canActivate(buildContext(client))).resolves.toBe(true);
      expect(client.data.isAuthenticated).toBe(false);
      expect(client.data.user).toBeUndefined();
      expect(typeof client.data.guestId).toBe('number');
      expect(typeof client.data.guestName).toBe('string');
    });

    it('토큰은 유효하지만 DB에 유저가 없으면 게스트로 처리해야 함', async () => {
      userRepository.findOne.mockResolvedValue(null);
      const client = buildClient({ auth: { token: signToken() }, headers: {} });

      await guard.canActivate(buildContext(client));

      expect(client.data.isAuthenticated).toBe(false);
      expect(client.data.user).toBeUndefined();
    });

    it('JWT_SECRET 미설정 시에도 접속을 끊지 않고 게스트로 처리해야 함', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FishingWsGuard,
          { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
          { provide: getRepositoryToken(User), useValue: userRepository },
        ],
      }).compile();
      const guardWithoutSecret = module.get(FishingWsGuard);
      const client = buildClient({ auth: { token: signToken() }, headers: {} });

      await expect(guardWithoutSecret.canActivate(buildContext(client))).resolves.toBe(true);
      expect(client.data.isAuthenticated).toBe(false);
    });
  });

  describe('guestId 불변식 — 일반 userId와 충돌하지 않아야 함', () => {
    it.each([
      ['짧은 id', 'a'],
      ['일반 socket id', 'AbC123xyz_-'],
      ['긴 id', 'x'.repeat(64)],
      ['숫자 문자열', '1234567890'],
    ])('%s → guestId가 음수여야 함', async (_desc, socketId) => {
      const client = buildClient({ auth: {}, headers: {} }, socketId);

      await guard.canActivate(buildContext(client));

      expect(client.data.guestId).toBeLessThan(0);
    });

    it('같은 socketId는 같은 guestId를 만들어야 함 (결정적)', async () => {
      const a = buildClient({ auth: {}, headers: {} }, 'same-socket');
      const b = buildClient({ auth: {}, headers: {} }, 'same-socket');

      await guard.canActivate(buildContext(a));
      await guard.canActivate(buildContext(b));

      expect(a.data.guestId).toBe(b.data.guestId);
    });

    it('다른 socketId는 다른 guestId를 만들어야 함', async () => {
      const a = buildClient({ auth: {}, headers: {} }, 'socket-1');
      const b = buildClient({ auth: {}, headers: {} }, 'socket-2');

      await guard.canActivate(buildContext(a));
      await guard.canActivate(buildContext(b));

      expect(a.data.guestId).not.toBe(b.data.guestId);
    });
  });

  describe('중복 실행 방지', () => {
    // 가드는 이벤트마다 실행된다 — 매번 게스트 이름이 바뀌면 사용자에게 이름이 계속 달라 보인다
    it('isAuthenticated가 이미 설정된 소켓은 상태를 덮어쓰지 않아야 함', async () => {
      const user = createUser();
      const client = buildClient({ auth: { token: signToken() }, headers: {} });
      client.data.isAuthenticated = false;
      client.data.guestId = -12345;
      client.data.guestName = '졸린판다7';
      userRepository.findOne.mockResolvedValue(user);

      await expect(guard.canActivate(buildContext(client))).resolves.toBe(true);

      expect(client.data.guestId).toBe(-12345);
      expect(client.data.guestName).toBe('졸린판다7');
      expect(client.data.user).toBeUndefined();
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });
  });
});

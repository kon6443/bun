import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { sign } from 'jsonwebtoken';
import { User } from '../../entities/User';
import { createUser } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { TetrisBattleSocket, TetrisBattleWsGuard } from './tetris-battle-ws.guard';

const SECRET = 'test-jwt-secret';
const USER = createUser({ userId: 7 });

const buildClient = (handshake: Record<string, unknown> = { auth: {}, headers: {} }) =>
  ({ id: 'sock-1', handshake, data: {} }) as unknown as TetrisBattleSocket;

const buildContext = (client: TetrisBattleSocket): ExecutionContext =>
  ({ switchToWs: () => ({ getClient: () => client }) }) as ExecutionContext;

/**
 * 대전 가드는 **거부하지 않는다**(비로그인 참가 허용 D-011). 계약은 "로그인 유저인가(userId) / 게스트인가(null)"다.
 * 무효 토큰이 로그인 유저로 분류되면 게스트가 남의 결과 기록(D-008)에 붙는다.
 */
describe('TetrisBattleWsGuard', () => {
  let guard: TetrisBattleWsGuard;
  let userRepository: MockRepository<User>;

  beforeEach(async () => {
    userRepository = createMockRepository<User>();
    userRepository.findOne.mockImplementation(async (options) =>
      (options as { where: { userId: number } }).where.userId === USER.userId ? USER : null,
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TetrisBattleWsGuard,
        { provide: ConfigService, useValue: { get: jest.fn(() => SECRET) } },
        { provide: getRepositoryToken(User), useValue: userRepository },
      ],
    }).compile();
    guard = module.get(TetrisBattleWsGuard);
  });

  it('유효한 handshake.auth.token이면 userId를 기록한다', async () => {
    const client = buildClient({ auth: { token: sign({ sub: USER.userId }, SECRET) }, headers: {} });
    await expect(guard.canActivate(buildContext(client))).resolves.toBe(true);
    expect(client.data).toMatchObject({ userId: USER.userId, authResolved: true });
  });

  it('Bearer 헤더도 받는다', async () => {
    const client = buildClient({ auth: {}, headers: { authorization: `Bearer ${sign({ sub: USER.userId }, SECRET)}` } });
    await guard.canActivate(buildContext(client));
    expect(client.data.userId).toBe(USER.userId);
  });

  it.each([
    ['토큰 없음', {}],
    ['서명 불일치', { token: sign({ sub: USER.userId }, 'other-secret') }],
    ['만료', { token: sign({ sub: USER.userId, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET) }],
    ['없는(비활성) 유저', { token: sign({ sub: 999 }, SECRET) }],
  ])('%s → 거부하지 않고 게스트(userId=null)', async (_label, auth) => {
    const client = buildClient({ auth, headers: {} });
    await expect(guard.canActivate(buildContext(client))).resolves.toBe(true);
    expect(client.data.userId).toBeNull();
  });

  it('한 번 판정한 소켓은 다시 조회하지 않는다', async () => {
    const client = buildClient({ auth: { token: sign({ sub: USER.userId }, SECRET) }, headers: {} });
    await guard.canActivate(buildContext(client));
    await guard.canActivate(buildContext(client));
    expect(userRepository.findOne).toHaveBeenCalledTimes(1);
  });
});

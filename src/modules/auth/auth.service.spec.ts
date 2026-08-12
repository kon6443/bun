import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { verify, JwtPayload } from 'jsonwebtoken';
import { AuthService } from './auth.service';
import { User } from '../../entities/User';
import { createUser } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import {
  AuthUnauthorizedErrorResponseDto,
  AuthInvalidTokenErrorResponseDto,
  AuthKakaoApiErrorResponseDto,
} from './auth-error.dto';

const SECRET = 'test-jwt-secret';

const CONFIG: Record<string, string> = {
  JWT_SECRET: SECRET,
  JWT_ACCESS_TOKEN_EXPIRES_IN: '30d',
};

/** 카카오 토큰 정보 API 응답을 흉내낸다 — 실제 네트워크는 타지 않는다. */
const mockKakaoResponse = (status: number, body: unknown) =>
  jest.spyOn(global, 'fetch').mockResolvedValue({
    status,
    json: async () => body,
  } as Response);

describe('AuthService', () => {
  let service: AuthService;
  let userRepository: MockRepository<User>;

  beforeEach(async () => {
    userRepository = createMockRepository<User>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: ConfigService, useValue: { get: jest.fn((key: string) => CONFIG[key]) } },
        { provide: getRepositoryToken(User), useValue: userRepository },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('getKakaoId', () => {
    /**
     * 회귀 방어의 핵심: 카카오 API는 id를 **number**로 주지만 DB의 KAKAO_ID는 VARCHAR2다.
     * 여기서 string 변환을 빠뜨리면 Oracle이 컬럼을 숫자로 암묵 변환해 비교하고,
     * 비숫자 값이 한 건이라도 생기면 ORA-01722로 로그인 전체가 깨진다.
     */
    it('카카오 API의 number id를 string으로 변환해 반환해야 함', async () => {
      mockKakaoResponse(200, { id: 1234567890 });

      const result = await service.getKakaoId({ accessToken: 'valid-token' });

      expect(result).toBe('1234567890');
      expect(typeof result).toBe('string');
    });

    it('큰 id도 정밀도 손실 없이 문자열로 옮겨야 함', async () => {
      mockKakaoResponse(200, { id: 4294967295 });

      await expect(service.getKakaoId({ accessToken: 'valid-token' })).resolves.toBe('4294967295');
    });

    it('Authorization 헤더에 Bearer 토큰을 실어 호출해야 함', async () => {
      const fetchSpy = mockKakaoResponse(200, { id: 1 });

      await service.getKakaoId({ accessToken: 'abc123' });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://kapi.kakao.com/v1/user/access_token_info',
        expect.objectContaining({
          method: 'GET',
          headers: { Authorization: 'Bearer abc123' },
        }),
      );
    });

    it('accessToken이 없으면 네트워크를 타지 않고 차단해야 함', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');

      await expect(service.getKakaoId({ accessToken: undefined })).rejects.toThrow(
        AuthUnauthorizedErrorResponseDto,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([[400], [401], [403], [500]])(
      '카카오가 %i을 반환하면 AuthKakaoApiErrorResponseDto를 던져야 함',
      async (status) => {
        mockKakaoResponse(status, { msg: 'error' });

        await expect(service.getKakaoId({ accessToken: 'bad-token' })).rejects.toThrow(
          AuthKakaoApiErrorResponseDto,
        );
      },
    );
  });

  describe('getUserBy', () => {
    it('조건이 하나도 없으면 DB를 조회하지 않고 빈 배열을 반환해야 함', async () => {
      const result = await service.getUserBy({});

      expect(result).toEqual([]);
      expect(userRepository.find).not.toHaveBeenCalled();
    });

    it.each([
      ['빈 kakaoIds 배열', { kakaoIds: [] }],
      ['빈 isActivateds 배열', { isActivateds: [] as (0 | 1)[] }],
    ])('%s도 조건 없음으로 취급해야 함', async (_desc, args) => {
      const result = await service.getUserBy(args);

      expect(result).toEqual([]);
      expect(userRepository.find).not.toHaveBeenCalled();
    });

    it('kakaoIds를 In 조건으로 조회해야 함', async () => {
      const users = [createUser()];
      userRepository.find.mockResolvedValue(users);

      const result = await service.getUserBy({ kakaoIds: ['111', '222'] });

      expect(result).toBe(users);
      expect(userRepository.find).toHaveBeenCalledWith({
        where: { kakaoId: In(['111', '222']) },
      });
    });

    it('kakaoIds와 isActivateds를 함께 넘기면 두 조건이 모두 적용되어야 함', async () => {
      userRepository.find.mockResolvedValue([]);

      await service.getUserBy({ kakaoIds: ['111'], isActivateds: [1] });

      expect(userRepository.find).toHaveBeenCalledWith({
        where: { kakaoId: In(['111']), isActivated: In([1]) },
      });
    });
  });

  describe('userSignUp', () => {
    it('카카오 닉네임을 userName으로 저장하고 userId를 반환해야 함', async () => {
      const created = createUser({ userId: 0 });
      userRepository.create.mockReturnValue(created);
      userRepository.save.mockResolvedValue(createUser({ userId: 77 }));

      const result = await service.userSignUp({
        user: { kakaoId: '999', kakaoNickname: '카카오닉' },
      });

      expect(result).toBe(77);
      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ kakaoId: '999', userName: '카카오닉', isActivated: 1 }),
      );
    });

    // 카카오가 닉네임 동의를 받지 못한 계정은 nickname이 없다
    it('카카오 닉네임이 없으면 userName을 null로 저장해야 함', async () => {
      userRepository.create.mockReturnValue(createUser());
      userRepository.save.mockResolvedValue(createUser({ userId: 5 }));

      await service.userSignUp({ user: { kakaoId: '999' } });

      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ userName: null }),
      );
    });
  });

  describe('postKakaoSignInUp — 로그인/회원가입 통합 플로우', () => {
    it('기존 사용자는 가입 없이 로그인 처리되어야 함', async () => {
      mockKakaoResponse(200, { id: 123 });
      userRepository.find.mockResolvedValue([createUser({ userId: 9, userName: '기존유저' })]);

      const result = await service.postKakaoSignInUp({
        kakaoUserSign: { accessToken: 'tok' },
      });

      expect(result).toEqual(
        expect.objectContaining({ userId: 9, userName: '기존유저', loginType: 'KAKAO' }),
      );
      expect(userRepository.save).not.toHaveBeenCalled();
    });

    it('활성 사용자만 조회하고, 카카오 id는 문자열로 넘겨야 함', async () => {
      mockKakaoResponse(200, { id: 123 });
      userRepository.find.mockResolvedValue([createUser({ userId: 9 })]);

      await service.postKakaoSignInUp({ kakaoUserSign: { accessToken: 'tok' } });

      expect(userRepository.find).toHaveBeenCalledWith({
        where: { kakaoId: In(['123']), isActivated: In([1]) },
      });
    });

    it('없는 사용자는 회원가입 후 로그인 처리되어야 함', async () => {
      mockKakaoResponse(200, { id: 456 });
      userRepository.find.mockResolvedValue([]);
      userRepository.create.mockReturnValue(createUser());
      userRepository.save.mockResolvedValue(createUser({ userId: 100 }));

      const result = await service.postKakaoSignInUp({
        kakaoUserSign: { accessToken: 'tok', kakaoNickname: '신규유저' },
      });

      expect(result).toEqual(
        expect.objectContaining({ userId: 100, userName: '신규유저' }),
      );
      expect(userRepository.save).toHaveBeenCalled();
    });

    it.each([
      ['기존 사용자의 userName이 null', [createUser({ userId: 9, userName: null })], '사용자9'],
    ])('%s이면 기본 닉네임을 반환해야 함', async (_desc, found, expected) => {
      mockKakaoResponse(200, { id: 123 });
      userRepository.find.mockResolvedValue(found);

      const result = await service.postKakaoSignInUp({
        kakaoUserSign: { accessToken: 'tok' },
      });

      expect(result.userName).toBe(expected);
    });

    it('신규 가입인데 카카오 닉네임이 없으면 기본 닉네임을 반환해야 함', async () => {
      mockKakaoResponse(200, { id: 456 });
      userRepository.find.mockResolvedValue([]);
      userRepository.create.mockReturnValue(createUser());
      userRepository.save.mockResolvedValue(createUser({ userId: 100 }));

      const result = await service.postKakaoSignInUp({
        kakaoUserSign: { accessToken: 'tok' },
      });

      expect(result.userName).toBe('사용자100');
    });

    describe('발급된 accessToken', () => {
      it('sub에 userId, loginType을 담아 서명해야 함 (가드가 sub으로 인증한다)', async () => {
        mockKakaoResponse(200, { id: 123 });
        userRepository.find.mockResolvedValue([createUser({ userId: 9 })]);

        const { accessToken } = await service.postKakaoSignInUp({
          kakaoUserSign: { accessToken: 'tok' },
        });

        const payload = verify(accessToken, SECRET) as JwtPayload & { loginType?: string };
        expect(payload.sub).toBe(9);
        expect(payload.loginType).toBe('KAKAO');
      });

      it('JWT_SECRET이 없으면 토큰을 발급하지 않고 차단해야 함', async () => {
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            AuthService,
            { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
            { provide: getRepositoryToken(User), useValue: userRepository },
          ],
        }).compile();
        const serviceWithoutSecret = module.get(AuthService);
        mockKakaoResponse(200, { id: 123 });
        userRepository.find.mockResolvedValue([createUser({ userId: 9 })]);

        await expect(
          serviceWithoutSecret.postKakaoSignInUp({ kakaoUserSign: { accessToken: 'tok' } }),
        ).rejects.toThrow(AuthInvalidTokenErrorResponseDto);
      });
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../entities/User';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: jest.Mocked<UsersService>;

  const mockUser: User = {
    userId: 1,
    userName: '홍길동',
    birth: null,
    kakaoId: 123456789,
    kakaoEmail: 'test@kakao.com',
    createdDate: new Date('2024-01-15T09:30:00.000Z'),
    isActivated: 1,
    teams: [],
    teamMembers: [],
  };

  const mockRequest = {
    user: mockUser,
  } as any;

  beforeEach(async () => {
    const mockUsersService = {
      getProfile: jest.fn(),
      updateProfile: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: mockUsersService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<UsersController>(UsersController);
    usersService = module.get(UsersService);
  });

  describe('GET /me', () => {
    it('프로필 조회 성공 시 표준 응답 형식을 반환해야 함', async () => {
      const profileData = {
        userId: 1,
        userName: '홍길동',
        kakaoEmail: 'test@kakao.com',
        createdDate: '2024-01-15T09:30:00.000Z',
      };
      usersService.getProfile.mockResolvedValue(profileData);

      const result = await controller.getProfile(mockRequest);

      expect(result).toEqual({
        code: 'SUCCESS',
        data: profileData,
        message: '',
      });
      expect(usersService.getProfile).toHaveBeenCalledWith(1);
    });
  });

  describe('PUT /me', () => {
    it('닉네임 수정 성공 시 표준 응답 형식을 반환해야 함', async () => {
      const updateData = {
        userId: 1,
        userName: '새로운닉네임',
      };
      usersService.updateProfile.mockResolvedValue(updateData);

      const result = await controller.updateProfile(mockRequest, {
        userName: '새로운닉네임',
      });

      expect(result).toEqual({
        code: 'SUCCESS',
        data: updateData,
        message: '',
      });
      expect(usersService.updateProfile).toHaveBeenCalledWith(1, {
        userName: '새로운닉네임',
      });
    });
  });
});

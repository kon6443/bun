import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserSkinService } from './user-skin.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { createUser, FIXED_DATE } from '../../entities/__spec__/entity.factory';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: jest.Mocked<UsersService>;
  let userSkinService: { getSkins: jest.Mock; equip: jest.Mock };

  const mockUser = createUser();

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
        { provide: UserSkinService, useValue: (userSkinService = { getSkins: jest.fn(), equip: jest.fn() }) },
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
        createdDate: FIXED_DATE.toISOString(),
      };
      usersService.getProfile.mockResolvedValue(profileData);

      const result = await controller.getProfile(mockUser);

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

      const result = await controller.updateProfile(mockUser, {
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

  describe('스킨 (tetris-skins D-003)', () => {
    const skins = {
      equipped: { block: 'gameboy', effect: 'default', board: 'default', background: 'neon' },
      catalog: { block: [], effect: [], board: [], background: [] },
    };

    it('GET /me/skins — 토큰 사용자의 장착·카탈로그를 표준 응답으로', async () => {
      userSkinService.getSkins.mockResolvedValue(skins);
      await expect(controller.getSkins(mockUser)).resolves.toEqual({ code: 'SUCCESS', data: skins, message: '' });
      expect(userSkinService.getSkins).toHaveBeenCalledWith(mockUser.userId);
    });

    it('PUT /me/skins — 보낸 슬롯만 토큰 사용자에게 장착', async () => {
      userSkinService.equip.mockResolvedValue(skins);
      await expect(controller.updateSkins(mockUser, { block: 'gameboy' })).resolves.toEqual({ code: 'SUCCESS', data: skins, message: '' });
      expect(userSkinService.equip).toHaveBeenCalledWith(mockUser.userId, { block: 'gameboy' });
    });
  });
});

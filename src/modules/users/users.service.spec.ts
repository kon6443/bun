import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UserNotFoundErrorResponseDto } from './users-error.dto';
import { User } from '../../entities/User';
import { createUser, FIXED_DATE } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';

describe('UsersService', () => {
  let service: UsersService;
  let userRepository: MockRepository<User>;

  const mockUser = createUser();

  beforeEach(async () => {
    const mockRepository = createMockRepository<User>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    userRepository = module.get(getRepositoryToken(User));
  });

  describe('getProfile', () => {
    it('사용자 프로필을 정상적으로 조회해야 함', async () => {
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.getProfile(1);

      expect(result).toEqual({
        userId: 1,
        userName: '홍길동',
        kakaoEmail: 'test@kakao.com',
        createdDate: FIXED_DATE.toISOString(),
      });
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { userId: 1, isActivated: 1 },
      });
    });

    it('userName이 null인 경우 기본 닉네임을 반환해야 함', async () => {
      const userWithNullName = { ...mockUser, userName: null };
      userRepository.findOne.mockResolvedValue(userWithNullName);

      const result = await service.getProfile(1);

      expect(result.userName).toBe('사용자1');
    });

    it('존재하지 않는 사용자 조회 시 UserNotFoundErrorResponseDto를 던져야 함', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.getProfile(999)).rejects.toThrow(UserNotFoundErrorResponseDto);
    });
  });

  describe('updateProfile', () => {
    it('닉네임을 정상적으로 수정해야 함', async () => {
      const updatedUser = { ...mockUser, userName: '새로운닉네임' };
      userRepository.findOne.mockResolvedValue({ ...mockUser });
      userRepository.save.mockResolvedValue(updatedUser);

      const result = await service.updateProfile(1, { userName: '새로운닉네임' });

      expect(result).toEqual({
        userId: 1,
        userName: '새로운닉네임',
      });
      expect(userRepository.save).toHaveBeenCalled();
    });

    it('존재하지 않는 사용자 수정 시 UserNotFoundErrorResponseDto를 던져야 함', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateProfile(999, { userName: '새로운닉네임' }),
      ).rejects.toThrow(UserNotFoundErrorResponseDto);
    });
  });
});

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { UpdateUserDto } from './users.dto';
import { UserNotFoundErrorResponseDto } from './users-error.dto';
import { getDisplayName } from '../../common/utils/user.utils';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  /**
   * 사용자 프로필 조회
   */
  async getProfile(userId: number) {
    const user = await this.userRepository.findOne({
      where: { userId, isActivated: 1 },
    });

    if (!user) {
      throw new UserNotFoundErrorResponseDto();
    }

    return {
      userId: user.userId,
      userName: getDisplayName(user.userName, user.userId),
      kakaoEmail: user.kakaoEmail,
      createdDate: user.createdDate.toISOString(),
    };
  }

  /**
   * 사용자 프로필 수정 (닉네임)
   */
  async updateProfile(userId: number, dto: UpdateUserDto) {
    const user = await this.userRepository.findOne({
      where: { userId, isActivated: 1 },
    });

    if (!user) {
      throw new UserNotFoundErrorResponseDto();
    }

    user.userName = dto.userName;
    await this.userRepository.save(user);

    return {
      userId: user.userId,
      userName: user.userName,
    };
  }
}

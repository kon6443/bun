import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  /**
   * 기본 닉네임 생성: userName이 null인 경우 "사용자{userId}" 형식으로 반환
   */
  private getDisplayName(userName: string | null, userId: number): string {
    return userName ?? `사용자${userId}`;
  }

  /**
   * 사용자 프로필 조회
   */
  async getProfile(userId: number) {
    const user = await this.userRepository.findOne({
      where: { userId, isActivated: 1 },
    });

    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    return {
      userId: user.userId,
      userName: this.getDisplayName(user.userName, user.userId),
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
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    user.userName = dto.userName;
    await this.userRepository.save(user);

    return {
      userId: user.userId,
      userName: user.userName,
    };
  }
}

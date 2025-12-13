import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { User } from '../../entities/User';

export type UserType = {
  kakaoId?: number;
  kakaoNickname?: string;
  isActivated?: 0 | 1;
};

// KakaoUserSignType은 DTO에서 정의하므로 여기서는 제거

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async getKakaoId({ accessToken }: { accessToken?: string }): Promise<number> {
    if (!accessToken) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    const kakaoAPI = `https://kapi.kakao.com/v1/user/access_token_info`;
    const kakaoRes = await fetch(kakaoAPI, {
      method: 'get',
      headers: {
        'Content-Type': 'Content-type: application/x-www-form-urlencoded;charset=utf-8',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const status = kakaoRes.status;
    if (status !== 200) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    const user = (await kakaoRes.json()) as { id: number };
    return user.id;
  }

  /**
   * 조건에 맞는 사용자들을 조회합니다.
   *
   * @param kakaoIds - 조회할 카카오 ID 배열
   * @param isActivateds - 활성화 상태 배열 (0: 비활성, 1: 활성)
   * @returns 조건에 맞는 사용자 배열 (없으면 빈 배열)
   */
  async getUserBy({
    kakaoIds,
    isActivateds,
  }: {
    kakaoIds?: number[];
    isActivateds?: (0 | 1)[];
  }): Promise<User[]> {
    const where: {
      kakaoId?: any;
      isActivated?: any;
    } = {};

    if (kakaoIds?.length) {
      where.kakaoId = In(kakaoIds);
    }

    if (isActivateds?.length) {
      where.isActivated = In(isActivateds);
    }

    if (Object.keys(where).length === 0) {
      return [];
    }

    const users = await this.userRepository.find({ where });
    return users;
  }

  async userSignUp({ user }: { user: UserType }): Promise<number> {
    const { kakaoNickname, kakaoId } = user;

    const newUser = this.userRepository.create({
      kakaoId: kakaoId!,
      userName: kakaoNickname || null,
      isActivated: 1,
      createdDate: new Date(),
    });

    const savedUser = await this.userRepository.save(newUser);
    return savedUser.userId;
  }

  async postKakaoSignInUp({
    kakaoUserSign,
  }: {
    kakaoUserSign: { accessToken: string; kakaoNickname?: string };
  }): Promise<{ userId: number; loginType: string }> {
    const { accessToken, kakaoNickname } = kakaoUserSign;

    // 카카오 accessToken 검증 요청, 응답으로 kakaoId 수신
    const kakaoId = await this.getKakaoId({ accessToken });

    // 카카오로부터 응답받은 kakaoId 로 내부 USERS 테이블 유저 검색
    const [user] = await this.getUserBy({
      kakaoIds: [kakaoId],
      isActivateds: [1],
    });

    const loginType = 'KAKAO';
    let userId: number;

    // 내부 Users 테이블에 없을 경우 회원가입 처리
    if (!user) {
      userId = await this.userSignUp({
        user: { kakaoId, kakaoNickname } as UserType,
      });
      return { userId, loginType };
    }

    // 로그인한 userId 응답
    userId = user.userId;
    return { userId, loginType };
  }
}


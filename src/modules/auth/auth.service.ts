import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, FindOptionsWhere } from 'typeorm';
import { User } from '../../entities/User';
import { LoginType } from '../../common/enums/login-type.enum';
import { KAKAO_TOKEN_INFO_API } from '../../common/constants/external-api.constants';
import { sign, type SignOptions } from 'jsonwebtoken';
import {
  AuthUnauthorizedErrorResponseDto,
  AuthInvalidTokenErrorResponseDto,
  AuthKakaoApiErrorResponseDto,
} from './auth-error.dto';
import { getDisplayName } from '../../common/utils/user.utils';

export type UserType = {
  kakaoId?: string;
  kakaoNickname?: string;
  isActivated?: 0 | 1;
};

// KakaoUserSignType은 DTO에서 정의하므로 여기서는 제거

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  private issueAccessToken({ userId, loginType }: { userId: number; loginType: string }): string {
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new AuthInvalidTokenErrorResponseDto('JWT_SECRET이 설정되지 않았습니다.');
    }

    // 예: "30d", "2h", "3600s" 등 (jsonwebtoken expiresIn 규격)
    const expiresIn = (this.configService.get<string>('JWT_ACCESS_TOKEN_EXPIRES_IN') ??
      '30d') as SignOptions['expiresIn'];

    return sign({ sub: userId, loginType }, secret, { expiresIn });
  }

  async getKakaoId({ accessToken }: { accessToken?: string }): Promise<string> {
    if (!accessToken) {
      throw new AuthUnauthorizedErrorResponseDto('카카오 액세스 토큰이 필요합니다.');
    }

    const kakaoAPI = KAKAO_TOKEN_INFO_API;
    const kakaoRes = await fetch(kakaoAPI, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const status = kakaoRes.status;
    if (status !== 200) {
      throw new AuthKakaoApiErrorResponseDto('카카오 인증에 실패했습니다.');
    }

    const user = (await kakaoRes.json()) as { id: number };
    // DB KAKAO_ID가 VARCHAR2이므로 도메인 진입 경계에서 string으로 변환
    return String(user.id);
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
    kakaoIds?: string[];
    isActivateds?: (0 | 1)[];
  }): Promise<User[]> {
    const where: FindOptionsWhere<User> = {};

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
  }): Promise<{ userId: number; userName: string; loginType: string; accessToken: string }> {
    const { accessToken, kakaoNickname } = kakaoUserSign;
    const startedAt = Date.now();

    // 카카오 accessToken 검증 요청, 응답으로 kakaoId 수신
    const kakaoId = await this.getKakaoId({ accessToken });
    const kakaoMs = Date.now() - startedAt;

    // 카카오로부터 응답받은 kakaoId 로 내부 USERS 테이블 유저 검색
    const dbStartedAt = Date.now();
    const [user] = await this.getUserBy({
      kakaoIds: [kakaoId],
      isActivateds: [1],
    });
    const dbMs = Date.now() - dbStartedAt;

    const loginType: LoginType = 'KAKAO';
    let userId: number;
    let userName: string;

    const writeStartedAt = Date.now();
    if (!user) {
      // 내부 Users 테이블에 없을 경우 회원가입 처리
      userId = await this.userSignUp({
        user: { kakaoId, kakaoNickname } as UserType,
      });
      // 신규 사용자: 카카오 닉네임 또는 기본 닉네임
      userName = getDisplayName(kakaoNickname || null, userId);
    } else {
      // 로그인한 userId 응답
      userId = user.userId;
      // 기존 사용자: DB의 userName 또는 기본 닉네임
      userName = getDisplayName(user.userName, userId);
    }
    const writeMs = Date.now() - writeStartedAt;

    // 로그인 지연 구간 계측 — 간헐적 수 초 스파이크의 범인을 카카오/DB로 분해하기 위한 것.
    // 이 구간에 계측이 0건이라 스파이크가 발생해도 원인을 특정할 수 없었다.
    // 판정 기준과 Loki 쿼리: docs/tasks/tasks-kakao-login-latency.md
    this.logger.log(
      { kakaoMs, dbMs, writeMs, totalMs: Date.now() - startedAt, isNewUser: !user },
      '카카오 로그인 구간 측정',
    );

    return {
      userId,
      userName,
      loginType,
      accessToken: this.issueAccessToken({ userId, loginType }),
    };
  }
}

import { AppDataSource } from "../database/data-source";
import { User } from "../entities/User";
import utilServiceInstance from "./utils";
import { In } from "typeorm";

export type UserType = {
  kakaoId?: number;
  kakaoNickname?: string;
  isActivated?: 0 | 1;
};

class AuthService {
  constructor() {}

  async getKakaoId({
    accessToken,
  }: {
    accessToken?: string;
  }): Promise<number> {
    if (!accessToken)
      throw utilServiceInstance.handleError({
        message: "UNAUTHORIZED",
        status: 401,
      });
    const kakaoAPI = `https://kapi.kakao.com/v1/user/access_token_info`;
    const kakaoRes = await fetch(kakaoAPI, {
      method: "get",
      headers: {
        "Content-Type":
          "Content-type: application/x-www-form-urlencoded;charset=utf-8",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const status = kakaoRes.status;
    // 이상한값: 401
    // undefined: 401
    // 성공: 200
    if (status !== 200) {
      throw utilServiceInstance.handleError({
        message: "UNAUTHORIZED",
        status: 401,
      });
    }
    const user = await kakaoRes.json() as { id: number };
    return user.id;
  }

  /**
   * 조건에 맞는 사용자들을 조회합니다.
   * 
   * @param kakaoIds - 조회할 카카오 ID 배열 (문자열 배열 또는 객체 배열 모두 가능)
   * @param isActivateds - 활성화 상태 배열 (0: 비활성, 1: 활성)
   * @returns 조건에 맞는 사용자 배열 (없으면 빈 배열)
   * 
   * @example
   * // 여러 사용자 조회
   * const users = await getUserBy({ kakaoIds: [123, 456] });
   * 
   * // 단일 사용자 조회 (호출부에서 구조 분해 할당)
   * const [user] = await getUserBy({ kakaoIds: [123] });
   */
  async getUserBy({
    kakaoIds,
    isActivateds,
  }: {
    kakaoIds?: number[];
    isActivateds?: (0 | 1)[];
  }): Promise<User[]> {
    const userRepository = AppDataSource.getRepository(User);
    
    // TypeORM의 FindOptionsWhere 타입 사용
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

    // 조건이 하나도 없으면 빈 배열 반환
    if (Object.keys(where).length === 0) {
      return [];
    }

    const users = await userRepository.find({ where });
    return users;
  }

  async userSignUp({ user }: { user: UserType }) {
    const { kakaoNickname, kakaoId } = user;
    const userRepository = AppDataSource.getRepository(User);

    const newUser = userRepository.create({
      kakaoId: kakaoId!,
      userName: kakaoNickname || null,
      isActivated: 1,
      createdDate: new Date(),
    });

    const savedUser = await userRepository.save(newUser);
    return savedUser.userId;
  }
}

const authServiceInstance = new AuthService();
export default authServiceInstance;

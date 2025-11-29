import authServiceInstance from "../services/authService";
import { UserType } from "../services/authService";

export type KakaoUserSignType = {
  kakaoId: string;
  kakaoNickname: string;
  accessToken: string;
};

class AuthController {
  constructor() {}

  async postKakaoSignInUp({
    kakaoUserSign,
  }: {
    kakaoUserSign: KakaoUserSignType;
  }) {
    try {
      const { accessToken, kakaoNickname } = kakaoUserSign;

      // 카카오 accessToken 검증 요청, 응답으로 kakaoId 수신
      const kakaoId = await authServiceInstance.getKakaoId({ accessToken });
      // 카카오로부터 응답받은 kakaoId 로 내부 Users 테이블 유저 검색
      const [user] = await authServiceInstance.getUserBy({
        kakaoIds: [kakaoId],
        isActivateds: [1 as Pick<UserType, "isActivated">],
      });
      const loginType = "KAKAO";
      let userId;
      // 내부 Users 테이블에 없을 경우 회원가입 처리
      if (!user) {
        userId = await authServiceInstance.userSignUp({
          user: { kakaoId, kakaoNickname } as UserType,
        });
        return { userId, loginType };
        // return userId;
      }
      // 로그인한 userId 응답
      userId = user.userId;
      // console.log("userId", userId);
      return { userId, loginType };
      // return userId;
    } catch (err) {
      throw err;
      // utilServiceInstance.handleError(err);
    }
  }
}

const authControllerInstance = new AuthController();
export default authControllerInstance;

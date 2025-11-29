import express from "express";
import { Request, Response } from "express";
import authControllerInstance from "../../controllers/authController";

const authRouter = express.Router();

/**
 * @swagger
 *  tags:
 *  name: auth
 *  description: 로그인 auth 관련
 */

/**
 * @swagger
 * components:
 *   securitySchemes:
 *     cookieAuth:
 *       type: apiKey
 *       in: cookie
 *       name: access_token
 * paths:
 *   /api/v1/auth/kakao:
 *     post:
 *       summary: '카카오 로그인 & 회원가입'
 *       description: '카카오 로그인 & 회원가입'
 *       tags: [auth]
 *       security:
 *         - cookieAuth: []
 *       requestBody:
 *         description:
 *         content:
 *           application/json:
 *             examples:
 *               body:
 *                 summary: 'example body'
 *                 value: {
 *                   kakaoNickname: 'kakao_test_nick',
 *                   accessToken: "asefwefhiowehgwioehgow"
 *                 }
 *       responses:
 *         200:
 *           description: 성공
 *           content:
 *             application/json:
 *               schema:
 *                 type: object
 *                 properties:
 *                   result:
 *                     type: object
 *                     properties:
 *         201:
 *           description: 삽입 성공
 *         400:
 *           description: 나쁜 요청
 *         401:
 *           description: 유효하지 않은 앱키나 토큰으로 요청
 *         404:
 *           description: 해당 자원을 찾을 수 없음
 *         500:
 *           description: 내부 서버 오류
 */
authRouter.post("/kakao", async (req: Request, res: Response) => {
  const kakaoUserSign = req.body;
  const { userId, loginType } = await authControllerInstance.postKakaoSignInUp({
    kakaoUserSign,
  });
  const status = 200;
  res.status(status).json({ message: "KAKAO LOGIN SUCCESS", userId, loginType });
});

export default authRouter;

import express from "express";
import { Request, Response } from "express";
import discordControllerInstance from "../../controllers/discordController";

const discordRouter = express.Router();

/**
 * @swagger
 *  tags:
 *  name: discord
 *  description: 디스코드
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
 *   /api/discord:
 *     get:
 *       summary: '디스코드 기본 api'
 *       description: '디스코드 기본 api'
 *       tags: [discord]
 *       security:
 *         - cookieAuth: []
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
discordRouter.get("/", (req: Request, res: Response) => {
  const status = 200;
  res.status(status).json({ message: "DISCORD ROUTER" });
});

/**
 * @swagger
 * components:
 *   securitySchemes:
 *     cookieAuth:
 *       type: apiKey
 *       in: cookie
 *       name: access_token
 * paths:
 *   /api/discord/{discordId}/message:
 *     post:
 *       summary: '디스코드 discordId 별 메세지 전송 api'
 *       description: '디스코드 기본 api'
 *       tags: [discord]
 *       security:
 *         - cookieAuth: []
 *       parameters:
 *         - name: discordId
 *           in: path
 *           description: discordId(고유PK)
 *           schema:
 *             type: string
 *       requestBody:
 *         description: >
 *           '디스코드 메세지 전송 api body 기본 예제'
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   description: '메세지 내용'
 *               required: []
 *             examples:
 *               request body:
 *                 summary: 'body example'
 *                 value: {
 *                   message: '디스코드 전송할 메세지 내용'
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
discordRouter.post(
  "/:discordId/message",
  async (req: Request, res: Response) => {
    const discordId: string = req.params.discordId?.toString();
    const message: string = req.body.message;
    await discordControllerInstance.postDiscordMessageCont({
      discordId,
      message,
    });
    const status = 200;
    res.status(status).json({ message: "SUCCESS" });
  }
);

export default discordRouter;

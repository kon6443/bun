import { oracleAutonomousRepository } from "../repositories/oracleAutonomousRepository";
import utilServiceInstance from "./utils";

export type UserType = {
  kakaoId?: string;
  kakaoNickname?: string;
  isActivated?: 0 | 1;
};

class AuthService {
  constructor() {}

  async getKakaoId({
    accessToken,
  }: {
    accessToken?: string;
  }): Promise<Pick<UserType, "kakaoId">> {
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
    const user = await kakaoRes.json();
    return user.id;
  }

  async getUserBy({
    kakaoIds,
    isActivateds,
  }: {
    kakaoIds: Pick<UserType, "kakaoId">[];
    isActivateds?: Pick<UserType, "isActivated">[];
  }) {
    const selects: string[] = [
      "u.userId",
      "u.userName",
      "u.birth",
      "u.kakaoId",
      "u.kakaoEmail",
      "u.createdDate",
      "u.isActivated",
    ];
    const wheres: string[] = [];
    const values: { [key: string]: Pick<UserType, "kakaoId" | "isActivated"> } =
      {};

    if (kakaoIds[0]) {
      const kakaoIdStmt: string = kakaoIds
        .map((kakaoId, i: number) => {
          values[`kakaoId${i}`] = kakaoId;
          return `:kakaoId${i}`;
        })
        .join(", ");
      wheres.push(`u.kakaoId IN (${kakaoIdStmt})`);
    }

    if (isActivateds?.length) {
      const isActivatedStmt: string = isActivateds
        .map((isActivated, i: number) => {
          values[`isActivated${i}`] = isActivated;
          return `:isActivated${i}`;
        })
        .join(", ");
      wheres.push(`u.isActivated IN (${isActivatedStmt})`);
    }

    const whereStmt: string = wheres[0]
      ? `WHERE\n  ${wheres.join(" AND ")}`
      : "";
    const selectStmt: string = `
    SELECT ${selects.join(", ")}
    FROM Users u
    ${whereStmt}`;
    const users = await oracleAutonomousRepository.execute(
      selectStmt,
      values as any
    );
    return users;
  }

  async userSignUp({ user }: { user: UserType }) {
    const { kakaoNickname, kakaoId } = user;
    const inserts: string[] = [];
    const values: {
      [key: string]: Pick<
        UserType,
        "kakaoId" | "isActivated" | "kakaoNickname"
      >;
    } = {};
    if (kakaoId) {
      inserts.push(":kakaoId");
      values.kakaoId = kakaoId as Pick<UserType, "kakaoId">;
    }
    if (kakaoNickname) {
      inserts.push(":userName");
      values.userName = kakaoNickname as Pick<UserType, "kakaoNickname">;
    }
    const insertStmt: string = `
    INSERT INTO users (${inserts.map((col) => col.replace(":", "")).join(", ")})
    VALUES (${inserts.join(", ")})
    RETURNING userId INTO :userId`;
    const res = await oracleAutonomousRepository.execute(
      insertStmt,
      values as any
    );
    return res.outBinds?.userId[0];
  }
}

const authServiceInstance = new AuthService();
export default authServiceInstance;

import oracledb from "oracledb";
import dotenv from "dotenv";

dotenv.config();

// 데이터베이스 설정을 위한 인터페이스
type OracleConfigType = {
  user?: string;
  password?: string;
  connectString?: string;
};

const dbConfig: OracleConfigType = {
  user: process.env.ORACLE_DB_USER,
  password: process.env.ORACLE_DB_PW,
  connectString: process.env.ORACLE_DB_CONNECT_STR,
};

class OracleAutonomousRepository {
  private pool: oracledb.Pool | undefined;

  /**
   * 데이터베이스 커넥션 풀을 초기화합니다.
   * 애플리케이션 시작 시 한 번 호출해야 합니다.
   */
  async initialize() {
    try {
      console.log("데이터베이스 커넥션 풀을 초기화합니다...");
      // oracledb.initOracleClient({ libDir: '/opt/oracle/instantclient' }); // Instant Client 경로 설정이 필요한 경우
      oracledb.initOracleClient({
        libDir: process.env.ORACLE_LIB_DIR,
        configDir: process.env.ORACLE_WALLET_PATH,
      });
      this.pool = await oracledb.createPool({
        ...dbConfig,
        poolMin: 1,
        poolMax: 10,
        poolIncrement: 1,
      });
      console.log("데이터베이스 커넥션 풀이 성공적으로 초기화되었습니다.");
    } catch (err) {
      console.error("데이터베이스 풀 초기화 중 오류 발생:", err);
      throw err;
    }
  }

  /**
   * SQL 쿼리를 실행합니다.
   * @param sql 실행할 SQL 쿼리
   * @param binds 쿼리에 대한 바인드 변수
   * @param options 쿼리 실행 옵션
   * @returns 쿼리 실행 결과
   */
  async execute<T>(
    sql: string,
    binds: oracledb.BindParameters = {},
    options: oracledb.ExecuteOptions = {}
    //   ): Promise<oracledb.Result<T> | undefined> {
  ): Promise<any | undefined> {
    let connection: oracledb.Connection | undefined;
    if (!this.pool) {
      console.error(
        "데이터베이스 풀이 초기화되지 않았습니다. initialize()를 먼저 호출하세요."
      );
      return;
    }

    try {
      connection = await this.pool.getConnection();
      const defaultOptions: oracledb.ExecuteOptions = {
        autoCommit: true, // INSERT, UPDATE, DELETE 시 자동 커밋
        outFormat: oracledb.OUT_FORMAT_OBJECT, // 결과를 객체 배열로 받음
        ...options,
      };

      const result: oracledb.Result<T> = await connection.execute(
        sql,
        binds,
        defaultOptions
      );
      return result ? result.rows : undefined;
    } catch (err) {
      console.error("쿼리 실행 중 오류 발생:", err);
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (err) {
          console.error("커넥션 종료 중 오류 발생:", err);
        }
      }
    }
  }

  /**
   * 데이터베이스 커넥션 풀을 닫습니다.
   * 애플리케이션이 정상적으로 종료될 때 호출해야 합니다.
   */
  async close() {
    if (this.pool) {
      try {
        console.log("데이터베이스 커넥션 풀을 닫습니다...");
        await this.pool.close(10);
        this.pool = undefined;
        console.log("데이터베이스 커넥션 풀이 닫혔습니다.");
      } catch (err) {
        console.error("데이터베이스 풀 종료 중 오류 발생:", err);
      }
    }
  }
}

export const oracleAutonomousRepository = new OracleAutonomousRepository();

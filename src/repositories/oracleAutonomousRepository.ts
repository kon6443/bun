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

  // snakeToCamel(str: string) {
  //   return str.replace(/_([a-z])/g, function (match, group1) {
  //     return group1.toUpperCase();
  //   });
  // }

  // snakeToCamel(s: string): string {
  //   return s.replace(/([-_][a-z])/g, (group) =>
  //     group.toUpperCase().replace("_", "")
  //   );
  // }

  snakeToCamel(s: string): string {
    return s
      .toLowerCase()
      .replace(/([-_][a-z])/g, (group) => group.toUpperCase().replace("_", ""));
  }

  camelToSnake(s: string): string {
    return s
      .replace(/([A-Z])/g, (c) => `_${c.toLowerCase()}`) // uppercase 앞에 _
      .replace(/^_/, "");
    // return (
    //   s
    //     // 첫 글자는 무조건 소문자로
    //     .replace(/^[A-Z]/, (c) => c.toLowerCase())
    //     // "myFieldName" → "my_field_name"
    //     .replace(/([A-Z])/g, (c) => "_" + c.toLowerCase())
    // );
  }

  keysToSnake<T extends object>(obj: T): Record<string, any> {
    if (obj == null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map((i) => this.keysToSnake(i)) as any;
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [
        this.camelToSnake(k),
        this.keysToSnake(v),
      ])
    );
  }

  keysToCamel = (o: any): any => {
    if (Array.isArray(o)) {
      return o.map(this.keysToCamel);
    } else if (o !== null && typeof o === "object") {
      return Object.fromEntries(
        Object.entries(o).map(([k, v]) => [
          this.snakeToCamel(k),
          this.keysToCamel(v),
        ])
      );
    }
    return o;
  };

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

      // const snakeKey = (key: string) =>
      //   this.camelToSnake(key).replace(/^_/, "");
      // sql = sql.replace(/:([A-Za-z]\w*)/g, (_, key) => `:${snakeKey(key)}`);
      sql = sql
        .replace(/:([A-Za-z]\w*)\b/g, (_, key) => `:${this.camelToSnake(key)}`)
        .replace(
          /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z]\w*)\b/g,
          (_, alias, col) => `${alias}.${this.camelToSnake(col)}`
        )
        // ③ INSERT INTO 테이블(col1, col2, …) 컬럼 리스트 변환
        .replace(
          /(\bINSERT\s+INTO\s+[A-Za-z_]\w*\b\s*)\(([^)]+)\)/gi,
          (_, prefix, list) => {
            const cols = list
              .split(/\s*,\s*/)
              .map((c) => this.camelToSnake(c.trim()));
            return `${prefix}(${cols.join(", ")})`;
          }
        )
        .replace(
          /(RETURNING\s+)([\w\s,:]+)(\s+INTO\s+[\w\s,:]+)/gi,
          (_, prefix, cols, suffix) => {
            const colList = cols
              .split(",")
              .map((col) => this.camelToSnake(col.trim()))
              .join(", ");
            return `${prefix}${colList}${suffix}`;
          }
        );
      binds = this.keysToSnake(binds);
      // if (sql.includes("RETURNING")) {
      //   binds.new_id = { dir: oracledb.BIND_OUT, type: oracledb.NUMBER };
      // }
      if (sql.includes("RETURNING")) {
        const match = sql.match(/RETURNING\s+(.+?)\s+INTO\s+(.+)/i);
        if (match) {
          const intoFields = match[2]
            .split(",")
            .map((field) => field.trim().replace(/^:/, ""));
          for (const field of intoFields) {
            // oracledb.BIND_OUT = 3003, NUMBER은 원하는 타입으로 고정 or 동적 처리 가능
            binds[field] = { dir: oracledb.BIND_OUT, type: oracledb.NUMBER };
          }
        }
      }
      const result: oracledb.Result<T> = await connection.execute(
        sql,
        binds,
        defaultOptions
      );
      // if (!result) return undefined;
      // return Array.isArray(result)
      //   ? result.rows?.map((r) => this.keysToCamel(r))
      //   : result;

      if (result.rows) {
        return result.rows.map((row) => this.keysToCamel(row as any));
      }

      if (result.rowsAffected) {
        return {
          success: true,
          outBinds: this.keysToCamel(result.outBinds),
          // rowsAffected: result.rowsAffected,
        };
      }

      // return result.rows?.map((r) => this.keysToCamel(r));
      // return result ? result.rows : undefined;
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

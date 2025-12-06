import "reflect-metadata";
import { DataSource } from "typeorm";
import dotenv from "dotenv";
import oracledb from "oracledb";

dotenv.config();

// Oracle Client 초기화 (기존 설정과 동일)
if (process.env.ORACLE_LIB_DIR && process.env.ORACLE_WALLET_PATH) {
  oracledb.initOracleClient({
    libDir: process.env.ORACLE_LIB_DIR,
    configDir: process.env.ORACLE_WALLET_PATH,
  });
}

export const AppDataSource = new DataSource({
  type: "oracle",
  username: process.env.ORACLE_DB_USER,
  password: process.env.ORACLE_DB_PW,
  connectString: process.env.ORACLE_DB_CONNECT_STR,
  synchronize: false, // 프로덕션에서는 false로 설정 (스키마 자동 변경 비활성화)
  logging: process.env.NODE_ENV === "development", // 개발 환경에서만 SQL 로깅
  entities: [__dirname + "/../entities/**/*.{ts,js}"],
  migrations: [__dirname + "/../migrations/**/*.{ts,js}"],
  subscribers: [__dirname + "/../subscribers/**/*.{ts,js}"],
  extra: {
    poolMin: 1,
    poolMax: 3,
    poolIncrement: 1,
  },
  // Oracle에서 테이블명 대소문자 처리
  namingStrategy: undefined, // 기본 전략 사용
});


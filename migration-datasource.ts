import 'reflect-metadata';
import dotenv from 'dotenv';
import oracledb from 'oracledb';
import { DataSource } from 'typeorm';

dotenv.config();

// Oracle thick client init (미설정 시 wallet 접속 불가) — src/app.module.ts 런타임 초기화와 동일
if (process.env.ORACLE_LIB_DIR && process.env.ORACLE_WALLET_PATH) {
  oracledb.initOracleClient({
    libDir: process.env.ORACLE_LIB_DIR,
    configDir: process.env.ORACLE_WALLET_PATH,
  });
}

// CLI 전용 DataSource — 런타임(src/config/database.config.ts)과 완전 분리.
// LOCAL/PROD 동일 DB: migration:run/revert는 담당자가 직접 실행한다 (AI·자동화 금지, docs/tasks-nestjs-improvements.md D33).
export default new DataSource({
  type: 'oracle',
  username: process.env.ORACLE_DB_USER,
  password: process.env.ORACLE_DB_PW,
  connectString: process.env.ORACLE_DB_CONNECT_STR,
  entities: ['src/entities/*.ts'],
  migrations: ['migrations/*.ts'],
  migrationsTableName: 'TYPEORM_MIGRATIONS',
  synchronize: false,
  migrationsRun: false,
  logging: true,
});

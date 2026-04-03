/**
 * 환경변수 검증 (외부 의존성 없이 순수 TS로 구현)
 * ConfigModule의 validate 옵션에서 사용
 */

interface EnvConfig {
  [key: string]: string | undefined;
}

class EnvironmentVariables {
  // DB (필수)
  ORACLE_DB_USER: string;
  ORACLE_DB_PW: string;
  ORACLE_DB_CONNECT_STR: string;

  // JWT (필수)
  JWT_SECRET: string;

  // 서버
  EXPRESS_PORT: number;
  ENV: string;
}

export function validateEnv(config: EnvConfig): EnvConfig {
  const required: string[] = [
    'ORACLE_DB_USER',
    'ORACLE_DB_PW',
    'ORACLE_DB_CONNECT_STR',
    'JWT_SECRET',
    'NEXT_PUBLIC_DOMAIN',
  ];

  const missing = required.filter((key) => !config[key]);

  if (missing.length > 0) {
    throw new Error(
      `필수 환경변수가 누락되었습니다: ${missing.join(', ')}\n` +
        `.env 파일을 확인해주세요.`,
    );
  }

  const env = config['ENV']?.toUpperCase();
  const validEnvs = ['LOCAL', 'QA', 'PROD'];
  if (env && !validEnvs.includes(env)) {
    throw new Error(
      `ENV 값이 올바르지 않습니다: "${config['ENV']}" (허용값: ${validEnvs.join(', ')})`,
    );
  }

  const port = config['EXPRESS_PORT'];
  if (port && isNaN(Number(port))) {
    throw new Error(`EXPRESS_PORT는 숫자여야 합니다: "${port}"`);
  }

  const logLevel = config['LOG_LEVEL'];
  const validLogLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
  if (logLevel && !validLogLevels.includes(logLevel)) {
    throw new Error(
      `LOG_LEVEL 값이 올바르지 않습니다: "${logLevel}" (허용값: ${validLogLevels.join(', ')})`,
    );
  }

  const redisPort = config['REDIS_PORT'];
  if (redisPort && isNaN(Number(redisPort))) {
    throw new Error(`REDIS_PORT는 숫자여야 합니다: "${redisPort}"`);
  }

  return config;
}

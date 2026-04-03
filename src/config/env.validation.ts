/**
 * 환경변수 검증 (class-validator + class-transformer 기반)
 * ConfigModule의 validate 옵션에서 사용
 *
 * NestJS 공식 권장 패턴:
 * https://docs.nestjs.com/techniques/configuration#custom-validate-function
 */

import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  validateSync,
} from 'class-validator';

class EnvironmentVariables {
  // DB (필수)
  @IsNotEmpty({ message: 'ORACLE_DB_USER 환경변수가 누락되었습니다.' })
  @IsString()
  ORACLE_DB_USER: string;

  @IsNotEmpty({ message: 'ORACLE_DB_PW 환경변수가 누락되었습니다.' })
  @IsString()
  ORACLE_DB_PW: string;

  @IsNotEmpty({ message: 'ORACLE_DB_CONNECT_STR 환경변수가 누락되었습니다.' })
  @IsString()
  ORACLE_DB_CONNECT_STR: string;

  // JWT (필수)
  @IsNotEmpty({ message: 'JWT_SECRET 환경변수가 누락되었습니다.' })
  @IsString()
  JWT_SECRET: string;

  // 도메인 (필수)
  @IsNotEmpty({ message: 'NEXT_PUBLIC_DOMAIN 환경변수가 누락되었습니다.' })
  @IsString()
  NEXT_PUBLIC_DOMAIN: string;

  // 서버 (선택)
  @IsOptional()
  @IsNumberString({}, { message: 'EXPRESS_PORT는 숫자여야 합니다.' })
  EXPRESS_PORT?: string;

  @IsOptional()
  @IsIn(['LOCAL', 'QA', 'PROD', 'local', 'qa', 'prod'], {
    message: 'ENV 값이 올바르지 않습니다. (허용값: LOCAL, QA, PROD)',
  })
  ENV?: string;

  // 로깅 (선택)
  @IsOptional()
  @IsIn(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], {
    message: 'LOG_LEVEL 값이 올바르지 않습니다. (허용값: fatal, error, warn, info, debug, trace, silent)',
  })
  LOG_LEVEL?: string;

  // Redis (선택)
  @IsOptional()
  @IsNumberString({}, { message: 'REDIS_PORT는 숫자여야 합니다.' })
  REDIS_PORT?: string;
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const messages = errors
      .map((e) => Object.values(e.constraints || {}).join(', '))
      .join('\n  - ');
    throw new Error(`환경변수 검증 실패:\n  - ${messages}\n\n.env 파일을 확인해주세요.`);
  }

  return config;
}

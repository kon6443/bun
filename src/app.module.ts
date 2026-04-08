// crypto 모듈을 전역으로 사용 가능하도록 설정 (Node.js 18 호환성)
import { randomUUID } from 'crypto';
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = {
    randomUUID,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

import { Module, ValidationPipe } from '@nestjs/common';
import { THROTTLE_SHORT, THROTTLE_LONG } from './common/constants/throttle.constants';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { CustomThrottlerGuard } from './common/guards/custom-throttler.guard';
import { ApiValidationErrorResponseDto } from './common/dto/api-error.dto';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { MainModule } from './modules/main/main.module';
import { AuthModule } from './modules/auth/auth.module';
import { TeamModule } from './modules/team/team.module';
import { FileShareModule } from './modules/file-share/file-share.module';
import { NotificationModule } from './modules/notification/notification.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { UsersModule } from './modules/users/users.module';
import { FishingModule } from './modules/fishing/fishing.module';
import { LoggerModule } from './common/logger/logger.module';
import databaseConfig from './config/database.config';
import oracleConfig from './config/oracle.config';
import { validateEnv } from './config/env.validation';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import oracledb from 'oracledb';
import { Logger } from '@nestjs/common';

const logger = new Logger('AppModule');

@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          whitelist: true,
          transform: true,
          forbidNonWhitelisted: true,
          transformOptions: {
            enableImplicitConversion: true,
          },
          exceptionFactory: (errors) => {
            const messages = errors
              .map((e) => Object.values(e.constraints || {}).join(', '))
              .join('; ');
            return new ApiValidationErrorResponseDto(
              messages || '요청 값이 올바르지 않습니다.',
            );
          },
        }),
    },
  ],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, oracleConfig],
      envFilePath: '.env',
      validate: validateEnv,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService): TypeOrmModuleOptions => {
        // Oracle Client 초기화 (ConfigService 사용)
        const oracleConfig = configService.get('oracle');
        if (oracleConfig?.libDir && oracleConfig?.walletPath) {
          oracledb.initOracleClient({
            libDir: oracleConfig.libDir,
            configDir: oracleConfig.walletPath,
          });
          logger.log('Oracle Client initialized');
        } else {
          logger.warn(
            'Oracle Client initialization skipped (ORACLE_LIB_DIR or ORACLE_WALLET_PATH not set)',
          );
        }

        const databaseConfig = configService.get<TypeOrmModuleOptions>('database');
        if (!databaseConfig) {
          throw new Error('Database configuration is missing');
        }
        return databaseConfig;
      },
      inject: [ConfigService],
    }),
    ThrottlerModule.forRoot([
      { name: 'short', ...THROTTLE_SHORT },     // 초당 5회 (순간 폭발 방지)
      { name: 'long', ...THROTTLE_LONG },       // 분당 60회 (지속 남용 방지)
    ]),
    ScheduleModule.forRoot(),
    LoggerModule,
    MainModule,
    AuthModule,
    TeamModule,
    FileShareModule,
    NotificationModule,
    SchedulerModule,
    UsersModule,
    FishingModule,
  ],
})
export class AppModule {}


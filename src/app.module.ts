// crypto 모듈을 전역으로 사용 가능하도록 설정 (Node.js 18 호환성)
import { randomUUID } from 'crypto';
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = {
    randomUUID,
  } as any;
}

import { Module } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { MainModule } from './modules/main/main.module';
import { AuthModule } from './modules/auth/auth.module';
import { TeamModule } from './modules/team/team.module';
import { FileShareModule } from './modules/file-share/file-share.module';
import { NotificationModule } from './modules/notification/notification.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import databaseConfig from './config/database.config';
import oracleConfig from './config/oracle.config';
import oracledb from 'oracledb';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, oracleConfig],
      envFilePath: '.env',
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
          console.log('Oracle Client initialized');
        } else {
          console.warn(
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
    ScheduleModule.forRoot(),
    MainModule,
    AuthModule,
    TeamModule,
    FileShareModule,
    NotificationModule,
    SchedulerModule,
  ],
})
export class AppModule {}


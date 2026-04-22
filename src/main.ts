import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { register } from 'prom-client';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';
import { OnlineUserService } from './modules/team/online-user.service';
import { FishingOnlineService } from './modules/fishing/fishing-online.service';
import { ConfigService } from '@nestjs/config';
import { GRACEFUL_SHUTDOWN_TIMEOUT_MS } from './common/constants/app.constants';
import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { ALLOWED_ORIGINS } from './common/constants/cors.constants';

async function bootstrap() {
  // 모든 Prometheus 메트릭에 Swarm 레플리카 식별자 주입.
  // docker-stack.app.yml 의 TASK_SLOT={{.Task.Slot}} 환경변수(1/2/3 …)로 전달됨.
  // LOCAL 은 미설정 → '0'. AppModule 로드(= PrometheusModule.register) 전에 호출해야
  // default metrics 에도 라벨이 붙는다.
  register.setDefaultLabels({
    replica: process.env.TASK_SLOT ?? '0',
  });

  const logger = new Logger('Bootstrap');

  try {
    const app = await NestFactory.create(AppModule, {
      bufferLogs: true,
    });

    // Pino Logger 활성화 (bufferLogs 해제)
    app.useLogger(app.get(PinoLogger));

    const configService = app.get(ConfigService);

    // TypeORM 연결 상태 확인 (Nest.js 정석 방식)
    // TypeORM 연결이 실패하면 앱이 시작되지 않아야 하므로,
    // 여기까지 왔다면 연결이 성공한 것입니다.
    logger.log('TypeORM connection established successfully');

    const isLocal = configService.get<string>('ENV')?.toUpperCase() === 'LOCAL';
    const port = configService.get<number>('EXPRESS_PORT') || 3500;

    // 전역 Filter/Pipe는 AppModule providers에서 DI 기반으로 등록됨
    // (APP_FILTER → HttpExceptionFilter, APP_PIPE → ValidationPipe)
    // 전역 인터셉터: pino-http가 요청 로깅 자동 처리

    // CORS 설정 (전역 상수 사용)
    app.enableCors({
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        if (!origin || ALLOWED_ORIGINS.indexOf(origin) !== -1) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
    });

    // WebSocket Adapter 설정 - Redis Pub/Sub으로 멀티 레플리카 지원
    const redisAdapter = new RedisIoAdapter(app);
    await redisAdapter.connectToRedis();
    app.useWebSocketAdapter(redisAdapter);

    // Redis 클라이언트를 OnlineUserService에 주입
    const onlineUserService = app.get(OnlineUserService);
    onlineUserService.setRedisClient(redisAdapter.getPubClient());

    // Redis 클라이언트를 FishingOnlineService에 주입
    const fishingOnlineService = app.get(FishingOnlineService);
    fishingOnlineService.setRedisClient(redisAdapter.getPubClient());

    logger.log('WebSocket RedisIoAdapter 설정 완료');

    // Docker Swarm 프록시 뒤의 실제 클라이언트 IP (X-Forwarded-For)
    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.set('trust proxy', 1);

    // 보안 미들웨어
    app.use(helmet());
    app.use(cookieParser());
    app.use(compression());

    // Swagger UI를 `/api/v1/docs/`(트레일링 슬래시)로 열면,
    // HTML 내부의 상대 경로가 잘못 해석되어
    // 정적 리소스(css/js)가 404가 나며 화면이 하얗게 보일 수 있습니다.
    // `/api/v1/docs/` -> `/api/v1/docs`로 리다이렉트하여 항상 정상 경로로 로드되게 합니다.
    app.use((req: Request, res: Response, next: NextFunction) => {
      const originalUrl: string = req?.originalUrl ?? '';
      if (originalUrl === '/api/v1/docs/' || originalUrl.startsWith('/api/v1/docs/?')) {
        return res.redirect(originalUrl.replace('/api/v1/docs/', '/api/v1/docs'));
      }
      return next();
    });

    // 글로벌 프리픽스
    app.setGlobalPrefix('api/v1');

    // Swagger 설정
    if (isLocal) {
      const config = new DocumentBuilder()
        .setTitle('FiveSouth Swagger API Documents')
        .setDescription('FiveSouth Swagger API Documents')
        .setVersion('1.0.0')
        .addCookieAuth('access_token', {
          type: 'apiKey',
          in: 'cookie',
          name: 'access_token',
        })
        .build();
      const document = SwaggerModule.createDocument(app, config);
      SwaggerModule.setup('api/v1/docs', app, document, {
        swaggerOptions: { persistAuthorization: true },
      });
      logger.log('Swagger documentation available at /api/v1/docs');
    }

    // NestJS 라이프사이클 훅 활성화 (OnModuleDestroy 등)
    app.enableShutdownHooks();

    await app.listen(port, '0.0.0.0');
    logger.log(`Application is running on: http://0.0.0.0:${port}`);
    logger.log(`Health check: http://localhost:${port}/api/v1/health-check`);

    // Graceful Shutdown
    let isShuttingDown = false;
    const shutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.log(`${signal} 수신, graceful shutdown 시작...`);

      const timer = setTimeout(() => {
        logger.error('Graceful shutdown 타임아웃, 강제 종료');
        process.exit(1);
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
      timer.unref();

      try {
        await redisAdapter.disconnect();
        await app.close();
        logger.log('Graceful shutdown 완료');
        process.exit(0);
      } catch (error) {
        logger.error('Graceful shutdown 실패:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

// 예기치 않은 에러로 서버가 죽는 것 방지
process.on('uncaughtException', (error) => {
  const logger = new Logger('UncaughtException');
  logger.error('Uncaught Exception — 서버는 계속 실행됩니다:', error);
});

process.on('unhandledRejection', (reason) => {
  const logger = new Logger('UnhandledRejection');
  logger.error('Unhandled Rejection — 서버는 계속 실행됩니다:', reason);
});

void bootstrap();

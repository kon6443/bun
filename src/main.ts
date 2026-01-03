import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  try {
    const app = await NestFactory.create(AppModule, {
      logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    });

    const configService = app.get(ConfigService);

    // TypeORM 연결 상태 확인 (Nest.js 정석 방식)
    // TypeORM 연결이 실패하면 앱이 시작되지 않아야 하므로,
    // 여기까지 왔다면 연결이 성공한 것입니다.
    logger.log('TypeORM connection established successfully');

    const isLocal = configService.get<string>('ENV')?.toUpperCase() === 'LOCAL';
    const port = configService.get<number>('EXPRESS_PORT') || 3500;
    const domain = configService.get<string>('DOMAIN');

    // 전역 예외 필터 (Nest.js 정석 방식)
    app.useGlobalFilters(new HttpExceptionFilter());

    // 전역 인터셉터 (Nest.js 정석 방식)
    app.useGlobalInterceptors(new LoggingInterceptor(configService));

    // CORS 설정
    const allowedOrigins = [
      'http://localhost',
      'http://localhost:3000',
      'http://localhost:3500',
      'https://fivesouth.duckdns.org',
    ];

    app.enableCors({
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
    });

    // 보안 미들웨어
    app.use(helmet());
    app.use(cookieParser());

    // Swagger UI를 `/api-docs/`(트레일링 슬래시)로 열면,
    // HTML 내부의 상대 경로(`./api-docs/*`)가 `/api-docs/api-docs/*`로 해석되어
    // 정적 리소스(css/js)가 404가 나며 화면이 하얗게 보일 수 있습니다.
    // `/api-docs/` -> `/api-docs`로 리다이렉트하여 항상 정상 경로로 로드되게 합니다.
    app.use((req: any, res: any, next: any) => {
      const originalUrl: string = req?.originalUrl ?? '';
      if (originalUrl === '/api-docs/' || originalUrl.startsWith('/api-docs/?')) {
        return res.redirect(originalUrl.replace('/api-docs/', '/api-docs'));
      }
      return next();
    });

    // 전역 유효성 검사 파이프 (Nest.js 정석 방식)
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: {
          enableImplicitConversion: true,
        },
      }),
    );

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
      SwaggerModule.setup('api-docs', app, document);
      logger.log('Swagger documentation available at /api-docs');
    }

    // 글로벌 프리픽스
    app.setGlobalPrefix('api/v1');

    await app.listen(port, '0.0.0.0');
    logger.log(`Application is running on: http://0.0.0.0:${port}`);
    logger.log(`Health check: http://localhost:${port}/api/v1/health-check`);
  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

bootstrap();

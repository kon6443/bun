import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Params, LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { join } from 'path';
import pino from 'pino';
import { LOG_ROTATION_COUNT } from '../constants/app.constants';

/**
 * 민감 정보를 마스킹하는 함수
 */
function redactSensitiveData(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveData);
  }

  const sensitiveKeys = [
    'password',
    'token',
    'authorization',
    'secret',
    'apikey',
    'accesstoken',
    'refreshtoken',
    'bearer',
    'credentials',
    'cookie',
  ];

  const redacted = {} as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveKeys.some((sk) => lowerKey.includes(sk));

    if (isSensitive) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveData(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * LoggerModule 설정
 * - LOCAL: pino-pretty (컬러 콘솔) + pino-roll (파일 rotation)
 * - QA/PROD: JSON stdout 출력
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Params => {
        const env = (configService.get<string>('ENV') || 'LOCAL').toUpperCase();
        const logLevel = configService.get<string>('LOG_LEVEL', 'debug');
        const isLocal = env === 'LOCAL';

        const serializers = {
          req: (req: {
            id?: string;
            method?: string;
            url?: string;
            headers?: Record<string, unknown>;
            remoteAddress?: string;
            remotePort?: number;
          }) => ({
            id: req.id,
            method: req.method,
            url: req.url,
            headers: redactSensitiveData(req.headers),
            remoteAddress: req.remoteAddress,
            remotePort: req.remotePort,
          }),
          res: (res: { statusCode?: number; headers?: Record<string, unknown> }) => ({
            statusCode: res.statusCode,
            headers: redactSensitiveData(res.headers),
          }),
          err: pino.stdSerializers.err,
        };

        const genReqId = (req: { headers?: Record<string, unknown> }) =>
          (req.headers?.['x-request-id'] as string) ||
          `req-${Date.now()}-${Math.random().toString(36).substring(7)}`;

        const baseHttpOptions = {
          level: logLevel,
          timestamp: pino.stdTimeFunctions.isoTime,
          serializers,
          customProps: () => ({ context: 'HTTP' }),
          genReqId,
        };

        // LOCAL: pretty print + 파일 로깅
        // transport.targets 사용 시 formatters.level 함수 전달 불가 (worker thread 제약)
        // pino-pretty가 자체적으로 level을 문자열로 포맷하므로 문제 없음
        if (isLocal) {
          return {
            pinoHttp: {
              ...baseHttpOptions,
              transport: {
                targets: [
                  {
                    target: 'pino-pretty',
                    options: {
                      colorize: true,
                      translateTime: 'SYS:standard',
                      ignore: 'pid,hostname',
                      singleLine: false,
                    },
                    level: logLevel,
                  },
                  {
                    target: 'pino-roll',
                    options: {
                      file: join(process.cwd(), 'logs', 'app'),
                      frequency: 'daily',
                      mkdir: true,
                      limit: { count: LOG_ROTATION_COUNT },
                    },
                    level: logLevel,
                  },
                ],
              },
            },
          };
        }

        // QA/PROD: JSON stdout — formatters 사용 가능 (transport 미사용)
        return {
          pinoHttp: {
            ...baseHttpOptions,
            formatters: {
              level: (label) => ({ level: label }),
            },
            // Loki 저장량/조회 노이즈 차단.
            // - /api/v1/metrics: Prometheus scrape (15s 간격 × replicas 분당 다수 요청)
            // - /api/v1/health-check: Docker healthcheck + 외부 모니터링 probe
            autoLogging: {
              ignore: (req: { url?: string; originalUrl?: string }) => {
                const url = (req.originalUrl || req.url || '').split('?')[0];
                return url === '/api/v1/health-check' || url === '/api/v1/metrics';
              },
            },
          },
        };
      },
    }),
  ],
})
export class LoggerModule {}

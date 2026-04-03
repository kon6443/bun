import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Params, LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { join } from 'path';
import pino from 'pino';

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

        const pinoOptions: pino.LoggerOptions = {
          level: logLevel,
          timestamp: pino.stdTimeFunctions.isoTime,
          formatters: {
            level: (label) => ({ level: label }),
          },
          serializers: {
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
          },
        };

        const genReqId = (req: { headers?: Record<string, unknown> }) =>
          (req.headers?.['x-request-id'] as string) ||
          `req-${Date.now()}-${Math.random().toString(36).substring(7)}`;

        // LOCAL: pretty print + 파일 로깅
        if (isLocal) {
          const streams: Array<{ level?: string; stream: NodeJS.WritableStream }> = [
            {
              level: logLevel,
              stream: pino.transport({
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  translateTime: 'SYS:standard',
                  ignore: 'pid,hostname',
                  singleLine: false,
                },
              }) as unknown as NodeJS.WritableStream,
            },
            {
              level: logLevel,
              stream: pino.transport({
                target: 'pino-roll',
                options: {
                  file: join(process.cwd(), 'logs', 'app'),
                  frequency: 'daily',
                  mkdir: true,
                  limit: { count: 7 },
                },
              }) as unknown as NodeJS.WritableStream,
            },
          ];

          const logger = pino(pinoOptions, pino.multistream(streams));

          return {
            pinoHttp: {
              logger,
              customProps: () => ({ context: 'HTTP' }),
              genReqId,
            },
          };
        }

        // QA/PROD: JSON stdout
        return {
          pinoHttp: {
            ...pinoOptions,
            stream: process.stdout,
            customProps: () => ({ context: 'HTTP' }),
            genReqId,
          },
        };
      },
    }),
  ],
})
export class LoggerModule {}

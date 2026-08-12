import { INestApplication, Provider, Type } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { createGlobalValidationPipe } from '../../src/common/pipes/global-validation-pipe';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { AuthUnauthorizedErrorResponseDto } from '../../src/modules/auth/auth-error.dto';
import { User } from '../../src/entities/User';

/**
 * E2E 테스트용 앱 부팅 헬퍼.
 *
 * **AppModule을 쓰지 않는다.** `AppModule`은 `TypeOrmModule.forRootAsync`를 import하므로
 * 부팅만으로 Oracle에 접속을 시도하는데, 이 프로젝트는 LOCAL/PROD가 **같은 상용 DB**라
 * 테스트가 상용에 붙는 사고가 난다(CLAUDE.md의 DB 접속 금지 규칙). 그래서 D6 전략 A —
 * Repository를 mock으로 주입하고 필요한 컨트롤러만 조립하는 방식을 쓴다.
 *
 * 대신 **HTTP 파이프라인은 프로덕션과 동일하게 재현**한다. 그게 E2E의 존재 이유다:
 *  - `APP_PIPE`: `createGlobalValidationPipe()` — AppModule과 **같은 팩토리**를 공유하므로
 *    `whitelist`·`forbidNonWhitelisted`·`enableImplicitConversion` 설정이 어긋날 수 없다
 *  - `APP_FILTER`: `HttpExceptionFilter` — 도메인 에러가 `{code, message, timestamp}`로 나가는지
 *  - `cookieParser` + `setGlobalPrefix('api/v1')`: main.ts와 동일
 *
 * 재현하지 않는 것: helmet·compression(응답 본문에 영향 없음), CORS(같은 프로세스라 무의미),
 * `CustomThrottlerGuard`(rate limit이 테스트를 깨뜨린다 — 필요하면 스펙에서 직접 조립).
 */
export interface CreateE2eAppOptions {
  controllers: Type<unknown>[];
  providers?: Provider[];
  /**
   * 인증된 사용자로 취급할 대상.
   * `undefined`면 `JwtAuthGuard`가 401을 던지는 동작을 재현한다(인증 실패 경로 검증용).
   */
  authUser?: User;
}

export interface E2eApp {
  app: INestApplication;
  moduleRef: TestingModule;
  /** 전역 prefix가 붙은 실제 경로 — `api/v1`을 매번 쓰지 않게 한다 */
  url: (path: string) => string;
}

export const createE2eApp = async ({
  controllers,
  providers = [],
  authUser,
}: CreateE2eAppOptions): Promise<E2eApp> => {
  const moduleRef = await Test.createTestingModule({
    controllers,
    providers: [
      ...providers,
      { provide: APP_FILTER, useClass: HttpExceptionFilter },
      { provide: APP_PIPE, useFactory: createGlobalValidationPipe },
    ],
  })
    // 실제 가드는 JWT 검증 + User Repository 조회를 하므로 DB가 필요하다.
    // 인증 자체는 jwt-auth.guard.spec.ts(14케이스)에서 검증했으므로 여기선 우회하고,
    // "인증된 사용자가 무엇을 할 수 있는가"에 집중한다.
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate: (ctx: {
        switchToHttp: () => { getRequest: () => { user?: User } };
      }) => {
        if (!authUser) {
          throw new AuthUnauthorizedErrorResponseDto();
        }
        ctx.switchToHttp().getRequest().user = authUser;
        return true;
      },
    })
    .compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  await app.init();

  return {
    app,
    moduleRef,
    url: (path: string) => `/api/v1${path.startsWith('/') ? path : `/${path}`}`,
  };
};

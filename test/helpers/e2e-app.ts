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
  /**
   * `true`면 `JwtAuthGuard`를 override하지 않고 **실제 가드**를 태운다.
   *
   * 인증 자체(토큰 추출·검증·유저 조회)를 검증할 때 쓴다 — 특히 "발급한 토큰으로
   * 보호된 API에 접근된다"는 왕복은 이 옵션 없이는 확인할 수 없다.
   * 이때 `providers`에 `ConfigService`(JWT_SECRET)와 User Repository를 넣어야 한다.
   */
  useRealAuthGuard?: boolean;
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
  useRealAuthGuard = false,
}: CreateE2eAppOptions): Promise<E2eApp> => {
  const builder = Test.createTestingModule({
    controllers,
    providers: [
      ...providers,
      { provide: APP_FILTER, useClass: HttpExceptionFilter },
      { provide: APP_PIPE, useFactory: createGlobalValidationPipe },
    ],
  });

  if (!useRealAuthGuard) {
    // 실제 가드는 JWT 검증 + User Repository 조회를 하므로 DB가 필요하다.
    // 인증 자체는 jwt-auth.guard.spec.ts(14케이스)에서 검증했으므로 여기선 우회하고,
    // "인증된 사용자가 무엇을 할 수 있는가"에 집중한다.
    builder.overrideGuard(JwtAuthGuard).useValue({
      canActivate: (ctx: {
        switchToHttp: () => { getRequest: () => { user?: User } };
      }) => {
        if (!authUser) {
          throw new AuthUnauthorizedErrorResponseDto();
        }
        ctx.switchToHttp().getRequest().user = authUser;
        return true;
      },
    });
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({
    // 에러 경로 테스트(502·403 등)가 정상 동작으로 error 로그를 남긴다.
    // 실패처럼 보이는 노이즈가 쌓이면 진짜 문제를 놓치므로 앱 로거를 끈다.
    // 로그 정책 자체는 http-exception.filter.spec.ts(21케이스)가 검증한다.
    logger: false,
  });
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  await app.init();

  return {
    app,
    moduleRef,
    url: (path: string) => `/api/v1${path.startsWith('/') ? path : `/${path}`}`,
  };
};

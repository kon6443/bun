---
paths:
  - "src/**/*.controller.ts"
  - "src/**/*.dto.ts"
  - "src/common/{guards,filters,pipes,decorators,dto,constants}/**/*.ts"
  - "src/main.ts"
  - "src/app.module.ts"
---

# HTTP 계층 — 컨트롤러·DTO·가드·필터

## 에러 — `defineDomainError` 팩토리

```typescript
// src/modules/<module>/<module>-error.dto.ts (공통은 src/common/dto/api-error.dto.ts)
export const TeamNotFoundErrorResponseDto = defineDomainError({
  code: 'TEAM_NOT_FOUND',
  status: 404,
  message: '팀을 찾을 수 없습니다.',
  name: 'TeamNotFoundErrorResponseDto',
});

throw new TeamNotFoundErrorResponseDto();                                   // 기본 메시지
throw new AuthUnauthorizedErrorResponseDto('카카오 액세스 토큰이 필요합니다.'); // 메시지 override
```

- 전역 `HttpExceptionFilter`(`APP_FILTER`, `src/common/filters/http-exception.filter.ts`)가 응답을 **`{ code, message, timestamp }`**로 통일한다. `details`는 있을 때만 붙는다.
  1. `ApiErrorResponseDto` 인스턴스 → DTO의 code/message/details
  2. 일반 `HttpException` → 상태코드 매핑표로 code 생성 (예: `429 → TOO_MANY_REQUESTS`)
  3. 그 외 → `INTERNAL_SERVER_ERROR` + 고정 메시지 (원본 노출 안 함)
- 응답 바디에 **`statusCode` 필드는 없다** — HTTP 상태와 `code`로 분기한다.
- 로그 레벨은 필터가 나눈다: `status >= 500`은 `error`(스택 포함), 그 외는 `warn`.
- 에러 코드·상태코드를 바꾸면 API 계약 변경이다 — 프론트(`../next-bun`) 사용처를 grep하고 커밋 본문에 대응 필요 여부를 쓴다.

## 입력 검증 — 전역 ValidationPipe 하나

`src/common/pipes/global-validation-pipe.ts`의 `createGlobalValidationPipe()`를 `app.module.ts`(`APP_PIPE`)와 E2E(`test/helpers/e2e-app.ts`)가 **공유**한다. 설정은 **이 파일에서만** 바꾼다 — 한쪽만 바꾸면 E2E가 프로덕션과 다른 규칙으로 검증한다.

```typescript
whitelist: true,              // DTO에 없는 필드 제거
forbidNonWhitelisted: true,   // 없는 필드가 오면 에러
transform: true,
transformOptions: { enableImplicitConversion: true },
exceptionFactory: → ApiValidationErrorResponseDto
```

- 암묵 변환을 쓰므로 쿼리·파라미터 숫자에 `@Type(() => Number)`를 붙이지 않는다. 날짜 DTO는 `@IsDate()` + 암묵 변환.
- 커스텀 Pipe는 만들지 않는다.
- WS 게이트웨이는 핸들러마다 `@UsePipes(new ValidationPipe({ transform: true }))`를 따로 붙인다 — 이 pipe의 옵션에는 `whitelist`·`forbidNonWhitelisted`가 없다 (`realtime-ws.md`).

## 인증/인가 — Guard는 라우트에 개별 부착

| 구분 | 수단 |
|---|---|
| HTTP 인증 | `@UseGuards(JwtAuthGuard)` + `@CurrentUser()` |
| HTTP 선택 인증 | `OptionalJwtAuthGuard` |
| WS | `WsJwtGuard`(`/teams`) · `FishingWsGuard`(`/fishing`) |
| 전역 | `CustomThrottlerGuard`(`APP_GUARD`) |

- **전역 인증 Guard와 `@Public`이 없다** — 신규 라우트에서 `JwtAuthGuard`를 빠뜨리면 그대로 무인증 공개된다.
- 토큰 위치: HTTP는 cookie `access_token` → Bearer 헤더, WS는 `handshake.auth.token` → Bearer 헤더.
- **인증 ≠ 인가**: Guard는 로그인 여부까지만 본다. **팀 멤버십·역할은 서비스/컨트롤러가 직접 검증한다**(`MANAGEMENT_ROLES.includes(...)` 등). 반복 누락 지점이다(`docs/playbooks/recurring-issues-playbook.md` 클러스터 1).

## 스로틀

- 한도는 `src/common/constants/throttle.constants.ts`가 SSOT다 — 전역 `THROTTLE_SHORT`·`THROTTLE_LONG`, 로그인 라우트는 더 엄격한 `THROTTLE_AUTH_*`를 `@Throttle`로 덮어쓴다.
- 제외는 `@SkipThrottle()` (헬스체크·외부 봇 호출 컨트롤러 등).
- 식별자는 로그인 시 `user-{userId}`, 비로그인 시 `X-Forwarded-For` 첫 IP → `req.ip` (`CustomThrottlerGuard.getTracker`).

## 응답·Swagger — 전역 인터셉터 없음

```typescript
return { code: 'SUCCESS', data: teamMembers, message: '' };
```

- 응답 인터셉터가 없다. 컨트롤러가 `{ code, data, message }` **객체 리터럴을 직접 반환**한다.
- `extends ApiSuccessResponseDto`는 **Swagger 명세용 타입 선언 전용**이다 — `new`로 만들어 반환하지 않는다. 베이스는 `code: 'SUCCESS'` + `message`, `data`는 상속 DTO가 정의한다.
- 에러 명세는 공통 데코레이터로 붙인다: `@ApiCommonUnauthorizedResponse()` · `@ApiCommonInternalServerErrorResponse()` · `@ApiCommonValidationResponse()` · `@ApiThrottledResponse()`.

## 신규 HTTP 엔드포인트 체크리스트

- [ ] `@UseGuards(JwtAuthGuard)` — 안 붙이면 무인증 공개
- [ ] 팀 멤버십·역할 인가를 서비스/컨트롤러에서 검증
- [ ] 에러는 `defineDomainError`로 정의해 throw
- [ ] 응답은 `{ code: 'SUCCESS', data, message }` 리터럴
- [ ] Swagger: `@ApiOperation` + 응답 DTO + 공통 에러 데코레이터
- [ ] 여러 테이블 쓰기면 `dataSource.transaction()` (`data-access.md`)
- [ ] spec: mock + factory, 에러 경로는 status·code 정확 고정 (`testing.md`)

# Task Tracker: 에러 DTO 패턴 리팩토링 (defineDomainError 팩토리 도입)

> 작성일: 2026-04-28 · 최종 갱신: 2026-07-22 (Phase 2~4 구현 + QA 리뷰 2회 통과)
> 브랜치: `feat-onam`
> 상태: **구현·검증 완료, 커밋 대기** — 잔여: ① Phase별 커밋 4개, ② 인증 필요한 수동 E2E 2건(팀 미존재 404 / 유효 토큰 WS의 FORBIDDEN·CHAT_NOT_JOINED), ③ blog-api-throttling.md 429 서술 정정(후속). 하단 Results 참조
> 참고 구현: `../mobisell/mobisell-back` (NestJS 4.0 현행 — 패턴만 차용, 도메인 코드는 우리 프로젝트 기준으로 재정의)
> 연관 파일: `src/common/dto/api-error.dto.ts`, `src/common/filters/http-exception.filter.ts`, `src/modules/*/[*-]error.dto.ts`

---

## 📌 결정 사항 요약

| 항목 | 결정 | 근거 |
|------|------|------|
| Q1. 기존 에러 DTO 마이그레이션 범위 | **(b) 전체 32개 모두 팩토리 사용** | 일관성 우선, 하이브리드 상태 방치는 유지보수 부담 |
| Q2. Swagger 에러 응답 `type` 명세 | **명시 추가** (전 컨트롤러 적용) | OpenAPI 기반 SDK 자동 생성 시 프론트 타입 안전성 확보. 현재 성공 응답에만 `type:` 명시되어 비대칭 |
| Q3. 미이전 영역 정리 | **포함** — file-share, users, telegram, WS guards 전부 도메인 에러 DTO로 통일 | 한 번에 끝내야 하이브리드 상태 종료 |
| Q4. `details` 필드 도입 방식 | **(c) 인프라만 구축, 점진 도입** — 베이스 클래스 + filter 직렬화만 미리 구현, 신규 에러는 details 없이 정의 | 즉시 모든 에러를 details 처리할 필요 없음. 향후 프론트 요청 들어오는 케이스부터 추가 |
| 베이스 클래스 시그니처 | ~~2인자 단순화~~ → **[계획 변경, Phase 1 구현] 기존 3인자 유지 + 4번째 옵셔널 `details` 추가** | 후방 호환 우선 — 기존 31개 DTO의 `super(status, msg, code)` 호출 무변경. 2인자 단순화는 Phase 2 마이그레이션 완료 후 재검토 |
| 팩토리 함수 위치 | `src/common/dto/define-domain-error.ts` (신규 파일) | mobisell 동일 경로 |
| 도메인 에러 파일 분리 | 모듈별 `*-error.dto.ts` (현행 유지) | 순환 참조 방지, 이미 적용 중인 컨벤션 |
| 공통 데코레이터 유틸 | `ApiThrottledResponse` 같은 반복 패턴은 `applyDecorators`로 묶음 | mobisell 패턴. 컨트롤러 보일러플레이트 감소 |
| `oneOf` 활용 (동일 status 다중 에러) | **필요 시만 도입**, 강제 X | 현재 동일 status에 여러 에러 던지는 케이스가 적음. 우선순위 낮음 |
| **D1**: file-share 인증 에러 코드 정책 | **단일 코드 `FILE_SHARE_UNAUTHORIZED` + message만 차이** | 프론트 연동 계획 없음 → 코드 분기 가치 0. 키 불일치 메시지 단일화는 보안상 유리 (공격자 단서 차단) |
| **D2**: users `NotFoundException` 통합 | **`UserNotFoundErrorResponseDto` 1개로 통합** | 같은 의미 에러는 DTO 1개에서 정의, throw는 여러 곳 가능 (현업 표준) |
| **D4**: health/main 컨트롤러 Swagger type 적용 | **제외** | `@nestjs/terminus@11.1.1` 사용 중 (검증 완료). terminus 표준 응답 포맷이 강제됨 — k8s/Docker probe 호환을 위해 변경 불가. main.controller는 에러 응답 없음 |
| **D5**: 라우트 충돌 (auth/users.controller.ts vs users/users.controller.ts) | **별도 작업으로 통합 완료 (2026-04-29)** | AppModule import 순서상 `auth/users.controller.ts`의 `updateMyName`이 실제 동작 중. `users/users.controller.ts`의 PUT /users/me는 dead. 우리가 한 작업은 "동작 중이던 핸들러를 삭제하고 dead 핸들러를 살림" — 두 핸들러는 기능 동등(userName 단일 필드)하지만 미묘한 차이: users 쪽은 `isActivated:1` 필터 있어 비활성 사용자 PUT 차단(보안 강화). **✅ 완료 — 커밋 `336b069` (2026-04-29)**. 커밋 결론: 비활성 사용자 차단은 JwtAuthGuard에서 이미 적용되므로 실질 동작 변경 없음 |
| **D3**: telegram/discord "팀 미존재" 처리 | **(a') `TeamNotFoundErrorResponseDto`를 `src/common/dto/`로 승격** + Port/Adapter 정석화는 별도 태스크 (`tasks-port-adapter-refactor.md` 신규 예정) | 본 작업 범위에서는 공통 승격으로 순환 의존 회피. 책임 재배치(notification → team에 검증 위임)는 PR 분리하여 별도 진행 — 한 PR에 한 종류 변경 원칙 |
| **D6**: PoC 분리 | **(a) 30분 PoC 후 Phase 1 본 작업 시작** | NestJS 11 + Swagger 8.x에서 동적 클래스 + `@ApiProperty` 런타임 부착 미검증. 32개 마이그레이션 후 발견 시 큰 롤백 비용. PoC 통과 시 본 작업, 실패 시 수동 데코레이터 fallback |
| **D7** (2026-07-22): fishing-ws.guard.ts:104,109 처리 | **Phase 3 제외 (현행 유지)** | 전수조사 결과 가드 내부 try/catch(58~71행)가 흡수 후 게스트 폴백 — 항상 `true` 반환이 설계 의도(주석 명시). WS 경계 미도달이므로 "경계 도달만 변경" 원칙 적용 |
| **D8** (2026-07-22): telegram.service.ts:135 · discord.service.ts:65 (외부 API 오류) | **Phase 3 제외 (`throw new Error` 유지)** | `sendTeamNotification`이 try/catch로 흡수, 호출부(notification.adapter)도 fire-and-forget — HTTP 경계 미도달. DTO 전환 실익 없음 |
| **D9** (2026-07-22): metrics-access.middleware.ts:44,53 (신규 발견 — 기존 인벤토리 누락) | **Phase 3 포함 — 공통 `ApiForbiddenErrorResponseDto` 재사용** | HTTP 미들웨어라 필터 경유 403 응답에 도달. 소비자가 모니터링 스크레이퍼뿐이라 신규 도메인 코드 불필요 |
| **D10** (2026-07-22): team.gateway.ts:144-147, 275-278 인라인 `client.emit(ERROR)` (팀 채팅 커밋 22f4a79가 도입) | **Phase 3 포함 — `WsException({code, message})` throw로 전환해 WsExceptionFilter 일원화** | 현재 timestamp 누락 + 필터 우회 + 하드코딩. 필터 경유 시 `{code, message, timestamp}` 보장. 기존 code 값(`FORBIDDEN`, `CHAT_NOT_JOINED`) 유지. 프론트는 `payload.message`만 사용해 안전 |
| **D11** (2026-07-22): 429(Throttler) 응답 code가 `UNKNOWN_ERROR`로 나가는 문제 | **Phase 4 포함 — filter `statusCodeMap`에 `429: 'TOO_MANY_REQUESTS'` 추가 + `ApiThrottledResponse` 데코레이터 구현·적용** | statusCodeMap에 429 부재로 무의미한 code 응답 중. 프론트 code 정확분기 0건 확인 → 저위험. `docs/blog-api-throttling.md`의 429 포맷 서술도 실동작에 맞게 정정 |
| **D12** (2026-07-22): WS 필터 raw Error 메시지 노출 비대칭 | **Phase 3 포함 — `ws-exception.filter.ts:70-76` 비-WsException 메시지를 HTTP 필터와 동일하게 마스킹** | HTTP 필터는 내부 메시지를 `'서버 내부 오류가 발생했습니다.'`로 마스킹하는데 WS 필터는 raw `Error.message`를 그대로 전달. 현재 실노출 사례 0건이나 예방 조치 |
| **D13** (2026-07-22): `src/common/dto/index.ts`의 `ErrorCode` 유니온 stale | **Phase 2 포함 — 실코드와 동기화** | team 코드 8개(`TEAM_MEMBER_NOT_FOUND` 등) 누락. 프론트는 자체 타입 사용 중이라 당장 무해하나 방치 시 오도. 자동 파생은 과설계로 보류 |

---

## 🟡 미결정 사항

(D3, D6 모두 결정 완료 — "결정 사항 요약" 표 참조)

---

## 개요

- **난이도**: 보통 | **효과**: 중간 (DX 개선) | **위험도**: 🟢 낮음 (응답 포맷 동일, 구현 내부만 변경)
- **선행**: 없음
- **프론트 영향**: 없음 (응답 JSON 포맷 `{ code, message, timestamp }` 동일 유지)

mobisell-back은 `defineDomainError()` 팩토리로 도메인 에러를 1줄에 정의하고, Swagger `@ApiProperty` 자동 부착, 클래스명 자동 설정까지 일괄 처리한다. 우리 프로젝트는 동일 컨셉을 클래스 수동 선언(~10줄/에러)으로 구현 중이라 보일러플레이트가 많고, 일부 모듈(file-share, users, telegram, WS guards)은 아직 NestJS 기본 예외/일반 Error를 던지고 있어 응답 포맷이 비일관 상태.

본 작업은 **(1) 팩토리 도입으로 보일러플레이트 80% 감소**, **(2) 미이전 영역 통일**, **(3) Swagger 에러 명세 type 보강**, **(4) details 인프라 구축** 4가지를 한 번에 정리한다.

---

## 🏗️ 현황 (불변 팩트 — 수정 전 반드시 참조)

### 응답 포맷 (변경 없음)
```json
{ "code": "TEAM_NOT_FOUND", "message": "팀을 찾을 수 없습니다.", "timestamp": "2026-04-28T..." }
```
프론트(`../next-bun`) 호환을 위해 **이 포맷은 유지**한다.

### 현재 에러 DTO 인벤토리 (2026-04-29 코드 검증 완료)

| 파일 | 에러 수 | 비고 |
|------|---------|------|
| `src/common/dto/api-error.dto.ts` | 7 | VALIDATION_ERROR, NOT_FOUND, FORBIDDEN, UNAUTHORIZED, BAD_REQUEST, INTERNAL_SERVER_ERROR, BAD_GATEWAY |
| `src/modules/auth/auth-error.dto.ts` | 3 | AuthUnauthorized, AuthInvalidToken, AuthKakaoApi |
| `src/modules/team/team-error.dto.ts` | 18 | TeamNotFound, TeamForbidden, TeamTaskNotFound, TeamTaskBadRequest, TeamCommentNotFound, TeamCommentForbidden, TeamInviteNotFound, TeamInviteExpired, TeamInviteForbidden, TeamMemberAlreadyExists, TeamMemberNotFound, TeamRoleChangeForbidden, TeamInvalidRole, TeamSelfRoleChange, TeamMemberStatusChangeForbidden, TeamSelfStatusChange, TeamMasterStatusChange, TeamDiscordWebhookInvalid |
| `src/modules/notification/notification-error.dto.ts` | 4 | NotificationTelegramConfig, NotificationTelegramApi, NotificationTelegramLinkInvalid, NotificationTelegramAlreadyLinked |
| **합계** | **32** | |

### 미이전 영역 (Phase 3 대상) — 2026-04-29 검증 → **2026-07-22 전수 재검증** (라인 재실측, 경계 도달 판별, 신규 2건 추가)

| 위치 | 현재 상태 | 처리 |
|------|----------|------|
| `src/modules/file-share/file-share.controller.ts:68,72,78,146,150,156,165,176,181,186` | NestJS 기본 예외 **10곳** (UnauthorizedException 6 + ForbiddenException 2 + NotFoundException 1 + BadRequestException 1) | **D1 결정**: 인증 3곳(68/72/78, 146/150/156)은 `FileShareUnauthorizedErrorResponseDto` 단일 코드로 통합 (메시지만 차이). 권한 거부 2곳(165/176)은 `FileShareForbiddenErrorResponseDto`. 파일 미존재 `FileShareFileNotFoundErrorResponseDto`. 파일 형식 오류 `FileShareInvalidFileTypeErrorResponseDto` |
| `src/modules/users/users.service.ts:24,44` | `throw new NotFoundException('사용자를 찾을 수 없습니다.')` 2곳 (동일 메시지) | **D2 결정**: `UserNotFoundErrorResponseDto` 1개로 통합. 두 곳 모두 같은 인스턴스 throw |
| `src/modules/notification/telegram.service.ts:214,369,419,442` | `throw new Error('...')` 4곳 — 경계 도달 (214 BOT_USERNAME 누락, 369·419 팀 미존재, 442 unlink 처리 오류). **⚠️ 현재 전부 500 INTERNAL_SERVER_ERROR로 응답 중** (컨트롤러 try/catch 없음 → 필터 else 분기. Swagger는 404 명세 — 실버그). 135(API오류)는 **D8 제외** (fire-and-forget 경계 미도달) | **D3 결정**: 369·419(팀 미존재)는 `src/common/dto/`로 승격된 `TeamNotFoundErrorResponseDto` 재사용 → **500→404 실버그 수정 효과**. 214(`NotificationTelegramConfigErrorResponseDto` 기존 활용), 442(`NotificationTelegramUnlinkErrorResponseDto` 신규) |
| `src/modules/notification/discord.service.ts:138,158,177` | `throw new Error('...')` 3곳 — 팀 미존재, 경계 도달. **⚠️ 현재 전부 500으로 응답 중** (동일 실버그). 65(webhook API오류)는 **D8 제외** (fire-and-forget 경계 미도달) | **D3 결정**: 138·158·177은 공통 `TeamNotFoundErrorResponseDto` 재사용 → 500→404 수정. ~~65 `NotificationDiscordApiErrorResponseDto` 신규~~ (D8 제외로 불필요) |
| ~~`src/modules/fishing/fishing-ws.guard.ts:104,109`~~ | `throw new Error()` 2곳 — **경계 미도달** (canActivate try/catch가 흡수 후 게스트 폴백, 항상 `true` 반환이 설계 의도) | **D7 결정: Phase 3 제외** (현행 유지) |
| `src/common/guards/ws-jwt-auth.guard.ts:53,64,99,105,112` (2026-07-22 라인 재실측, 구버전 대비 +2) | `throw new WsException('string')` 5곳 — 전부 WsExceptionFilter 도달 확인 | `{ code, message }` 객체 throw로 표준화 |
| `src/common/middleware/metrics-access.middleware.ts:44,53` (**2026-07-22 신규 발견 — 기존 인벤토리 누락, 커밋은 문서 작성 전인 2026-04-21**) | `throw new ForbiddenException('Forbidden')` 2곳 — HTTP 필터 경유 403 도달 | **D9 결정**: 공통 `ApiForbiddenErrorResponseDto` 재사용 |
| `src/modules/team/team.gateway.ts:144-147, 275-278` (**2026-07-22 신규 발견 — 팀 채팅 커밋 22f4a79가 도입**) | `client.emit(ERROR, {code, message})` 인라인 2곳 (`FORBIDDEN`, `CHAT_NOT_JOINED`) — timestamp 누락 + 필터 우회 + 하드코딩 | **D10 결정**: `WsException({code, message})` throw로 전환해 필터 일원화 |
| `src/common/filters/ws-exception.filter.ts:70-76` (throw 지점 아님 — 필터 자체 변경) | 비-WsException(raw `Error`) 도달 시 `exception.message`를 그대로 클라이언트에 노출 (HTTP 필터는 마스킹 — 비대칭) | **D12 결정**: HTTP 필터와 동일하게 마스킹 |

### Swagger 에러 응답 `type` 미명세 (Phase 4 대상)
`team.controller.ts:93-94` 같은 패턴이 전 컨트롤러에 만연:
```ts
@ApiResponse({ status: 401, description: 'UNAUTHORIZED' })  // ← type 없음
```
→ Phase 4에서 `type: ApiUnauthorizedErrorResponseDto` 명시.

---

## Phase 0: PoC (D6 결정 반영, 30분)

> **목표**: `defineDomainError`가 NestJS 11 + Swagger 8.x 환경에서 동작하는지 사전 검증.

> **✅ 완료 — 커밋 `156b5b9` (2026-04-29)**

### 0-1. PoC 작업
- [x] `src/common/dto/define-domain-error.ts` 작성
- [x] `TeamNotFoundErrorResponseDto`만 팩토리로 1개 마이그레이션 (1/32)
- [x] Swagger UI 스키마 정상 노출 확인 (클래스명 + `@ApiProperty` 메타데이터)
- [x] 실제 throw → 응답 JSON 포맷 동일성 실측 (PATCH /teams/:id/tasks/:id → 403 `{code, message, timestamp}` 동일)
- 부수 변경: `team.controller.ts` PATCH /:teamId 404 응답에 `type:` 명시 (검증용, Phase 4 일부 선행)

### 0-2. PoC 결과 분기
- ✅ **통과 → Phase 1 진행 (완료)**

---

## Phase 1: 인프라 구축 (팩토리 함수 + 베이스 클래스 정비)

> **목표**: 새 패턴의 토대만 깔기. 기존 에러 DTO는 건드리지 않음. 빌드/테스트 통과 가능 상태로 마무리.

### 1-1. `ApiErrorResponseDto` 베이스 클래스 시그니처 정비
> **[계획 변경 — 실제 구현 (커밋 `b581625`)]** 2인자 단순화 대신 기존 3인자 시그니처를 유지하고 4번째 옵셔널 인자 `details?: unknown`을 추가했다. 기존 31개 DTO 무변경(후방 호환). 2인자 정비는 Phase 2에서 팩토리 전환이 끝나면 자연 소멸되는 이슈라 별도 진행하지 않음.
> **[2026-07-22 정정]** `getErrorResponse()` 헬퍼가 베이스에 추가됐으나 **필터는 이 헬퍼를 호출하지 않음** (자체 로직으로 code/message/details 재구성 — 현재 dead code). Phase 2에서 **필터가 헬퍼를 사용하도록 통일**한다 (Phase 2 완료 조건 참조).

- ~~**변경 전** (`api-error.dto.ts:8-15`): `constructor(status, message, code)` 3인자~~
- ~~**변경 후**: `constructor(status, message)` 2인자, `abstract code: string` 필드 선언~~
- **이유**: code는 서브클래스 필드 1군데만 관리. 생성자 인자로 받으면 정의 시 같은 값을 두 번 적게 됨 (`super(404, msg, 'CODE')` + `readonly code = 'CODE'`).
- **부작용 확인 결과 (2026-07-22)**: 의심대로 `getResponse()`는 항상 문자열을 반환 (`ApiErrorResponseDto`가 `super(message, status)`로 문자열만 전달) → 캐스팅 후 `.code`/`.message` 접근은 항상 `undefined`이고 `||` fallback(`getErrorCode()`, `exception.message`)으로만 동작 중. 런타임 문제는 없으나 dead-fallback — Phase 2에서 캐스팅 제거 등 정리 항목에 포함.

### 1-2. `defineDomainError()` 팩토리 함수 작성
- **위치**: `src/common/dto/define-domain-error.ts` (신규)
- **시그니처**:
  ```ts
  defineDomainError({ code: string, status: number, message: string }): typeof ApiErrorResponseDto
  ```
- **내부 동작** (mobisell 참고):
  - `ApiErrorResponseDto`를 상속한 익명 클래스 생성
  - `@ApiProperty({ example: code, enum: [code] })` 자동 부착
  - `Object.defineProperty(cls, 'name', { value: codeToClassName(code) })`로 클래스명 자동 (예: `TEAM_NOT_FOUND` → `TeamNotFoundErrorResponseDto`)
  - 정적 속성 `errorCode`, `status`, `defaultMessage` 노출 (테스트/디버깅 용)
  - `details?: unknown` 필드 옵셔널 정의
- **사용 예 (Phase 2에서 적용)**:
  ```ts
  export const TeamNotFoundErrorResponseDto = defineDomainError({
    code: 'TEAM_NOT_FOUND',
    status: 404,
    message: '팀을 찾을 수 없습니다.',
  });
  ```

### 1-3. `details` 필드 인프라 (Q4 결정사항)
- **베이스 클래스에 추가**:
  ```ts
  abstract class ApiErrorResponseDto extends HttpException {
    abstract code: string;
    details?: unknown;
    constructor(status: number, message: string, options?: { details?: unknown }) {
      super(message, status);
      if (options?.details !== undefined) this.details = options.details;
    }
  }
  ```
- **filter 직렬화** (`http-exception.filter.ts:71`):
  ```ts
  const errorResponse = {
    code, message,
    ...(exception instanceof ApiErrorResponseDto && exception.details !== undefined
      ? { details: exception.details } : {}),
    timestamp: new Date().toISOString(),
  };
  ```
- **mobisell 미완성 부분 보완**: mobisell은 클래스에 `details`만 정의하고 filter에서 직렬화 안 함. 우리는 처음부터 직렬화까지 끝낸다.
- **신규 에러는 details 없이 정의** (Phase 2). 향후 케이스별로 점진 추가.

### 1-4. 공통 데코레이터 유틸
- **위치**: `src/common/decorators/api-error-response.decorator.ts` (신규)
- **포함**:
  ```ts
  ApiThrottledResponse()       // 429
  ApiUnauthorizedErrorResponse()  // 401 (NestJS 기본 ApiUnauthorizedResponse와 충돌 회피 위해 네이밍 주의)
  ApiValidationErrorResponse() // 422
  ```
- **목적**: Phase 4에서 컨트롤러마다 반복되는 `@ApiResponse({ status: 422, type: ApiValidationErrorResponseDto })`를 1줄로 줄임.
- **실제 구현 (커밋 `b581625`)**: `ApiCommonUnauthorizedResponse()` (401), `ApiCommonValidationResponse()` (422) 2종 — `Common` 접두사로 네이밍 확정. **429 Throttled 데코레이터는 미구현** → Phase 4에서 필요 시 추가.

### 1-5. 단위 테스트 (선택)
- `defineDomainError`가 만드는 클래스가 기대대로 동작하는지 (instanceof 체크, code 필드, status, name) 간단 테스트.
- **미작성** — 선택 항목으로 Phase 1 커밋에 미포함. 테스트 인프라 구축(`tasks-nestjs-improvements.md` D2) 시 함께 작성 권장.

### Phase 1 완료 조건 — ✅ 완료 (커밋 `b581625`, 2026-04-29)
- [x] `define-domain-error.ts` 작성 (단위 테스트는 선택 항목 — 미작성, 1-5 참조)
- [x] `ApiErrorResponseDto` 정비 (계획 변경: 3인자 유지 + `details` 옵셔널) + filter 호환성 확인
- [x] `details` 필드 베이스 + filter 직렬화 (details 미정의 시 응답에서 제외 — smoke test 완료)
- [x] `pnpm run build` + ESLint 통과
- [x] 기존 에러 DTO 31개 미수정 상태에서 Swagger schema 변경 없음 확인

---

## Phase 2: 기존 에러 DTO 팩토리 마이그레이션

> **목표**: 남은 31개 에러 DTO(전체 32개 중 `TeamNotFoundErrorResponseDto` 1개는 Phase 0 PoC로 전환 완료)를 `defineDomainError()` 호출로 전환. 클래스 이름과 export 시그니처는 유지하여 사용처(컨트롤러/서비스) 변경 없음.

### 2-1. 마이그레이션 순서 (의존성 적은 순)
1. `src/common/dto/api-error.dto.ts` (7개) — 다른 DTO 미의존
2. `src/modules/notification/notification-error.dto.ts` (4개)
3. `src/modules/auth/auth-error.dto.ts` (3개)
4. `src/modules/team/team-error.dto.ts` (남은 17개 — TeamNotFound는 PoC로 전환 완료) — 가장 많음, 마지막

### 2-2. 마이그레이션 패턴
**Before** (`team-error.dto.ts`):
```ts
export class TeamNotFoundErrorResponseDto extends ApiErrorResponseDto {
  @ApiProperty({ example: 'TEAM_NOT_FOUND', enum: ['TEAM_NOT_FOUND'] })
  readonly code: string = 'TEAM_NOT_FOUND';
  constructor(message: string = '팀을 찾을 수 없습니다.') {
    super(404, message, 'TEAM_NOT_FOUND');
  }
}
```

**After**:
```ts
export const TeamNotFoundErrorResponseDto = defineDomainError({
  code: 'TEAM_NOT_FOUND',
  status: 404,
  message: '팀을 찾을 수 없습니다.',
});
```

### 2-3. 사용처 호환성 검증
- `throw new TeamNotFoundErrorResponseDto()` — 동작 동일 (변경 없음)
- `throw new TeamForbiddenErrorResponseDto('커스텀 메시지')` — message 인자 override 가능하도록 팩토리에서 지원
- **grep 전수 확인**: 모든 `throw new *ErrorResponseDto` 호출 위치 확인 후 인자 패턴 정리
- **✅ 2026-07-22 전수조사 완료**: 전 call-site(70여 곳) 인자 패턴은 무인자/문자열(리터럴·변수·템플릿 리터럴)뿐. 객체 인자·제네릭·타입 위치 사용 0건. `instanceof` 1건(`jwt-auth.guard.ts:79`)도 `throw error;` 재전파뿐이라 안전. **깨질 위험이 있는 사용 패턴 없음 확정**
- 착수 시 1회: `codeToClassName()`이 31개 code 전부를 기존 export 식별자와 동일한 이름으로 변환하는지 스크립트 대조

### Phase 2 완료 조건
- [ ] 32개 에러 DTO 전부 팩토리 호출로 전환
- [ ] `codeToClassName()` 31개 이름 전수 대조 (전환 전 1회)
- [ ] grep 전수 확인: `throw new .*ErrorResponseDto` 호출 위치 전부 정상 동작
- [ ] `src/common/dto/index.ts`의 `ErrorCode` 유니온 실코드 동기화 (D13 — team 코드 8개 등 누락 보완)
- [ ] filter 정리: `getResponse() as {code,message}` dead-fallback 캐스팅 제거하고 **필터가 `getErrorResponse()` 헬퍼를 사용하도록 통일** (직렬화 로직을 베이스 클래스 한 곳에 유지 — 헬퍼 제거보다 응집도 우선. 1-1 정정사항 참조)
- [ ] `pnpm run build` 통과
- [ ] 수동 테스트: 대표 에러 3-5개 (TEAM_NOT_FOUND, AUTH_*, VALIDATION_ERROR) 응답 포맷 동일성 확인 — ※ notification 4종·api-error 5종(NotFound/Forbidden/BadRequest/InternalServerError/BadGateway)은 현재 throw/참조 경로가 없어(Phase 3~4 전까지 미사용) 대표 사례로 선택 불가

---

## Phase 3: 미이전 영역 정리

> **목표**: 도메인 에러 DTO 패턴 미적용 영역을 모두 통일.

### 3-1. file-share 모듈
- **신규 DTO 파일**: `src/modules/file-share/file-share-error.dto.ts`
- **정의 후보** (`file-share.controller.ts:146-186` 분석 후 확정):
  - `FILE_SHARE_NOT_FOUND` (404)
  - `FILE_SHARE_FORBIDDEN` (403)
  - `FILE_SHARE_UNAUTHORIZED` (401)
- **변경**: `throw new NotFoundException()` → `throw new FileShareNotFoundErrorResponseDto()`

### 3-2. users 모듈
- **신규 DTO 파일**: `src/modules/users/users-error.dto.ts`
- **정의**: `USER_NOT_FOUND` (404)
- **변경**: `users.service.ts:24,44` `throw new NotFoundException()` → `throw new UserNotFoundErrorResponseDto()`

### 3-3. notification 모듈 (telegram/discord) — D3 결정 반영
- **선행 작업**: `TeamNotFoundErrorResponseDto`를 `src/modules/team/team-error.dto.ts`에서 **`src/common/dto/team-error.dto.ts` (또는 `api-error.dto.ts`에 통합)**로 이동
  - team 모듈도 새 위치에서 import (기존 import 경로 변경)
  - 순환 의존 회피
- **추가 DTO** (`notification-error.dto.ts`에 추가):
  - `NotificationTelegramUnlinkErrorResponseDto` (500) — unlink 트랜잭션 실패 (telegram:442)
  - (Bot username 누락 등 환경설정 에러는 기존 `NotificationTelegramConfigErrorResponseDto` 활용)
  - ~~`NotificationDiscordApiErrorResponseDto`~~ — **D8 제외로 불필요** (discord:65 경계 미도달)
- **변경 (2026-07-22 전수조사 반영)**: telegram.service.ts:214,369,419,442 + discord.service.ts:138,158,177
  - 팀 미존재 5곳(telegram:369,419 + discord:138,158,177) → `TeamNotFoundErrorResponseDto` (공통 위치) 재사용. **현재 500으로 잘못 응답 중 → 404로 수정되는 실버그 픽스** (Swagger 명세와 일치하게 됨)
  - telegram:135, discord:65 (외부 API 실패) → **D8 제외**: fire-and-forget으로 HTTP 경계 미도달, `throw new Error` 유지
- **주의**: 내부 로직용 `throw new Error()`(HTTP 경계 통과 안 함)는 유지. **HTTP 응답 경로에 도달하는 것만** 변경.
- **별도 태스크 예정**: notification 책임 재배치 (Port/Adapter 정석화) → `tasks-port-adapter-refactor.md` 신규 작성 시 이 부분의 throw 자체를 제거하고 caller에 위임

### 3-4. WS 표준화 (ws-jwt-auth.guard.ts + team.gateway.ts + ws-exception.filter.ts) — 2026-07-22 스코프 갱신
- **WS 응답 포맷 통일**:
  - 현재: `throw new WsException('인증 실패')` → 클라이언트 응답 `{ code: 'WS_ERROR', message: '인증 실패' }` (code 고정 — `ws-exception.filter.ts:51-59` 실측 확인)
  - 목표: `throw new WsException({ code: 'AUTH_TOKEN_EXPIRED', message: '...' })` → 클라이언트 응답 `{ code: 'AUTH_TOKEN_EXPIRED', message: '...' }`
  - **객체 payload 분기는 필터에 이미 존재** (`ws-exception.filter.ts:60-66`) — 필터 신규 분기 작업 불필요, 가드 쪽 throw 형태만 변경하면 됨
- **변경 위치 (2026-07-22 재실측)**:
  - `ws-jwt-auth.guard.ts:53,64,99,105,112` (5곳 — 구버전 문서 라인 대비 +2 드리프트)
  - ~~`fishing-ws.guard.ts:104,109`~~ — **D7 제외** (경계 미도달, 게스트 폴백이 설계 의도)
  - **`team.gateway.ts:144-147, 275-278` (D10 신규 추가)** — 인라인 `client.emit(ERROR, {code, message})` 2곳을 `WsException({code, message})` throw로 전환 (timestamp 자동 부여 + 필터 일원화). 기존 code 값(`FORBIDDEN`, `CHAT_NOT_JOINED`) 유지
- **filter 추가 변경 (D12)**: `ws-exception.filter.ts:70-76` — 비-WsException(raw `Error`) 도달 시 `exception.message`를 그대로 노출 중 → HTTP 필터와 동일하게 `'서버 내부 오류가 발생했습니다.'`로 마스킹 (현재 실노출 사례 0건, 예방 조치)
- **프론트 영향**: ✅ **조사 완료 (2026-07-22, next-bun 전수 grep) — 영향 없음.** `WS_ERROR` 하드코딩 0건. 소켓 에러 핸들러는 `payload.message`만 사용 (`TeamSocketContext.tsx:154-157`, `FishingSocketContext.tsx:168-171`), `connect_error`도 동일. 유일 주의: `useTeamInvite.ts:45`가 `code.endsWith('_FORBIDDEN')`에 의존 → **신규 에러 코드 명명 시 `_FORBIDDEN` 접미사 컨벤션 유지**

### 3-5. metrics-access 미들웨어 (D9, 2026-07-22 추가)
- **대상**: `src/common/middleware/metrics-access.middleware.ts:44,53` — `throw new ForbiddenException('Forbidden')` 2곳
- **변경**: `throw new ApiForbiddenErrorResponseDto('Forbidden')` — 공통 DTO 재사용, 신규 DTO 파일·코드 불필요
- **효과**: 현재도 필터의 `getDefaultErrorCode(403)` fallback으로 code `FORBIDDEN`이 나가므로 **응답 실질 변화 없음** — 예외 패턴 통일 목적. 소비자는 모니터링 스크레이퍼뿐

### Phase 3 완료 조건 (2026-07-22 갱신)
- [ ] file-share, users, notification, metrics 미들웨어, WS(가드 + 게이트웨이 + 필터) 전부 표준화
- [ ] grep: `throw new (NotFoundException|ForbiddenException|UnauthorizedException|BadRequestException|InternalServerErrorException|ConflictException)` 결과 0건 (서비스/컨트롤러/**미들웨어** 레이어)
- [ ] grep: `throw new Error\(.*\)` 중 HTTP 경계 도달 가능한 위치 0건 — **D7·D8 제외분은 유지**: telegram:135, discord:65, fishing-ws:104,109, app.module.ts:103·env.validation.ts:80(부트스트랩 전용)
- [ ] grep: `client.emit(TeamSocketEvents.ERROR` 직접 호출 0건 (D10 — 필터 일원화 확인)
- [ ] 팀 미존재 응답이 **404 + TEAM_NOT_FOUND**로 나가는지 수동 확인 (기존 500 실버그 수정 검증 — telegram status/unlink, discord webhook save/status/delete 5개 엔드포인트)
- [x] WS 클라이언트(`next-bun`) 호환성 확인 — **2026-07-22 조사 완료, 영향 없음** (`_FORBIDDEN` 접미사 유지 조건만)
- [ ] `pnpm run build` 통과

---

## Phase 4: Swagger 에러 응답 `type` 명세 보강

> **목표**: 모든 컨트롤러의 `@ApiResponse({ status: 4xx, description: '...' })`에 `type: XxxErrorResponseDto` 추가.

### 4-1. 컨트롤러별 처리 (2026-04-29 D5 통합 후 최종)
- `src/modules/auth/auth.controller.ts`
- `src/modules/team/team.controller.ts` (가장 큼 — 실측 24개 엔드포인트, type 미명세 97건)
- `src/modules/file-share/file-share.controller.ts`
- `src/modules/users/users.controller.ts` (D5 통합으로 충돌 해소)
- `src/modules/notification/telegram.controller.ts`
- ~~`src/modules/main/main.controller.ts`~~ — 에러 응답 없음, 제외 (2026-07-22 재확인: @ApiResponse 200 하나뿐)
- ~~`src/modules/main/health.controller.ts`~~ — D4 결정으로 제외 (terminus 표준. 2026-07-22 재확인: @ApiResponse 자체 없음)

**작업량 실측 (2026-07-22)**: `type:` 미명세 4xx/5xx `@ApiResponse` 총 **112건** — auth 5 · team **97** (87% 편중. team의 4xx/5xx는 총 98건 = 401×24 + 404×20 + 403×20 + 400×10 + 500×24이며, PoC에서 type 명시한 404 1건을 제외한 값) · file-share 4 · users 5 · telegram 1. 컨트롤러 전수 7개 대조 완료(누락 없음 — discord 엔드포인트는 team.controller에 통합돼 있고, `/metrics`는 `@willsoto/nestjs-prometheus` 라이브러리 내장이라 대상 아님).

### 4-1b. 신규 추가 항목 (2026-07-22 전수조사 반영)
- **422 신규 명세**: ValidationPipe 422는 실제 발생함에도 **컨트롤러 어디에도 422 `@ApiResponse` 자체가 없음** (type 미명세가 아니라 응답 미문서화). `@Body`/`@Query`/`@Param` 검증이 있는 엔드포인트에 `ApiCommonValidationResponse()` 적용
- **429 매핑 + 데코레이터 (D11)**: `http-exception.filter.ts` statusCodeMap에 `429: 'TOO_MANY_REQUESTS'` 추가 (현재 429가 `UNKNOWN_ERROR`로 응답 중), `ApiThrottledResponse()` 데코레이터 신규 구현 후 적용, `docs/blog-api-throttling.md`의 429 응답 포맷 서술 정정
- 공통 데코레이터(`ApiCommonUnauthorizedResponse`/`ApiCommonValidationResponse`)는 Phase 1에서 구현만 되고 **실사용 0건** — Phase 4가 최초 적용

### 4-2. 패턴
**Before**:
```ts
@ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
@ApiResponse({ status: 404, description: '팀을 찾을 수 없습니다.' })
```
**After**:
```ts
@ApiUnauthorizedErrorResponse()  // 공통 데코레이터 사용
@ApiResponse({ status: 404, type: TeamNotFoundErrorResponseDto })
```

### 4-3. 검증
- Swagger UI(`/api/v1/docs`) 진입 → 대표 엔드포인트 3-5개에서 401/403/404 펼쳐서 응답 스키마 노출 확인
- OpenAPI JSON(`/api/v1/docs-json`) 다운로드 → 에러 스키마 부분에 `code`, `message` 필드 정의 존재 확인

### Phase 4 완료 조건
- [ ] 모든 컨트롤러의 에러 `@ApiResponse`에 `type:` 명시
- [ ] Swagger UI에서 에러 응답 본문 스키마 노출 확인
- [ ] OpenAPI JSON에 에러 DTO 스키마 포함 확인

---

## Phase 5: 검증 & 마무리

### 5-1. 빌드/테스트
- [ ] `pnpm run build` (tsc) 통과
- [ ] (있다면) `pnpm test` 통과
- [ ] 로컬 기동 후 Swagger UI 접근 (`/api/v1/docs`)

### 5-2. 응답 포맷 일관성 회귀 테스트
- [ ] HTTP 4xx 에러 (대표 5개): 응답 포맷 `{ code, message, timestamp }` 동일성 확인
- [ ] HTTP 5xx 에러 (강제 예외 발생 시): 동일 포맷 확인
- [ ] WS 에러 (잘못된 토큰으로 connect): `{ code, message, timestamp }` 동일 + code가 더 구체적인 값으로 변경되었는지 확인
- [ ] 프론트(`next-bun`) 일부 화면 동작 확인 (로그인, 팀 목록, 권한 에러 토스트)

### 5-3. 문서 업데이트
- [ ] `CLAUDE.md`의 Active Work 섹션에 본 작업 결과 반영
- [ ] (필요 시) `docs/architecture.md`에 에러 DTO 패턴 1줄 추가

---

## 리스크 & 롤백

### 리스크
| 리스크 | 가능성 | 영향 | 대응 |
|--------|--------|------|------|
| ~~WS code 변경으로 프론트 분기 깨짐~~ | **해소** | - | ✅ 2026-07-22 next-bun 전수 grep 완료 — `WS_ERROR` 사용처 0건, 소켓 에러는 message만 사용. 단 신규 코드 명명 시 `_FORBIDDEN` 접미사 유지 (`useTeamInvite.ts:45` 의존) |
| 팀 미존재 500→404 상태코드 변경 (Phase 3) | 낮음 | 낮음 | 프론트에 code/status 정확분기 없음 확인(2026-07-22). Swagger가 이미 404 명세라 문서-실동작 일치화에 해당 |
| 429 code 변경 `UNKNOWN_ERROR`→`TOO_MANY_REQUESTS` (Phase 4, D11) | 낮음 | 낮음 | 프론트 code 분기 없음 확인. status 429 자체는 불변 |
| `details` 필드 직렬화 시 보안 정보 노출 | 낮음 | 높음 | filter는 `details` 그대로 직렬화하지만, 각 에러 정의 시 의식적으로 검증 (코드 리뷰 체크리스트) |
| `ApiErrorResponseDto` 시그니처 변경으로 미발견 사용처 컴파일 에러 | 낮음 | 낮음 | Phase 1에서 grep 전수 + tsc로 잡힘 |
| Swagger 빌드 시 `defineDomainError` 동적 클래스가 인식 안 됨 | 중간 | 중간 | mobisell에서 정상 동작 확인됨. 우리 환경(NestJS 11)에서 PoC 1개로 사전 검증 |

### 롤백 전략
- 각 Phase는 독립적인 커밋으로 분리
- 문제 발생 시 해당 Phase 커밋만 revert (Phase 1 → 5 순서로 의존성 있음)
- 응답 포맷 자체는 동일하므로 프론트 영향 없음 (WS 가드 제외)

---

## 진행 상황 체크리스트

### Phase 0: PoC — ✅ 완료 (커밋 `156b5b9`)
- [x] `defineDomainError()` 작성
- [x] 1개 에러 마이그레이션 (TeamNotFound)
- [x] Swagger UI 스키마 노출 확인
- [x] 응답 JSON 포맷 동일성 확인
- [x] 분기 결정: **통과 → 본 작업 진행**

### Phase 1: 인프라 — ✅ 완료 (커밋 `b581625`)
- [x] `defineDomainError()` 작성
- [x] `ApiErrorResponseDto` 정비 (계획 변경: 3인자 유지 + `details` 옵셔널)
- [x] `details` 필드 + filter 직렬화
- [x] 공통 데코레이터 유틸 (401/422 — 429는 Phase 4에서 필요 시 추가)
- [ ] 단위 테스트 (선택 — 미작성, D2 테스트 인프라 구축 시 함께)
- [x] 빌드 통과

### Phase 2: 마이그레이션 — ✅ 완료 (2026-07-22)
- [x] common (7 + 신규 ApiTooManyRequests − ApiUnauthorized 제거 = 7, 추가 리뷰 반영 후) — `name` 오버라이드로 기존 스키마명 유지
- [x] notification (4 + 신규 Unlink = 5)
- [x] auth (3)
- [x] team (17 — TeamNotFound는 PoC 완료, D3로 공통 승격)
- [x] codeToClassName 전수 대조 (34/34 일치 — 스크립트 검증, 아래 Results 참조)
- [x] ErrorCode 유니온 동기화 (D13) + filter dead-fallback 정리 (`getErrorResponse()` 사용으로 통일)
- [x] grep 전수 검증

### Phase 3: 미이전 영역 — ✅ 완료 (2026-07-22)
- [x] file-share (D1: FILE_SHARE_UNAUTHORIZED 통합 3메시지/FORBIDDEN/FILE_NOT_FOUND/INVALID_FILE_TYPE 4종)
- [x] users (D2: USER_NOT_FOUND 1개 DTO 통합)
- [x] D3: `TeamNotFoundErrorResponseDto` → `src/common/dto/api-error.dto.ts` 승격 (team-error.dto.ts가 re-export하여 기존 import 무변경)
- [x] notification — telegram:214,369,419,442 + discord:138,158,177 (**500→404 실버그 수정**). telegram:135·discord:65는 D8 제외로 유지 확인
- [x] metrics-access.middleware 2곳 (D9: 공통 ApiForbidden 재사용 — 응답 실질 무변화)
- [x] WS 가드 ws-jwt-auth 5곳 — HTTP 가드와 동일 코드 체계(AUTH_UNAUTHORIZED / AUTH_INVALID_TOKEN)
- [x] team.gateway 인라인 emit 2곳 → WsException 전환 (D10 — 프론트 joinTeam ack 미사용 확인 후 진행)
- [x] ws-exception.filter 비-WsException 메시지 마스킹 (D12 — 서버 로그에는 원본 메시지 유지)
- [x] next-bun 호환성 확인 — 2026-07-22 완료, 영향 없음 (`_FORBIDDEN` 접미사 유지 조건)

### Phase 4: Swagger — ✅ 완료 (2026-07-22)
- [x] auth.controller.ts — 401/422/429/500/502 전부 type 명세. **실동작 일치화**: 발생 불가한 400/404 명세 제거, 실제 발생하는 502(카카오) 신규 추가
- [x] team.controller.ts (97건 — description↔서비스 throw 대조 매핑, 2단계 스크립트 적용)
- [x] file-share.controller.ts (4건 + 실발생 400 신규 1건)
- [x] users/users.controller.ts — 401/404 type + 400 명세를 실동작(422)으로 교체
- [x] notification/telegram.controller.ts (1건)
- [x] 422 신규 명세 — `@Body()` DTO 있는 team 13개 엔드포인트 + users PUT + auth에 ApiCommonValidationResponse 적용
- [x] 429: statusCodeMap `TOO_MANY_REQUESTS` 추가 + ApiThrottledResponse 구현·auth 적용 (D11)
- [ ] blog-api-throttling.md 429 포맷 서술 정정 (후속 — 코드와 무관한 블로그 문서)
- [x] Swagger 점검 — 로컬 기동 후 `/api/v1/docs-json` 실측: 에러 스키마 23개 전부 기존 명명으로 등록 확인

### Phase 5: 검증
- [x] 빌드(tsc)/ESLint 통과 (0 errors)
- [x] HTTP 회귀 실측 (로컬 기동): 404 NOT_FOUND, 401 AUTH_UNAUTHORIZED(가드), 422 VALIDATION_ERROR, 401 FILE_SHARE_UNAUTHORIZED — 전부 `{code, message, timestamp}` 포맷·상태코드 정상
- [ ] 인증 필요한 수동 E2E: 팀 미존재 404 응답(텔레그램/디스코드 status·unlink 5개 엔드포인트), WS 에러 code 확인, 프론트 화면 확인
- [x] 문서 업데이트

---

## Results (2026-07-22, Phase 2~4 구현 완료)

### 변경된 파일 (19개)
- **신규 5**: `common/dto/api-error-base.dto.ts` (베이스 분리), `modules/users/users-error.dto.ts`, `modules/file-share/file-share-error.dto.ts`, (기존 개편) `common/dto/api-error.dto.ts`, `common/dto/index.ts`
- **Phase 2**: `define-domain-error.ts`, `api-error.dto.ts`, `team-error.dto.ts`, `auth-error.dto.ts`, `notification-error.dto.ts`, `index.ts`, `http-exception.filter.ts`
- **Phase 3**: `users.service.ts`, `file-share.controller.ts`, `telegram.service.ts`, `discord.service.ts`, `metrics-access.middleware.ts`, `ws-jwt-auth.guard.ts`, `team.gateway.ts`, `ws-exception.filter.ts`
- **Phase 4**: `api-error-response.decorator.ts`, `auth.controller.ts`, `users.controller.ts`, `telegram.controller.ts`, `team.controller.ts`

### 구현 중 계획 변경 (전부 저위험, 근거 포함)
1. **`defineDomainError`에 `name` 옵션 추가** — 착수 전 전수 대조에서 **12건의 Swagger 스키마명 불일치 발견** (Api* 접두사는 code에서 유도 불가, `_ERROR` 접미사 code는 "Error" 중복 생성). `_ERROR` 접미사 자동 제거 + 공통 8개에 `name` 명시로 기존 스키마명 100% 보존. PoC(TEAM_NOT_FOUND)가 우연히 완벽 매칭되는 케이스여서 사전에 못 잡았던 문제.
2. **`api-error-base.dto.ts` 분리** — api-error.dto.ts가 팩토리를 쓰면 base→factory→base 순환 import 발생. 베이스만 분리하고 기존 경로는 re-export로 전부 보존.
3. **`ApiTooManyRequestsErrorResponseDto` 신규** (공통 7→8개) — D11의 429 Swagger 명세용.
4. **`ApiCommonUnauthorizedResponse`가 `AuthUnauthorizedErrorResponseDto` 참조로 변경** — 가드 401의 실제 code는 `AUTH_*`인데 기존 계획(ApiUnauthorized, code `UNAUTHORIZED`)은 발생하지 않는 code를 문서화하게 됨. common→modules/auth 의존은 jwt-auth.guard.ts 선례와 동일.
5. **Swagger 실동작 일치화** — auth: 발생 불가 400/404 제거 + 실발생 502 추가, users: 400→422 교체, file-share: 실발생 400 추가.
6. **telegram config 에러 메시지 마스킹** — 'BOT_USERNAME_TELEGRAM 환경변수...'는 서버 로그로 이전, 클라이언트에는 일반 메시지 (내부 설정 정보 노출 방지).

### 응답 변경 (의도된 것만)
- 포맷 `{code, message, timestamp}` 유지. **팀 미존재 5곳: 500→404** (실버그 수정, Swagger 명세와 일치화). 429 code: `UNKNOWN_ERROR`→`TOO_MANY_REQUESTS`. file-share/users/metrics의 code가 도메인 코드로 구체화 (프론트 code 정확분기 0건 확인 완료).

### 검증 방법 (Verification Story)
1. `pnpm run build`(tsc) + `pnpm run lint` 통과 (0 errors, 기존 warning 7건만)
2. 클래스명 전수 대조 스크립트: 34/34 일치
3. grep 전수: NestJS 기본 예외 0건(서비스/컨트롤러/미들웨어), `client.emit(ERROR)` 0건, `throw new Error` 잔존 6건 전부 D7·D8·부트스트랩 제외분
4. **로컬 기동 실측**: 404/401(가드)/422/401(file-share) 응답 포맷·상태코드·code 정상, `/api/v1/docs-json`에서 에러 스키마 23개 기존 명명으로 등록 확인
5. 프론트 영향: next-bun 전수 grep — code 정확분기 0건, WS는 message만 사용, joinTeam ack 미사용

### 추가 코드리뷰 반영 (2026-07-22, 8앵글 diff 리뷰 — correctness 버그 0건, cleanup 5건 반영)
1. `ApiCommonInternalServerErrorResponse()` 데코레이터 신설 — team 24회 + auth/telegram의 500 리터럴 반복 제거
2. `ErrorCode` 유니온에 WS 전용 코드(`CHAT_NOT_JOINED`/`WS_ERROR`/`WS_UNKNOWN_ERROR`) 추가
3. `getErrorCode()` dead method 제거 (필터가 `getErrorResponse()`로 통일된 후 호출처 0건)
4. `ApiUnauthorizedErrorResponseDto` dead export 제거 — 가드 401의 실응답은 `AuthUnauthorized`(AUTH_UNAUTHORIZED)이므로 혼동 방지. code `UNAUTHORIZED`는 필터 fallback에서만 생성됨(주석으로 명시)
5. `defineDomainError`의 `name` 옵션 docstring 정정 — 공통(무접두사) 코드는 항상 명시 필요함을 명문화
- 기각된 후보: joinTeam/chatMessage ack 소실(프론트가 ack 콜백 미사용 — 실코드 확인), JWT_SECRET→AUTH_INVALID_TOKEN 분류(HTTP 가드와 동일 기존 분류), 500→404(의도된 D3), 필터 객체 할당(무의미)
- 반영 후 재검증: 빌드/lint 통과, 로컬 기동 실측 — OpenAPI 스펙 동일(미명세 1건 = health 503 의도분), 에러 응답 포맷 동일

### QA 리뷰 결과 (2026-07-22 /review)
- **발견·수정 1건**: `POST /teams/invites/accept`의 400이 멀티라인 선언이라 type 매핑 스크립트를 빗겨감 → `TeamInviteExpiredErrorResponseDto` 부착. 추가로 이 엔드포인트의 기존 404 명세('팀을 찾을 수 없습니다')는 서비스가 실제로 던지지 않는 레거시 오류 문서였음 → 실동작(`TeamInviteNotFound`)으로 교체.
- **추가 실측 완료**: 429 스로틀(`TOO_MANY_REQUESTS` 실측), 502 카카오(`AUTH_KAKAO_API_ERROR`), WS 무토큰 joinTeam(`AUTH_UNAUTHORIZED` + timestamp — Engine.IO polling으로 실측), metrics XFF 차단(403 `FORBIDDEN` 포맷 동일). OpenAPI 전수: 4xx/5xx 129건 중 미명세 1건(health 503 — D4 의도된 제외)만 잔존.

### 남은 작업
- [ ] 인증 필요한 수동 E2E: 텔레그램/디스코드 status·unlink 5개 엔드포인트에서 팀 미존재 시 404+TEAM_NOT_FOUND 확인, WS 유효 토큰으로 FORBIDDEN/CHAT_NOT_JOINED 확인, 프론트 주요 화면 동작
- [ ] `docs/blog-api-throttling.md` 429 포맷 서술 정정
- [ ] Phase별 커밋 분리 (사용자 승인 후)

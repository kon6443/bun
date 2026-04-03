# NestJS 고도화 전략 — FiveSouth (bun)

> 작성일: 2026-04-03 | 최종 수정: 2026-04-04
> 브랜치: `feat-onam`
> 목표: 안정성 + 구조적 업그레이드
> 참고 프로젝트: `mobisell-back` (Pino, Port/Adapter, 테스트 Factory 등)

---

## 환경 제약사항

| 항목 | 상태 |
|------|------|
| DB | Oracle (LOCAL/PROD **동일 DB 공유**, QA 환경 없음) |
| 인메모리 테스트 DB | **사용 불가** — Entity에 Oracle 전용 타입(`varchar2`, `number`, `clob`) 하드코딩 |
| Redis | 상용 Redis 사용 중 |
| 테스트 전략 | **100% Mock 기반** — 실제 DB/Redis 연결 금지 (상용 데이터 오염 위험) |

---

## 진행률

```
완료: 15/21  |  남은: 6  |  보류: 1
```

---

## 남은 작업 (Phase 5) — 실행 순서

| 순서 | 태스크 | 난이도 | 위험도 | 효과 | 선행 |
|:---:|--------|:---:|:---:|:---:|:---:|
| 9 | **D2 테스트 인프라 구축** | 어려움 | 🟢 | 매우 높음 | 없음 |
| 10 | **D3 Port/Adapter (외부 서비스)** | 보통 | 🟢 | 높음 | 없음 |
| 11 | **D5 단위 테스트 작성** | 보통 | 🟢 | 높음 | D2 |
| 12 | **D1 TeamService 분리** | 어려움 | 🟡 | 높음 | D5 |
| 13 | **D6 E2E 테스트 작성** | 어려움 | 🟡 | 매우 높음 | D2 |
| 14 | **D4 typeorm-transactional** | 보통 | 🟡 | 보통 | 없음 |
| — | ~~B3 Redis Custom Provider~~ | 보통 | 🔴 | 보통 | **보류** |

### 의존 관계

```
D2 (인프라) ──→ D5 (단위 테스트) ──→ D1 (TeamService 분리)
           ──→ D6 (E2E 테스트)
D3 (Port/Adapter) ──→ D5 모킹 편의 향상 (필수는 아님, 수동 mock으로 대체 가능)
D4 (typeorm-transactional) ──→ 독립 (단, 테스트 DB 없어 수동 검증만)
```

---

## D2. 테스트 인프라 구축

- **난이도**: 어려움 | **효과**: 매우 높음 | **위험도**: 🟢 낮음 | **범위**: 설정 + 유틸 파일 다수

### 현재 상태

| 항목 | 상태 | 비고 |
|------|:---:|------|
| jest.config.js | ✅ 존재 | ts-jest, 모듈 매핑(@common, @entities, @modules) 설정됨 |
| 테스트 패키지 | ❌ 미설치 | jest, ts-jest, @nestjs/testing, supertest, @types/jest 전부 없음 |
| 테스트 스크립트 | ❌ 없음 | package.json에 test/test:watch/test:cov/test:e2e 없음 |
| 기존 테스트 파일 | 2개 | `users.service.spec.ts`, `users.controller.spec.ts` (스캐폴딩 수준) |
| 테스트 커버리지 | 0% | 실행 불가 상태 |

### 구현 내용

**1. 패키지 설치**
```bash
pnpm add -D jest ts-jest @types/jest @nestjs/testing supertest @types/supertest
pnpm add -D @faker-js/faker rosie @types/rosie   # Entity Factory (Build 패턴)
pnpm add -D ioredis-mock                          # Redis 모킹
pnpm add -D socket.io-client                      # WS E2E 테스트
```

> **`rosie` 도입 근거** (mobisell-back 검증됨): `Factory.build()`, `Factory.buildList(5)` 패턴으로 기본값+override 지원.

**2. package.json 스크립트 추가**
```json
{
  "test": "jest",
  "test:watch": "jest --watch",
  "test:cov": "jest --coverage",
  "test:e2e": "jest --config ./test/jest-e2e.json"
}
```

**3. Entity Factory** (`src/entities/__spec__/` — co-location 패턴)

```typescript
// src/entities/__spec__/user.entity.factory.ts
export const UserEntityFactory = new Factory<User>()
  .attrs({
    userId: () => faker.number.int({ min: 1, max: 99999 }),
    userName: () => faker.person.fullName(),
    kakaoId: () => faker.number.int({ min: 100000, max: 999999 }),
    kakaoEmail: () => faker.internet.email(),
    createdDate: () => new Date(),
    isActivated: 1,
  })
  .after((obj) => Object.assign(new User(), obj));
```

대상 Entity (8개): User, Team, TeamMember, TeamTask, TaskComment, TeamInvitation, TelegramLink, FileShare

**4. Mock Adapter 패턴** (D3 Port/Adapter 완료 후)
```typescript
export class MockNotificationAdapter {
  static build(): jest.Mocked<INotificationPort> {
    return { sendTeamNotification: jest.fn() };
  }
}
```

**5. Mock Repository Helper** (`test/helpers/mock-repository.ts`)

**6. E2E 헬퍼** (`test/helpers/`)
- `create-testing-app.ts` — NestJS 앱 생성 + 전역 설정
- `e2e-auth.ts` — 고정 테스트 계정 + JWT 토큰 발급

**7. jest.config.js 업데이트**
- `transformIgnorePatterns`: `@faker-js/faker` ESM 모듈 변환 허용
- `@config` path alias 추가 (현재 누락)

**8. 기존 테스트 파일 호환성**
- mockUser에 `teams: []`, `teamMembers: []` relation 필드 포함 — Entity 관계 수정(A1) 후 타입 호환 확인 필요

### ⚠️ 주의 사항

- **인메모리 테스트 DB 사용 불가**: Entity에 Oracle 전용 타입 하드코딩 → SQLite/pg-mem 등 모두 호환 불가. **모든 테스트는 Mock Repository 기반**
- **상용 DB 공유**: LOCAL/PROD 동일 DB → **테스트에서 실제 DB 연결 절대 금지**
- **Redis 모킹**: `ioredis-mock` — `pipeline()`, `hgetall()`, `expire()` 지원 여부 확인 필요
- **fetch 모킹**: `jest.spyOn(global, 'fetch')` (Node 18+ 내장 fetch)
- **typeorm-transactional mock**: D4 도입 후 no-op 모킹 필요

### 실행 체크리스트
```
[ ] 테스트 패키지 설치
[ ] package.json 스크립트 추가
[ ] jest.config.js 업데이트 (transformIgnorePatterns, @config alias)
[ ] test/jest-e2e.json 생성
[ ] src/entities/__spec__/ — Entity Factory 구현 (8개)
[ ] test/helpers/mock-repository.ts
[ ] test/helpers/create-testing-app.ts
[ ] test/helpers/e2e-auth.ts
[ ] 기존 spec 파일 실행 가능 확인
[ ] jest 정상 동작 확인
```

---

## D3. Port/Adapter 패턴 (외부 서비스 분리)

- **난이도**: 보통 | **효과**: 높음 | **위험도**: 🟢 낮음 | **범위**: 4~6파일

> **mobisell-back 검증**: 6개 Port/Adapter 운영 중. `MockAdapter.build()` 패턴으로 테스트에서 완전 교체 가능.

### 현재 외부 의존성

| 서비스 | 외부 API | fetch 위치 | Port 후보 |
|--------|---------|:---:|----------|
| AuthService | Kakao OAuth | :49 | `IKakaoAuthPort` |
| TelegramService | Telegram Bot API | :113 | `ITelegramPort` |
| DiscordService | Discord Webhook | :54, :117 | `IDiscordPort` |

### 영향 범위 (전수 확인 완료)

- **NotificationService 주입처**: 1곳만 (`TeamService:103` — `notifyTeam()` 7곳 호출)
- **NotificationModule**: `@Global()` — Port 전환 후에도 유지 필요
- **TelegramService/DiscordService**: Repository 의존성 있음 (Team, TelegramLink) — Adapter 내부에 유지

### 단계적 적용

1. **NotificationPort** (가장 단순, 주입처 1곳)
2. **KakaoAuthPort** (AuthService fetch 분리)
3. **Telegram/DiscordPort** (Repository 의존성 처리)

### 실행 체크리스트
```
[ ] INotificationPort + NOTIFICATION_PORT Symbol 정의
[ ] NotificationAdapter 구현
[ ] TeamService 주입부 Symbol 토큰 교체
[ ] MockNotificationAdapter.build() 구현
[ ] IKakaoAuthPort (선택)
[ ] tsc --noEmit + 앱 시작 확인
```

---

## D5. 단위 테스트 작성 (Unit Test)

- **난이도**: 보통 | **효과**: 높음 | **위험도**: 🟢 낮음 | **선행**: D2 완료

### Service 테스트 (10개)

| 우선순위 | 대상 | 줄 수 | 의존성 | 테스트 핵심 |
|:---:|------|:---:|------|------|
| 1 | **AuthService** | 168 | ConfigService, User Repo, fetch | JWT 생성/검증, 카카오 ID 검증 |
| 2 | **TeamService** (핵심) | 1514 | 6 Repo, ConfigService, NotificationService | 팀/태스크 CRUD, 권한 검증 |
| 3 | **OnlineUserService** | 238 | Redis | 소켓-유저 매핑, 온라인 목록 |
| 4 | **FishingOnlineService** | 320 | Redis | 맵 참가/이탈, 위치/상태 |
| 5 | **SchedulerService** | 109 | User Repo, TeamTask Repo | autoArchiveTasks |
| 6 | **NotificationService** | 49 | TelegramService, DiscordService | 알림 분기 |
| 7 | **TelegramService** | 459 | Team Repo, TelegramLink Repo, fetch | Webhook, 연동/해제 |
| 8 | **DiscordService** | 183 | Team Repo, fetch | Webhook, 연동/해제 |
| 9 | **FileShareService** | 40 | FileShare Repo | API Key 검증 |
| 10 | **UsersService** | 55 | User Repo | 기존 spec 보완 |

### 모킹 전략

| 의존성 | 모킹 방법 |
|--------|----------|
| TypeORM Repository | `createMockRepository()` (D2 헬퍼) |
| TypeORM DataSource | `jest.fn()` mock (TeamService의 `dataSource.transaction()`) |
| ConfigService | `{ get: jest.fn((key) => defaults[key]) }` |
| Redis (ioredis) | `ioredis-mock` 또는 수동 mock |
| fetch | `jest.spyOn(global, 'fetch')` |
| NotificationService | `MockNotificationAdapter.build()` (D3 후) |
| typeorm-transactional | `jest.mock(...)` no-op (D4 후) |

### Controller 테스트 (8개, 33 엔드포인트)

| 우선순위 | Controller | 엔드포인트 | 테스트 핵심 |
|:---:|-----------|:---:|------|
| 1 | **TeamController** | 24 | CRUD, 권한 검증 |
| 2 | **AuthController** | 1 | 카카오 로그인 → JWT → Cookie |
| 3 | **UsersController** | 2 | 기존 spec 검증 |
| 4 | **TelegramController** | 1 | Webhook → 200 OK |
| 5 | **FileShareController** | 2 | API Key 검증 |
| 6 | **MainController** | 1 | 루트 엔드포인트 |
| 7 | **HealthController** | 1 | terminus DB ping 응답 |
| 8 | **UsersController** (auth/) | 1 | 닉네임 수정 |

### Gateway 핸들러 테스트 (8개)

| Gateway | 이벤트 | DTO | 테스트 핵심 |
|---------|--------|-----|------|
| TeamGateway | `joinTeam` | `JoinTeamDto` | Room 참가, 온라인 등록 |
| TeamGateway | `leaveTeam` | `LeaveTeamDto` | Room 퇴장, 온라인 제거 |
| FishingGateway | `joinMap` | `JoinMapDto` | 맵 참가, `_fishingMapId` 캐싱 |
| FishingGateway | `leaveMap` | `LeaveMapDto` | 맵 퇴장, 상태 제거 |
| FishingGateway | `move` | `MoveDto` | 위치 브로드캐스트 (고빈도) |
| FishingGateway | `fishingState` | `FishingStateDto` | 상태 변경 브로드캐스트 |
| FishingGateway | `chatMessage` | `ChatMessageDto` | 채팅 브로드캐스트 |
| FishingGateway | `catchResult` | `CatchResultDto` | 낚시 결과 브로드캐스트 |

### Guard/Filter 테스트 (6개)

| 대상 | 테스트 핵심 |
|------|------|
| **HttpExceptionFilter** | ApiErrorResponseDto/HttpException/unknown 3분기 |
| **WsExceptionFilter** | WS 에러 이벤트 전송 |
| **JwtAuthGuard** | Cookie→Bearer 폴백, 만료/잘못된/없는 토큰 |
| **OptionalJwtAuthGuard** | 토큰 없어도 통과, 잘못된 토큰 차단 |
| **WsJwtGuard** | handshake.auth.token 추출, 인증 실패 시 disconnect |
| **FishingWsGuard** | FishingSocket data 설정, 인증 여부 |

### ⚠️ TeamService 테스트 주의

- **1514줄, 의존성 9개** → D1 분리 전에는 핵심 메서드만
- QueryBuilder mock 체이닝 필요: `select().where().innerJoinAndSelect().getMany()` 등

### 실행 체크리스트

```
Service (10개):
  [ ] AuthService, TeamService (핵심), OnlineUserService, FishingOnlineService
  [ ] SchedulerService, NotificationService, TelegramService, DiscordService
  [ ] FileShareService, UsersService (기존 spec 보완)

Controller (8개, 33 엔드포인트):
  [ ] TeamController (24), AuthController (1), UsersController (2)
  [ ] TelegramController (1), FileShareController (2)
  [ ] MainController (1), HealthController (1), UsersController-auth (1)

Guard/Filter (6개):
  [ ] JwtAuthGuard, OptionalJwtAuthGuard, WsJwtGuard, FishingWsGuard
  [ ] HttpExceptionFilter, WsExceptionFilter

Gateway (8개):
  [ ] TeamGateway (joinTeam, leaveTeam)
  [ ] FishingGateway (joinMap, leaveMap, move, fishingState, chatMessage, catchResult)
```

---

## D1. TeamService 분리 (Fat Service 해소)

- **난이도**: 어려움 | **효과**: 높음 | **위험도**: 🟡 중간 | **선행**: D5 (테스트 안전망)
- 1514줄 → `TaskService`, `CommentService`, `InvitationService`로 분리
- TeamService에 남는 것: 팀 CRUD, 팀원 관리

---

## D6. E2E 테스트 작성

- **난이도**: 어려움 | **효과**: 매우 높음 | **위험도**: 🟡 중간 | **선행**: D2 완료

### E2E 전략

| 전략 | 상태 | 이유 |
|------|:---:|------|
| **A. Mock Repository E2E** | **채택** | DB 불필요, CI 친화적 |
| ~~B. 인메모리 DB~~ | **불가** | Oracle 전용 타입 호환 불가 |
| ~~C. 테스트 Oracle DB~~ | **불가** | 상용 DB 공유, QA DB 없음 |
| D. Docker Oracle (향후) | **향후** | 이미지 8GB, 시작 5분+ |

### 테스트 대상 플로우

| 우선순위 | 플로우 | 엔드포인트 | 검증 내용 |
|:---:|--------|----------|----------|
| 1 | 인증 | `POST /auth/kakao` | 카카오 토큰 → JWT → Cookie |
| 2 | 팀 CRUD | `POST/GET/PUT/DELETE /teams` | 팀 생성, 조회, 수정, 삭제 |
| 3 | 태스크 CRUD | `POST/GET/PUT /teams/:id/tasks` | 태스크 생성, 상태 변경 |
| 4 | 팀원 관리 | `POST /teams/:id/invite` 등 | 초대, 수락, 역할 변경 |
| 5 | 댓글 | `POST/GET /teams/:id/tasks/:taskId/comments` | 댓글 CRUD |
| 6 | 파일 공유 | `GET /files` | API Key 검증 |
| 7 | 헬스 체크 | `GET /health-check` | DB 상태 응답 |

### ⚠️ 인증 모킹

- CRUD 테스트: `JwtAuthGuard` override → 인증 우회
- 인증 테스트: 카카오 API만 mock, Guard 실제 사용

### WebSocket E2E

| 플로우 | 이벤트 | 검증 |
|--------|--------|------|
| 팀 온라인 | joinTeam → leaveTeam | 온라인 목록, Redis 키 |
| 낚시 맵 | joinMap → move → leaveMap | 위치 브로드캐스트 |

### 실행 체크리스트
```
[ ] test/jest-e2e.json, 인증 우회/포함 모듈
[ ] health-check.e2e-spec.ts (인프라 검증용)
[ ] auth, team, task, invitation, comment, file-share
[ ] WS: team-gateway, fishing-gateway
```

---

## D4. typeorm-transactional 도입

- **난이도**: 보통 | **효과**: 보통 | **위험도**: 🟡 중간 | **범위**: 3~5파일

> **mobisell-back 검증**: MySQL에서 정상 운영. **Oracle 미검증**.

### 현재 트랜잭션 사용 (전수 확인)

| 메서드 | 줄 | 내용 | 마이그레이션 |
|--------|:---:|------|------------|
| `insertTeam()` | 300-314 | Team 생성 + TeamMember 삽입 | `@Transactional()` + Repository 전환 |
| `acceptTeamInvite()` | 1183-1233 | 초대 검증 + TeamMember + 상태 업데이트 | `@Transactional()` + Repository 전환 |

**마이그레이션 주의**: 현재 `manager.create()`/`manager.save()` → `@Transactional()` 후 주입된 Repository 사용으로 변경 필요

### ⚠️ Oracle 호환성 위험

- CLS + Oracle connection pool 동작 차이 가능
- **테스트 DB 없음** → 수동 검증만 가능 (INSERT 2건 → 1건 실패 → 롤백 확인)
- 자동화된 Integration Test는 Docker Oracle 도입 후

### 실행 체크리스트
```
[ ] typeorm-transactional 설치
[ ] Oracle 호환성 수동 테스트
[ ] main.ts에 initializeTransactionalContext()
[ ] TypeORM 설정에 addTransactionalDataSource
[ ] TeamService 메서드에 @Transactional()
[ ] 테스트 setup에 typeorm-transactional mock
[ ] tsc --noEmit + 앱 시작 확인
```

---

## B3. Redis Custom Provider (보류)

- **위험도**: 🔴 높음 | **상태**: 보류
- **이유**: RedisIoAdapter 초기화 타이밍 보장 불가 → Silent failure 위험
- **현재**: main.ts 수동 관리 (안전)
- **재검토**: NestJS WebSocket Adapter DI 공식 지원 시

---

## 전체 체크리스트

```
Phase 1~4 — 완료 (15개)
  [✓] A2  환경변수 검증
  [✓] B1  console → Logger (8파일 30+곳)
  [✓] B4  소켓 타입 안전성 ((client as any) 5곳 제거)
  [✓] C3  Graceful shutdown (enableShutdownHooks + Redis disconnect + 30s 타임아웃)
  [✓] A1  Entity 관계 수정 (ManyToOne/OneToMany 정정)
  [✓] B2  글로벌 설정 DI 기반 (APP_FILTER/APP_PIPE)
  [✓] C1  Pino 도입 (+ F2 Request ID + F3 마스킹 자동 해결)
  [✓] F1  ValidationPipe 에러 통일 (exceptionFactory + 422)
  [✓] F4  에러 필터 로깅 강화 (알 수 없는 예외 원본 로깅)
  [✓] C2  Health check 강화 (@nestjs/terminus DB ping)
  [✓] E2  env.validation 리팩토링 (class-validator)
  [✓] E1  Swagger persistAuth
  [✓] uncaughtException/unhandledRejection 핸들러 추가
  [✓] pino-http transport.targets 호환성 수정 (formatters.level 분리)

Phase 5 — 남은 작업 (6개)
  [ ] D2  테스트 인프라 구축 (패키지, Factory, Helper)
  [✓] D3  Port/Adapter — NotificationPort 완료 (INotificationPort + Symbol + useExisting)
  [ ] D5  단위 테스트 (Service 10 + Controller 8 + Guard/Filter 6 + Gateway 8)
  [ ] D1  TeamService 분리 (1514줄 → 3~4 서비스)
  [ ] D6  E2E 테스트 (Mock Repository, HTTP 7플로우 + WS 2플로우)
  [ ] D4  typeorm-transactional (Oracle 호환성 확인 필요)
  [⏸] B3  Redis Custom Provider (보류)
```

---

## 프론트엔드 영향

**모든 Phase 5 작업은 프론트엔드 수정 불필요** — 내부 리팩토링/테스트만. API 응답 형식 무변경.

---

## 위험도 요약

| 작업 | 위험도 | 핵심 이유 |
|------|:---:|----------|
| D2 테스트 인프라 | 🟢 낮음 | 설정/유틸 추가만, 프로덕션 무변경 |
| D3 Port/Adapter | 🟢 낮음 | 주입처 1곳(TeamService). @Global() 유지 |
| D5 단위 테스트 | 🟢 낮음 | 테스트 코드 추가만 |
| D1 TeamService 분리 | 🟡 중간 | 1514줄 분리, 호출 체인 전수 확인 필요 |
| D6 E2E 테스트 | 🟡 중간 | 인메모리 DB 불가 + 상용 DB 공유 → Mock 전용 |
| D4 typeorm-transactional | 🟡 중간 | Oracle 호환성 미확인 + 테스트 DB 없음 |
| B3 Redis Provider | 🔴 높음 | 초기화 타이밍 불확실 → **보류** |

# NestJS 고도화 전략 — FiveSouth (bun)

> 작성일: 2026-04-03 | 최종 수정: 2026-04-13 (D10 보강: node_exporter + 팀별 접속자 메트릭)
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
완료: 25/37  |  남은: 10  |  보류: 2
```

---

## 남은 작업 (Phase 5) — 실행 순서

| 순서 | 태스크 | 난이도 | 위험도 | 효과 | 선행 |
|:---:|--------|:---:|:---:|:---:|:---:|
| ~~9~~ | ~~D3 Port/Adapter~~ | — | — | — | **✅ 완료** |
| 10 | **D2 테스트 인프라 구축** | 어려움 | 🟢 | 매우 높음 | 없음 |
| ~~11~~ | ~~D7 매직 문자열 enum화~~ | — | — | — | **✅ 완료** |
| ~~12~~ | ~~D11 ESLint 설정~~ | — | — | — | **✅ 완료** |
| 13 | **D5 단위 테스트 작성** | 보통 | 🟢 | 높음 | D2 |
| 14 | **D1 TeamService 분리** | 어려움 | 🟡 | 높음 | D5 |
| 15 | **D6 E2E 테스트 작성** | 어려움 | 🟡 | 매우 높음 | D2 |
| 16 | **D4 typeorm-transactional** | 보통 | 🟡 | 보통 | 없음 |
| ~~17~~ | ~~D12 Express 흔적 제거~~ | — | — | — | **✅ 완료** |
| ~~18~~ | ~~D13 NestJS 비정석 패턴 수정~~ | — | — | — | **✅ 완료** |
| ~~19~~ | ~~D8 API Rate Limiting~~ | — | — | — | **✅ 완료** |
| ~~20~~ | ~~D9 응답 압축~~ | — | — | — | **✅ 완료** |
| 21 | **D10 메트릭 수집 (Prometheus+Grafana+node_exporter)** | 보통 | 🟢 | 높음 | 없음 (추후) |
| 22 | **D14 ResponseInterceptor** | 보통 | 🟡 | 매우 높음 | **보류 — API별 code/message/action 커스텀 예정으로 인터셉터 불적합** |
| ~~23~~ | ~~D15 @CurrentUser 데코레이터~~ | — | — | — | **✅ 완료** |
| ~~24~~ | ~~D16 하드코딩 상수화~~ | — | — | — | **✅ 완료** |
| ~~25~~ | ~~D17 as any 타입 개선~~ | — | — | — | **✅ 완료** |
| 26 | **D18 PaginationDto 공통화** | 쉬움 | 🟢 | 보통 | 없음 (추후) |
| 27 | **D19 파일 다운로드 StreamableFile 전환** | 보통 | 🟡 | 높음 | 없음 |
| 28 | **D20 Swagger 리다이렉트 NestMiddleware 전환** | 쉬움 | 🟢 | 보통 | 없음 |
| 29 | **D21 파일 다운로드 에러 응답 통일** | 쉬움 | 🟢 | 보통 | D19 |
| — | ~~B3 Redis Custom Provider~~ | 보통 | 🔴 | 보통 | **보류** |

### 의존 관계

```
D2 (인프라) ──→ D5 (단위 테스트) ──→ D1 (TeamService 분리)
           ──→ D6 (E2E 테스트)
✅ D3 (Port/Adapter) ──→ D5 모킹 편의 향상 (필수는 아님, 수동 mock으로 대체 가능)
D4 (typeorm-transactional) ──→ 독립 (단, 테스트 DB 없어 수동 검증만)
✅ D7 (매직 문자열) ──→ 완료
✅ D8 (Rate Limiting) ──→ 완료
✅ D9 (응답 압축) ──→ 완료
D10 (메트릭 수집) ──→ 독립 (추후, Docker 인프라 필요)
✅ D11 (ESLint) ──→ 완료
✅ D12 (Express 흔적 제거) ──→ 완료
✅ D13 (NestJS 비정석 패턴) ──→ 완료
D14 (ResponseInterceptor) ──→ 보류 (API별 code/message/action 커스텀 예정 → 인터셉터 불적합)
✅ D15 (@CurrentUser) ──→ 완료
✅ D16 (하드코딩 상수화) ──→ 완료
✅ D17 (as any 타입 개선) ──→ 완료
D18 (PaginationDto) ──→ 독립 (추후, 목록 API 확장 시)
D19 (StreamableFile) ──→ 독립 (Express @Res 제거)
D20 (Swagger NestMiddleware) ──→ 독립 (Express 인라인 미들웨어 제거)
D21 (에러 응답 통일) ──→ D19 완료 시 자동 해결
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
    return { notifyTeam: jest.fn() };  // INotificationPort.notifyTeam()
  }
}
```

**5. Mock Repository Helper** (`test/helpers/mock-repository.ts`)

**6. E2E 헬퍼** (`test/helpers/`)
- `create-testing-app.ts` — NestJS 앱 생성 + 전역 설정
- `e2e-auth.ts` — 고정 테스트 계정 + JWT 토큰 발급

**7. jest.config.js 업데이트**
- `transformIgnorePatterns`: `@faker-js/faker` ESM 모듈 변환 허용
- `@config` path alias 추가 (현재 누락 — tsconfig.json에는 정의됨)
- `@/*` catch-all path alias 추가 (현재 누락 — tsconfig.json에는 정의됨)

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
[ ] jest.config.js 업데이트 (transformIgnorePatterns, @config + @/* alias 추가)
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
| AuthService | Kakao OAuth | :50 | `IKakaoAuthPort` |
| TelegramService | Telegram Bot API | :115 | `ITelegramPort` |
| DiscordService | Discord Webhook | :54, :117 | `IDiscordPort` |

### 영향 범위 (전수 확인 완료)

- **NotificationPort 주입처**: 1곳만 (`TeamService:108` — `notifyTeam()` 7곳 호출)
- **NotificationModule**: `@Global()` — Port 전환 후에도 유지 필요
- **TelegramService/DiscordService**: Repository 의존성 있음 (Team, TelegramLink) — Adapter 내부에 유지

### 단계적 적용

1. **NotificationPort** (가장 단순, 주입처 1곳)
2. **KakaoAuthPort** (AuthService fetch 분리)
3. **Telegram/DiscordPort** (Repository 의존성 처리)

### 실행 체크리스트
```
[✓] INotificationPort + NOTIFICATION_PORT Symbol 정의
[✓] NotificationAdapter 구현 (NotificationService → NotificationAdapter 이름 변경)
[✓] TeamService 주입부 Symbol 토큰 교체 (@Inject(NOTIFICATION_PORT))
[ ] MockNotificationAdapter.build() 구현 (D2/D5에서)
[ ] IKakaoAuthPort (선택)
[✓] tsc --noEmit + 앱 시작 확인
```

---

## D5. 단위 테스트 작성 (Unit Test)

- **난이도**: 보통 | **효과**: 높음 | **위험도**: 🟢 낮음 | **선행**: D2 완료

### Service 테스트 (10개)

| 우선순위 | 대상 | 줄 수 | 의존성 | 테스트 핵심 |
|:---:|------|:---:|------|------|
| 1 | **AuthService** | 167 | ConfigService, User Repo, fetch | JWT 생성/검증, 카카오 ID 검증 |
| 2 | **TeamService** (핵심) | 1520 | 6 Repo, ConfigService, NotificationPort | 팀/태스크 CRUD, 권한 검증 |
| 3 | **OnlineUserService** | 238 | Redis | 소켓-유저 매핑, 온라인 목록 |
| 4 | **FishingOnlineService** | 320 | Redis | 맵 참가/이탈, 위치/상태 |
| 5 | **SchedulerService** | 112 | User Repo, TeamTask Repo | autoArchiveTasks |
| 6 | **NotificationAdapter** | 42 | TelegramService, DiscordService | 알림 분기 |
| 7 | **TelegramService** | 461 | Team Repo, TelegramLink Repo, fetch | Webhook, 연동/해제 |
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
| NotificationAdapter | `MockNotificationAdapter.build()` (D3 완료됨) |
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
| 8 | **UsersController** (users/) | 2 | 유저 조회/수정 |
| 9 | **UsersController** (auth/) | 1 | 닉네임 수정 |

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

- **1520줄, 의존성 9개** → D1 분리 전에는 핵심 메서드만
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
- 1520줄 → `TaskService`, `CommentService`, `InvitationService`로 분리
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

### 현재 트랜잭션 사용 (전수 확인 — 4곳)

| 파일 | 메서드 | 줄 | 내용 | 마이그레이션 |
|------|--------|:---:|------|------------|
| `team.service.ts` | `insertTeam()` | 306-320 | Team 생성 + TeamMember 삽입 | `@Transactional()` + Repository 전환 |
| `team.service.ts` | `acceptTeamInvite()` | 1189-1240 | 초대 검증 + TeamMember + 상태 업데이트 | `@Transactional()` + Repository 전환 |
| `telegram.service.ts` | 텔레그램 연동 | 336 | TelegramLink 생성 트랜잭션 | `@Transactional()` + Repository 전환 |
| `telegram.service.ts` | 텔레그램 해제 | 435 | TelegramLink 삭제 트랜잭션 | `@Transactional()` + Repository 전환 |

**마이그레이션 주의**: 현재 `manager.create()`/`manager.save()` → `@Transactional()` 후 주입된 Repository 사용으로 변경 필요

> ⚠️ telegram.service.ts의 트랜잭션 2곳도 마이그레이션 대상. 누락 시 텔레그램 연동/해제 중 부분 실패 가능

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
[ ] TeamService 메서드에 @Transactional() (insertTeam, acceptTeamInvite)
[ ] TelegramService 메서드에 @Transactional() (연동, 해제)
[ ] 테스트 setup에 typeorm-transactional mock
[ ] tsc --noEmit + 앱 시작 확인
```

---

## D7. 매직 문자열 enum화

- **난이도**: 쉬움 | **효과**: 보통 | **위험도**: 🟢 낮음 | **범위**: 4파일
- **선행**: 없음 (독립 실행 가능)

> **mobisell-back 패턴**: TypeScript enum + const object as const + Record 변환 테이블 3가지 병용. 이 프로젝트는 이미 `ROLE_HIERARCHY` const object 패턴을 사용 중이므로, 기존 패턴을 유지하면서 문자열 리터럴만 상수 참조로 교체.

### 현재 문제 (전수 확인)

`'MASTER'`, `'MANAGER'`, `'MEMBER'`, `'KAKAO'` 문자열이 코드에 직접 사용됨 (총 21곳).
`RoleKey` 타입과 `ROLE_HIERARCHY` 상수는 있지만, 실제 코드에서 상수를 참조하지 않아 오타 시 TypeScript가 잡지 못함.

### 변경 대상 (전수 확인)

**역할 문자열 (19곳):**

| 파일:줄 | 현재 코드 | 변경 후 |
|---------|----------|--------|
| `role.constants.ts:40` | `newRole === 'MASTER'` | 이미 상수 파일 내부 → 유지 |
| `role.constants.ts:45,50,51,94` | `'MASTER'`, `'MANAGER'` | 이미 상수 파일 내부 → 유지 |
| `team.service.ts:315` | `role: 'MASTER'` | `role: 'MASTER' as RoleKey` |
| `team.service.ts:1015` | `['MASTER', 'MANAGER'].includes(...)` | `MANAGEMENT_ROLES.includes(... as RoleKey)` |
| `team.service.ts:1220,1230` | `role: 'MEMBER'` | `role: 'MEMBER' as RoleKey` |
| `team.service.ts:1269` | `['MASTER', 'MANAGER'].includes(...)` | `MANAGEMENT_ROLES.includes(... as RoleKey)` |
| `team.service.ts:1298` | `'MANAGER' \| 'MEMBER'` | 타입 정의 → 유지 |
| `team.service.ts:1464` | `targetCurrentRole === 'MASTER'` | 상수 참조 또는 유지 |
| `team.controller.ts:84` | `['MASTER', 'MANAGER'].includes(...)` | `MANAGEMENT_ROLES.includes(... as RoleKey)` |
| `team.dto.ts:24` | `type TeamMemberRoleType` | 유지 (타입 정의) |
| `team.dto.ts:548` | `enum: ['MANAGER', 'MEMBER']` | Swagger 데코레이터 → 유지 |

**로그인 타입 문자열 (2곳):**

| 파일:줄 | 현재 코드 | 변경 후 |
|---------|----------|--------|
| `auth.service.ts:143` | `const loginType = 'KAKAO'` | `const loginType: LoginType = 'KAKAO'` |
| `auth.dto.ts:28` | Swagger example | 유지 |

### 구현 방법

**1. LoginType 추가** (`src/common/enums/` 또는 `auth.dto.ts`)
```typescript
export type LoginType = 'KAKAO';
// 향후 네이버/구글 추가 시: 'KAKAO' | 'NAVER' | 'GOOGLE'
```

**2. team.service.ts + team.controller.ts에서 MANAGEMENT_ROLES 활용**
```typescript
// Before
if (!['MASTER', 'MANAGER'].includes(teamMembers[0].role)) {

// After
import { MANAGEMENT_ROLES } from '../../common/constants/role.constants';
if (!MANAGEMENT_ROLES.includes(teamMembers[0].role as RoleKey)) {
```

### 실행 체크리스트
```
[✓] LoginType 타입 정의 추가
[✓] team.service.ts: ['MASTER','MANAGER'] → MANAGEMENT_ROLES 교체 (3곳)
[✓] team.controller.ts: ['MASTER','MANAGER'] → MANAGEMENT_ROLES 교체 (1곳)
[✓] team.service.ts: role 할당 시 RoleKey 타입 명시 (3곳)
[✓] auth.service.ts: loginType 타입 명시
[✓] tsc --noEmit 통과 확인
[✓] 프론트 영향: 없음 (API 응답 값 변경 없음, 타입만 강화)
```

---

## D11. ESLint 설정

- **난이도**: 쉬움 | **효과**: 보통 | **위험도**: 🟢 낮음 | **범위**: 설정 파일 2~3개
- **선행**: 없음 (독립 실행 가능, D2 전에 하면 테스트 코드에도 적용됨)

### 현재 상태

| 항목 | 상태 |
|------|:---:|
| ESLint 설정 파일 | ❌ 없음 |
| ESLint 패키지 | ❌ 미설치 |
| lint 스크립트 | ❌ 없음 |
| Prettier | ✅ `.prettierrc` 있음 (singleQuote, printWidth:110, trailingComma:all) |
| tsconfig strict | ✅ true |

### ESLint 9 Flat Config (최신 방식)

> ESLint 9부터 `.eslintrc` 대신 `eslint.config.mjs` (Flat Config) 사용. NestJS CLI 11도 Flat Config 기본 생성.

### 패키지

```bash
pnpm add -D eslint @eslint/js typescript-eslint eslint-config-prettier eslint-plugin-prettier
```

| 패키지 | 역할 |
|--------|------|
| `eslint` | 코어 |
| `@eslint/js` | ESLint 기본 규칙 |
| `typescript-eslint` | TypeScript 파서 + 규칙 (v8부터 통합 패키지) |
| `eslint-config-prettier` | Prettier와 충돌하는 ESLint 규칙 비활성화 |
| `eslint-plugin-prettier` | Prettier를 ESLint 규칙으로 실행 |

### 설정 파일 (`eslint.config.mjs`)

```javascript
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
      },
    },
    rules: {
      // NestJS 프로젝트 권장 규칙
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // 필요에 따라 완화
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.js', '*.mjs'],
  },
);
```

### package.json 스크립트

```json
{
  "lint": "eslint src/",
  "lint:fix": "eslint src/ --fix"
}
```

### ⚠️ 주의 사항

- **초기 에러 대량 발생 가능**: `@typescript-eslint/no-explicit-any`를 `warn`으로 시작 → 점진적 `error`로 전환
- **기존 `as any` 7곳**: 당장 에러가 아닌 경고로 표시됨. 점진적으로 제거
- **`no-floating-promises`**: await 누락 감지 — Pino의 fire-and-forget 패턴(`pipeline.exec()` 등)에서 경고 발생 가능. 의도적인 경우 `void` 접두사로 명시
- **Prettier 충돌**: `eslint-config-prettier`가 포맷 관련 ESLint 규칙을 비활성화하므로 충돌 없음
- **CI 연동**: D2(테스트 인프라) 이후 CI에 `pnpm lint` 추가하면 PR 시 자동 검사

### Git Hooks (선택 — 같이 하면 좋음)

```bash
pnpm add -D husky lint-staged
npx husky init
```

```json
// package.json
"lint-staged": {
  "src/**/*.ts": ["eslint --fix", "prettier --write"]
}
```

→ 커밋 시 변경된 파일만 자동 lint + format

### 실행 체크리스트
```
[✓] ESLint 패키지 설치
[✓] eslint.config.mjs 생성
[✓] package.json에 lint/lint:fix 스크립트 추가
[✓] pnpm lint 실행 → 초기 에러/경고 확인
[✓] 에러 0건 만들기 (경고는 점진적 해결)
[ ] (선택) husky + lint-staged 설치 → pre-commit hook
[ ] (선택) .editorconfig 생성 (IDE 기본 설정 통일)
```

---

## D12. Express 흔적 제거

- **난이도**: 쉬움 | **효과**: 보통 | **위험도**: 🟢 낮음 | **범위**: 2~3파일

### 제거 대상

| 항목 | 파일 | 설명 |
|------|------|------|
| `express-async-errors` | `package.json` | NestJS가 async 에러 자동 처리. 불필요한 Express 전용 패키지 |
| `swagger-jsdoc` | `package.json` | `@nestjs/swagger` 데코레이터로 대체됨. 불필요한 Express 전용 패키지 |
| `data-source.ts` | `src/database/data-source.ts` | TypeORM CLI 마이그레이션용 수동 DataSource. 현재 마이그레이션 미사용(`synchronize: false`), `TypeOrmModule.forRootAsync()`가 대체 |

### ⚠️ 주의 사항

- **`express-async-errors` 제거 전**: 프로젝트에서 `require('express-async-errors')` 또는 `import 'express-async-errors'`로 사용하는 곳이 있는지 grep 확인 필요
- **`swagger-jsdoc` 제거 전**: `@swagger` JSDoc 주석이 남아있는지 확인 필요
- **`data-source.ts` 제거 vs 보관**: 향후 마이그레이션 도입 시 필요할 수 있으므로 삭제 대신 `data-source.ts.bak` 또는 주석 처리도 가능

### 실행 체크리스트
```
[✓] express-async-errors import/require 사용처 grep 확인
[✓] express-async-errors 패키지 제거 (package.json)
[✓] swagger-jsdoc @swagger 주석 사용처 grep 확인
[✓] swagger-jsdoc 패키지 제거 (package.json)
[✓] data-source.ts 제거 또는 주석 처리
[✓] pnpm install + 앱 시작 확인
```

---

## D13. NestJS 비정석 패턴 수정

- **난이도**: 쉬움 | **효과**: 보통 | **위험도**: 🟢 낮음 | **범위**: 4파일

### 수정 대상

**1. process.env 직접 접근 → ConfigService (2곳)**

| 파일:줄 | 현재 코드 | 문제 |
|---------|----------|------|
| `file-share.controller.ts:22` | `process.env.ENV?.toUpperCase()` | 컨트롤러 초기화 수준에서 process.env 직접 접근 |
| `telegram.service.ts:80-81` | `process.env.BOT_TOKEN_TELEGRAM` | 서비스 생성자에서 process.env 직접 접근 |

변경: ConfigService 주입 후 `configService.get<string>('ENV')` 사용

⚠️ **file-share.controller.ts 주의**: `isLocal`과 `SHARED_BASE_DIR`가 클래스 밖 모듈 스코프에서 선언됨. ConfigService는 클래스 안에서만 접근 가능하므로, 해당 로직을 클래스 안으로 이동하거나 별도 Config로 분리 필요

**2. WsExceptionFilter 인스턴스 생성 → 클래스 참조 (2곳)**

| 파일:줄 | 현재 코드 | 변경 |
|---------|----------|------|
| `team.gateway.ts:62` | `@UseFilters(new WsExceptionFilter())` | `@UseFilters(WsExceptionFilter)` |
| `fishing.gateway.ts:64` | `@UseFilters(new WsExceptionFilter())` | `@UseFilters(WsExceptionFilter)` |

⚠️ **전제 조건**: WsExceptionFilter를 해당 모듈의 `providers`에 등록해야 DI가 작동함

### 실행 체크리스트
```
[✓] file-share.controller.ts: process.env → ConfigService 주입 (모듈 스코프 로직 이동)
[✓] telegram.service.ts: process.env → ConfigService 주입
[✓] team.gateway.ts: @UseFilters(new WsExceptionFilter()) → @UseFilters(WsExceptionFilter)
[✓] fishing.gateway.ts: 동일
[✓] TeamModule, FishingModule에 WsExceptionFilter providers 등록
[✓] tsc --noEmit + 앱 시작 확인
```

---

## D8. API Rate Limiting (추후 적용)

- **난이도**: 보통 | **효과**: 높음 | **위험도**: 🟢 낮음 | **범위**: 3~4파일
- **상태**: ✅ 완료 — 2단계 글로벌(초당5/분당60) + 로그인 엄격 + SkipThrottle 3곳

### 개념

API 엔드포인트별로 일정 시간 내 요청 횟수를 제한. 브루트포스 공격, 서버 과부하 방지.

### 패키지

`@nestjs/throttler` — NestJS 공식 Rate Limiting 모듈

### 적용 결정 사항

적용 시 아래 2가지 중 선택 (또는 혼합) 필요:

| 방식 | 식별 기준 | 장점 | 단점 | 적합한 API |
|------|----------|------|------|-----------|
| **IP 기반** (기본) | 요청자 IP | 비로그인 API도 보호 가능 | NAT/프록시 뒤 유저 구분 불가 (같은 회사 Wi-Fi = 같은 IP) | 로그인, 회원가입, 공개 API |
| **userId 기반** | JWT에서 추출한 userId | 유저별 정확한 제한 | 로그인 필요 (비인증 API 불가) | 팀 CRUD, 태스크, 댓글 등 인증 API |

### 권장 설정 (예시)

| API | 방식 | 제한 | 이유 |
|-----|------|------|------|
| `POST /auth/kakao` | IP | 1분에 10회 | 브루트포스 방지 |
| `POST /teams` | userId | 1분에 20회 | 팀 무한 생성 방지 |
| `POST /teams/:id/tasks` | userId | 1분에 30회 | 일반적 사용 |
| `GET /health-check` | 제외 (SkipThrottle) | — | 모니터링용 |
| WebSocket 이벤트 | 별도 처리 | — | throttler는 HTTP만, WS는 자체 throttle |

### 저장소 선택

| 저장소 | 멀티 레플리카 | 현재 인프라 |
|--------|:---:|:---:|
| **메모리** (기본) | ❌ 레플리카별 독립 카운트 | — |
| **Redis** | ✅ 공유 카운트 | ✅ Redis 이미 있음 |

→ Docker Swarm 멀티 레플리카이므로 **Redis 저장소 권장**

### ⚠️ 주의 사항

- **Docker Swarm + 리버스 프록시**: 클라이언트 실제 IP 대신 프록시 IP가 올 수 있음. `X-Forwarded-For` 헤더 처리 필요
- **WebSocket**: `@nestjs/throttler`는 HTTP만 지원. WS 이벤트 throttle은 클라이언트에서 처리 중 (fishing move 등)
- **프론트 UX**: 429 응답 시 프론트에서 재시도 로직 또는 안내 메시지 필요

### 권장 글로벌 설정

```typescript
// 2단계 설정 (순간 폭발 + 지속 남용 동시 방어)
ThrottlerModule.forRoot([
  { name: 'short', ttl: 1000, limit: 5 },     // 초당 5회
  { name: 'long', ttl: 60000, limit: 60 },     // 분당 60회
])
```

### 프론트엔드 연동 (next-bun)

**파일 2개, 각 4줄 이하 변경:**

| 파일 | 변경 |
|------|------|
| `FetchService.ts` | 429 시 `backend:rate-limited` 커스텀 이벤트 발행 (기존 401 패턴 동일) |
| `SessionProvider.tsx` | 이벤트 리스너 → `toast.error('요청이 너무 많습니다...')` |

- 배포 순서 무관 (프론트에 429 처리 없어도 앱 깨지지 않음, UX만 아쉬움)
- `react-hot-toast` 이미 사용 중, 추가 라이브러리 불필요

### 실행 체크리스트
```
백엔드:
  [✓] @nestjs/throttler 설치
  [✓] ThrottlerModule.forRoot() 설정 (app.module.ts) — 2단계 (short + long)
  [✓] ThrottlerGuard를 APP_GUARD로 글로벌 등록
  [✓] 커스텀 ThrottlerGuard 구현 (userId 기반 — 인증 API용)
  [ ] main.ts에 trust proxy 설정 (X-Forwarded-For) — 추후 리버스 프록시 도입 시
  [✓] @Throttle() 엔드포인트별 오버라이드 (로그인 등)
  [✓] @SkipThrottle() 제외 대상 (health-check, main, telegram)
  [✓] tsc --noEmit + 앱 시작 확인

프론트 (next-bun):
  [ ] FetchService.ts에 429 이벤트 발행
  [ ] SessionProvider.tsx에 리스너 + toast.error
```

---

## D9. 응답 압축 (Compression)

- **난이도**: 쉬움 | **효과**: 보통 | **위험도**: 🟢 낮음 | **범위**: 2파일
- **상태**: ✅ 완료

### 개념

서버가 JSON 응답을 gzip 압축해서 전송. 브라우저가 자동으로 해제. 전송량 60~90% 감소.

### 패키지

`compression` — Express 미들웨어 (NestJS Express 어댑터에서 바로 사용)

### 적용 방법

```typescript
// main.ts
import compression from 'compression';
app.use(compression());
```

### 서버 부하

| 항목 | 수치 |
|------|------|
| CPU 오버헤드 | +1~3% (일반 JSON 응답) |
| 현재 서버 | OCI A1 4 OCPU, 24GB RAM |
| 판단 | **전혀 문제 없음** |

### ⚠️ 주의 사항

- **SSE(Server-Sent Events)**: 스트리밍 응답에 compression 적용 시 버퍼링 문제 가능 → 현재 SSE 미사용이므로 해당 없음
- **이미 압축된 데이터**: 이미지, 파일 다운로드 등은 효과 없음 → file-share의 파일 다운로드는 `application/octet-stream`이라 compression이 자동 스킵
- **WebSocket**: compression 미들웨어는 HTTP만 적용. Socket.IO는 자체 `perMessageDeflate` 옵션 있음 (별도 설정)
- **threshold**: 기본 1KB 미만 응답은 압축하지 않음 (오버헤드가 더 큼)

### 실행 체크리스트
```
[✓] compression 패키지 설치 (pnpm add compression @types/compression)
[✓] main.ts에 app.use(compression()) 추가 (helmet() 뒤)
[✓] 파일 다운로드 응답이 정상인지 확인
[✓] 응답 헤더에 Content-Encoding: gzip 확인
[✓] tsc --noEmit + 앱 시작 확인
```

---

## D10. 메트릭 수집 (Prometheus + Grafana)

- **난이도**: 보통 | **효과**: 높음 | **위험도**: 🟢 낮음 | **범위**: 3파일 + Docker 설정
- **상태**: 추후 적용 예정

### 개념

서버에서 측정값(응답 시간, 에러 수 등)을 수집 → Prometheus가 저장 → Grafana가 시각화

### 구성

```
[NestJS + prom-client]  →  /metrics 엔드포인트 노출
        ↓ (15초마다 수집)
[Prometheus 컨테이너]   →  시계열 DB에 저장
        ↓
[Grafana 컨테이너]      →  대시보드 시각화 + 알림
```

### 패키지 및 도구

| 도구 | 역할 | 설치 위치 |
|------|------|----------|
| `prom-client` | Node.js 메트릭 라이브러리 | NestJS 앱 (npm) |
| `@willsoto/nestjs-prometheus` | NestJS 통합 모듈 | NestJS 앱 (npm) |
| Prometheus | 메트릭 수집·저장 서버 | Docker 컨테이너 |
| Grafana | 대시보드 시각화 | Docker 컨테이너 |
| **node_exporter** | **노드(OS) 메트릭 — CPU/RAM/디스크/네트워크** | **Docker 컨테이너 (Swarm global mode, 모든 노드)** |

### 수집할 메트릭

**1) prom-client (NestJS 앱 자동)**

| 메트릭 | 타입 | 용도 |
|--------|------|------|
| `http_request_duration_seconds` | Histogram | API 응답 시간 분포 (p50/p95/p99) |
| `http_requests_total` | Counter | 총 요청 수 (method, status, route별) |
| `nodejs_heap_used_bytes` | Gauge | Node.js 힙 메모리 |
| `nodejs_eventloop_lag_seconds` | Gauge | 이벤트루프 지연 |
| `process_cpu_seconds_total` | Counter | 프로세스 CPU 사용 |

**2) node_exporter (노드 OS 자동)**

| 카테고리 | 대표 메트릭 | 용도 |
|---------|-----------|------|
| CPU | `node_cpu_seconds_total`, `node_load1/5/15` | 코어별 CPU, load average |
| 메모리 | `node_memory_MemAvailable_bytes`, `node_memory_MemTotal_bytes` | 가용/사용 메모리 |
| 디스크 | `node_filesystem_avail_bytes`, `node_disk_io_time_seconds_total` | 파티션 사용량, I/O |
| 네트워크 | `node_network_receive_bytes_total`, `node_network_transmit_bytes_total` | RX/TX |
| 파일시스템 | `node_filesystem_files_free` | inode 사용률 |

**3) 커스텀 메트릭 (Socket.IO + Redis + 팀 비즈니스)**

| 메트릭 | 타입 | 용도 | 구현 위치 |
|--------|------|------|----------|
| `ws_connections_active` | Gauge | WebSocket 접속자 수 | TeamGateway connect/disconnect |
| `ws_team_online_users` | Gauge (labels: `team_id`) | **팀별 현재 접속자 수** | OnlineUserService.getOnlineUsersCount() 주기적 갱신 |
| `ws_events_total` | Counter (labels: `event`) | WS 이벤트 발생 수 (taskCreated, commentCreated 등) | 각 gateway handler |
| `ws_event_duration_seconds` | Histogram (labels: `event`) | WS 이벤트 처리 시간 | gateway handler |
| `redis_connection_status` | Gauge | Redis 연결 상태 (0/1) | RedisIoAdapter |
| `redis_pubsub_messages_total` | Counter | Pub/Sub 메시지 수 | RedisIoAdapter (선택) |

### 서버 부하

| 항목 | 수치 |
|------|------|
| prom-client CPU | 거의 0 (메트릭 기록은 원자적 카운터 연산) |
| /metrics 엔드포인트 | 호출당 ~5ms (15초 간격이므로 무시 가능) |
| Prometheus 컨테이너 | CPU ~0.5%, RAM ~200MB, 디스크 ~200MB/월 (7일 보관) |
| Grafana 컨테이너 | CPU ~0.5%, RAM ~150MB (대시보드 열 때만) |
| **node_exporter (노드당)** | **CPU ~0%, RAM ~10MB** |
| **모니터링 스택 합계** | **RAM ~360MB, CPU ~1%** |
| **현재 서버 (4 OCPU, 24GB RAM)** | **전혀 문제 없음** |

### ⚠️ 주의 사항

- **/metrics 엔드포인트 보안**: 외부에서 접근 불가하도록 설정 필요 (내부 네트워크만 허용하거나 IP 제한)
- **Prometheus 저장소**: 기본 15일 보관 → **7일로 축소 권장** (`--storage.tsdb.retention.time=7d`). 자동 삭제됨
- **Grafana 초기 설정**: 대시보드 JSON export/import로 관리 (Infrastructure as Code)
- **커스텀 메트릭**: ws_connections_active 등은 Gateway에서 직접 카운터 증감 필요
- **Docker Swarm 연동**: Prometheus가 각 레플리카의 /metrics를 개별 수집해야 함 → Swarm DNS(`tasks.<service>`) 기반 service discovery 설정
- **node_exporter 배포 모드**: Swarm `global` mode로 등록 → 모든 노드에 자동 1개씩 배포됨 (레플리카 수와 무관)
- **팀별 접속자 Gauge 갱신 전략**: OnlineUserService는 Redis 조회 → 매 요청마다 호출하면 부하. **주기적 갱신(30s~1m) 또는 joinTeam/leaveTeam 이벤트 시점 갱신** 권장

### 구현 단계

```
Step 1: NestJS 앱에 prom-client 적용 (30분)
  - @willsoto/nestjs-prometheus 설치
  - PrometheusModule.register() 추가
  - /metrics 엔드포인트 자동 생성
  - 기본 메트릭 (HTTP 요청, Node.js 런타임) 자동 수집

Step 2: Prometheus + node_exporter Docker 서비스 추가
  - Prometheus: infra/docker-stack.yml (또는 별도 monitoring stack)
  - prometheus.yml 설정 (scrape target: NestJS /metrics + node_exporter)
  - node_exporter: Swarm global mode (모든 노드에 자동 배포)
  - 데이터 볼륨 마운트 (prometheus-data)
  - retention 7일 설정

Step 3: Grafana Docker 서비스 추가
  - infra/docker-stack.yml에 grafana 추가
  - Prometheus 데이터소스 연결
  - Node.js 대시보드 import (Grafana ID: 11159)
  - Node Exporter 대시보드 import (Grafana ID: 1860)
  - 커스텀 대시보드 구성 (WS 접속자, 팀별 접속자, Redis 상태)

Step 4: 커스텀 메트릭 추가
  - ws_connections_active (TeamGateway)
  - ws_team_online_users (OnlineUserService 주기 갱신, 팀별)
  - ws_events_total / ws_event_duration_seconds (각 gateway handler)
  - redis_connection_status (RedisIoAdapter)
  - (선택) 비즈니스 메트릭: 팀 생성 수, 태스크 완료율 등
```

### 실행 체크리스트
```
Step 1 — NestJS 앱:
  [ ] prom-client, @willsoto/nestjs-prometheus 설치
  [ ] PrometheusModule 등록 (app.module.ts)
  [ ] /metrics 엔드포인트 접근 확인
  [ ] 기본 메트릭 (HTTP, Node.js) 수집 확인
  [ ] /metrics 보안 설정 (IP 제한 또는 Guard)

Step 2 — Prometheus + node_exporter:
  [ ] infra/prometheus/prometheus.yml 작성 (scrape config)
  [ ] docker-stack.yml에 prometheus 서비스 추가 (retention 7일, volume)
  [ ] docker-stack.yml에 node_exporter 서비스 추가 (mode: global)
  [ ] Swarm DNS(tasks.<service>) 기반 service discovery 확인
  [ ] Prometheus UI 접근 확인 (http://localhost:9090/targets → 모든 타겟 UP)
  [ ] NestJS 레플리카 2개 + node_exporter (노드당 1개) 메트릭 수집 확인

Step 3 — Grafana:
  [ ] docker-stack.yml에 grafana 서비스 추가 (volume)
  [ ] Grafana 접근 보안 설정 (포트 제한 또는 SSH 터널)
  [ ] Prometheus 데이터소스 연결
  [ ] Node.js 기본 대시보드 import (ID: 11159)
  [ ] Node Exporter 대시보드 import (ID: 1860)
  [ ] 커스텀 대시보드: 팀별 접속자, WS 이벤트, Redis 상태

Step 4 — 커스텀 메트릭:
  [ ] ws_connections_active (TeamGateway 연결/해제 시 증감)
  [ ] ws_team_online_users (OnlineUserService 주기 갱신, 팀별 labels)
  [ ] ws_events_total / ws_event_duration_seconds (gateway handlers)
  [ ] redis_connection_status (RedisIoAdapter)
  [ ] (선택) 비즈니스 메트릭
```

---

## D14. ResponseInterceptor (응답 포맷 자동화) — ⏸ 보류

- **난이도**: 보통 | **효과**: 매우 높음 | **위험도**: 🟡 중간 | **범위**: 9파일 (7 Controller + Interceptor + AppModule)
- **상태**: ⏸ **보류** — API별 code/message/action 커스텀 예정으로 인터셉터 방식 불적합. 추후 헬퍼 함수 또는 API별 직접 반환 방식으로 대체 검토
- **선행**: 없음

### 현재 문제

31개 엔드포인트에서 동일한 응답 포맷을 수동으로 반복:

```typescript
// 모든 컨트롤러에서 이렇게 반복 (31곳)
return {
  code: 'SUCCESS',
  data: { ... },
  message: '',
};
```

### 개선 후

```typescript
// Interceptor가 자동으로 { code, data, message } 감싸줌
// 컨트롤러는 data만 반환
return { userId, userName, loginType, accessToken };
```

### 구현 방법

```typescript
// src/common/interceptors/response.interceptor.ts
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => ({
        code: 'SUCCESS',
        data: data ?? null,
        message: '',
      })),
    );
  }
}
```

AppModule에 `APP_INTERCEPTOR`로 등록 후, 31개 엔드포인트에서 `{ code, data, message }` 래핑 제거.

### ⚠️ 주의 사항

- **프론트 영향 없음**: 응답 구조 `{ code, data, message }` 동일 유지
- **예외 응답**: HttpExceptionFilter가 처리하는 에러 응답은 Interceptor를 타지 않음 → 충돌 없음
- **Health Check**: `@nestjs/terminus`의 `HealthCheckResult`를 그대로 반환해야 함. NestJS에 `@SkipInterceptor()` 내장 없음 → 커스텀 데코레이터 + `Reflector` 메타데이터 방식으로 직접 구현 필요. health.controller.ts는 `{ code, data, message }` 형식을 사용하지 않음
- **파일 스트리밍**: `file-share.controller.ts`의 `downloadFile()` 엔드포인트는 `@Res()`로 파일 스트림을 직접 전송 → Interceptor 자동 우회 (NestJS 정책)
- **telegram.controller.ts**: `{ success, message }` 형식으로 별도 응답 구조 사용 중 — `{ code, data, message }` 형식 아님. Interceptor 적용 시 응답 구조 통일 여부 결정 필요
- **Swagger 응답 DTO 리팩토링 필요**: 현재 모든 응답 DTO가 `ApiSuccessResponseDto`(`{ code, data, message }`)를 extends. Interceptor 도입 후 컨트롤러는 `data`만 반환하므로, Swagger DTO도 `data` 부분만 정의하도록 변경 필요. 미변경 시 Swagger 문서와 실제 응답 구조 불일치
- **점진적 적용 권장**: 한 번에 31곳 변경보다, 모듈 단위로 순차 적용 (Main → Auth → Team)

### 영향받는 파일 (전수 확인)

| Controller | 엔드포인트 수 | `{ code, data, message }` 수동 반환 수 |
|-----------|:---:|:---:|
| `team.controller.ts` | 24 | 24 |
| `auth.controller.ts` | 1 | 1 |
| `users.controller.ts` | 2 | 2 |
| `auth/users.controller.ts` | 1 | 1 |
| `file-share.controller.ts` | 2 | 2 (+ `downloadFile()`은 @Res() 파일 스트리밍으로 별도) |
| `main.controller.ts` | 1 | 1 |
| `telegram.controller.ts` | 1 | 0 (`{ success, message }` 별도 형식) |
| `health.controller.ts` | 1 | 0 (`HealthCheckResult` 형식) |

### 실행 체크리스트
```
[ ] src/common/interceptors/response.interceptor.ts 생성
[ ] AppModule에 APP_INTERCEPTOR 등록
[ ] @SkipResponseInterceptor() 커스텀 데코레이터 생성 (SetMetadata + Reflector)
[ ] Health Check에 @SkipResponseInterceptor() 적용
[ ] 파일 스트리밍 (@Res()) 엔드포인트 자동 우회 확인
[ ] 모듈 단위 순차 적용: Main → Auth → Users → Team → FileShare
[ ] 각 컨트롤러에서 { code, data, message } 래핑 제거 → data만 반환 (31곳)
[ ] telegram.controller.ts 응답 구조 통일 여부 결정 ({ success, message } → { code, data, message })
[ ] Swagger 응답 DTO 리팩토링 — ApiSuccessResponseDto extends 제거, data 타입만 정의
[ ] 프론트에서 응답 구조 동일한지 확인
[ ] tsc --noEmit + 앱 시작 확인
```

---

## D15. @CurrentUser 커스텀 데코레이터

- **난이도**: 쉬움 | **효과**: 높음 | **위험도**: 🟢 낮음 | **범위**: 5파일 (데코레이터 1 + Controller 4)
- **선행**: 없음

### 현재 문제

`@Req() req` 후 `req.user` 직접 접근이 **27곳** 반복:

```typescript
// 현재 — 모든 인증 엔드포인트에서 반복
@UseGuards(JwtAuthGuard)
async getMyTeams(@Req() req: Request & { user: User }) {
  const user = req.user;  // ← 매번 이 코드
  // ...
}
```

### 개선 후

```typescript
@UseGuards(JwtAuthGuard)
async getMyTeams(@CurrentUser() user: User) {
  // user를 바로 사용
}
```

### 구현 방법

```typescript
// src/common/decorators/current-user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '../../entities/User';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
```

### 영향받는 파일 (전수 확인)

| 파일 | `req.user` 사용 수 | 변경 |
|------|:---:|------|
| `team.controller.ts` | 24곳 | `@Req() req` → `@CurrentUser() user: User` |
| `users.controller.ts` | 2곳 | 동일 |
| `auth/users.controller.ts` | 1곳 | 동일 |
| `team.controller.ts:570` | 1곳 | `req.user?.userId` (OptionalJwtAuth) → 별도 처리 필요 |

### ⚠️ 주의 사항

- **OptionalJwtAuthGuard 사용 엔드포인트**: `team.controller.ts:570`에서 `req.user?.userId || null` 패턴 → `@CurrentUser()` 반환이 `undefined`일 수 있음. `User | undefined` 타입 처리 필요
- **D14 보류됨**: D14(ResponseInterceptor) 보류로 D15는 독립 진행 가능
- **타입 어노테이션 불일치**: 현재 team.controller.ts는 `Request & { user: User }` (인라인), users.controller.ts는 `type RequestWithUser` (type alias) 사용. @CurrentUser 적용 시 두 패턴 모두 제거되므로 자연스럽게 통일됨
- **`@Req()` import 제거**: 교체 후 미사용 `@Req()` import 정리 필요

### 실행 체크리스트
```
[✓] src/common/decorators/current-user.decorator.ts 생성
[✓] team.controller.ts: @Req() req → @CurrentUser() user (23곳 + Optional 1곳)
[✓] users.controller.ts: 동일 (2곳) + RequestWithUser 타입 제거
[✓] auth/users.controller.ts: 동일 (1곳)
[✓] OptionalJwtAuth 엔드포인트: @CurrentUser() user: User | undefined
[✓] 미사용 @Req(), Request import 정리
[✓] tsc --noEmit + pnpm lint 통과 확인
```

---

## D16. 하드코딩 상수화

- **난이도**: 쉬움 | **효과**: 보통 | **위험도**: 🟢 낮음 | **범위**: 6~7파일
- **선행**: 없음

### 변경 대상 (전수 확인 — 코드 검증 완료)

**기존 식별 (6곳):**

| 파일:줄 | 현재 코드 | 상수화 |
|---------|----------|--------|
| `main.ts:130` | `30_000` (shutdown 타임아웃) | `GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000` |
| `app.module.ts:100-101` | `ttl: 1000, limit: 5` / `ttl: 60000, limit: 60` | Config 또는 상수 파일 |
| `auth.controller.ts:14` | `ttl: 1000, limit: 2` / `ttl: 60000, limit: 10` | 동일 상수 파일 |
| `team.service.ts:1027` | `7 * 24 * 60 * 60 * 1000` (초대 7일) | `INVITE_MAX_EXPIRATION_MS` |
| `team.dto.ts:154` | `7 * 24 * 60 * 60 * 1000` (Swagger 예시) | 동일 상수 |
| `auth.service.ts:49` | `https://kapi.kakao.com/v1/user/access_token_info` | `KAKAO_TOKEN_INFO_API` (Config 또는 상수) |

**추가 식별 (코드 검증으로 발견):**

| 파일:줄 | 현재 코드 | 상수화 |
|---------|----------|--------|
| `team.service.ts:1047` | `expiresIn: 8 * 24 * 60 * 60` (초대 토큰 JWT 8일) | `INVITE_TOKEN_EXPIRY_SECONDS` |
| `logger.module.ts:125` | `limit: { count: 7 }` (로그 로테이션 7일) | `LOG_ROTATION_COUNT` |

### 구현 방법

```typescript
// src/common/constants/app.constants.ts
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;
export const INVITE_MAX_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000; // 7일

// src/common/constants/throttle.constants.ts
export const THROTTLE_SHORT = { ttl: 1000, limit: 5 };
export const THROTTLE_LONG = { ttl: 60000, limit: 60 };
export const THROTTLE_AUTH = { short: { ttl: 1000, limit: 2 }, long: { ttl: 60000, limit: 10 } };

// src/common/constants/external-api.constants.ts
export const KAKAO_TOKEN_INFO_API = 'https://kapi.kakao.com/v1/user/access_token_info';

// src/common/constants/app.constants.ts (추가)
export const INVITE_TOKEN_EXPIRY_SECONDS = 8 * 24 * 60 * 60; // 8일
export const LOG_ROTATION_COUNT = 7;
```

### 실행 체크리스트
```
[✓] src/common/constants/app.constants.ts 생성
[✓] src/common/constants/throttle.constants.ts 생성
[✓] src/common/constants/external-api.constants.ts 생성
[✓] main.ts: 30_000 → GRACEFUL_SHUTDOWN_TIMEOUT_MS
[✓] app.module.ts: throttle 값 → 상수 참조
[✓] auth.controller.ts: throttle 값 → 상수 참조
[✓] team.service.ts:1027 7일 → INVITE_MAX_EXPIRATION_MS
[✓] team.service.ts:1047 8일 JWT → INVITE_TOKEN_EXPIRY_SECONDS
[✓] auth.service.ts: Kakao URL → 상수 참조
[✓] logger.module.ts:125 로그 로테이션 count → LOG_ROTATION_COUNT
[✓] tsc --noEmit 통과 확인
```

---

## D17. as any 타입 개선

- **난이도**: 쉬움 | **효과**: 보통 | **위험도**: 🟢 낮음 | **범위**: 5파일
- **선행**: 없음

### 개선 가능한 곳 (전수 확인, eslint-disable 포함 — 6곳)

| 파일:줄 | 현재 | 개선 방법 |
|---------|------|----------|
| `jwt-auth.guard.ts:54` | `(request as any)?.cookies` | `type RequestWithCookies = Request & { cookies?: Record<string, string> }` 정의 후 사용 |
| `api-error.dto.ts:15` | `(this as any).code = code` | 생성자에서 `super({ code, message }, status)` 객체 전달 방식으로 변경 |
| `http-exception.filter.ts:61` | `(exceptionResponse as any).message` | `type ErrorResponse = { message?: string; code?: string }` 타입가드 추가 |
| `ws-exception.filter.ts:58,60` | `(error as any).code/message` | `type WsError = { code?: string; message?: string }` 타입가드 추가 |
| `auth.service.ts:82` | `{ kakaoId?: any; isActivated?: any }` | `FindOptionsWhere<User>` 또는 `Partial<Pick<User, 'kakaoId' \| 'isActivated'>>` |
| `main.ts:82` | `(req: any, res: any, next: any)` | Express `Request`, `Response`, `NextFunction` 타입 사용 |

### 개선 불가 (유지)

| 파일:줄 | 이유 |
|---------|------|
| `app.module.ts:7` | `globalThis.crypto` polyfill — Node.js 타입 정의 한계 |
| `file-share.controller.ts:42` | `catch (error: any)` — fs 에러 타입 다양 |
| `scheduler.service.ts:50,71,104` | `catch (err: any)` — 동일 |

### 실행 체크리스트
```
[✓] jwt-auth.guard.ts: (request as any)?.cookies → request.cookies (@types/cookie-parser 활용)
[✓] api-error.dto.ts: abstract readonly code → readonly code, this.code = code 직접 할당
[✓] http-exception.filter.ts: (exceptionResponse as any) → HttpExceptionBody 인터페이스
[✓] ws-exception.filter.ts: (error as any) → WsErrorObject 인터페이스
[✓] auth.service.ts: { kakaoId?: any } → FindOptionsWhere<User>
[✓] main.ts:82: (req: any, res: any, next: any) → Express Request/Response/NextFunction
[✓] eslint-disable 주석 6곳 제거
[✓] tsc --noEmit + pnpm lint 통과 확인
```

---

## D18. PaginationDto 공통화 (추후)

- **난이도**: 쉬움 | **효과**: 보통 | **위험도**: 🟢 낮음 | **범위**: 2파일
- **상태**: 추후 — 목록 API 확장 시 적용
- **참고**: mobisell-back에서 `PaginationQueryDto` + `PaginationMeta` 패턴 운영 중

### 구현 방법

```typescript
// src/common/dto/pagination.dto.ts
export class PaginationQueryDto {
  @IsOptional()
  @IsNumberString()
  page?: number = 1;

  @IsOptional()
  @IsNumberString()
  perPage?: number = 20;
}

export class PaginationMeta {
  total: number;
  page: number;
  perPage: number;
  lastPage: number;
}
```

현재 페이지네이션 사용처: 없음. `notification.dto.ts:59`의 `offset`은 Telegram 메시지 엔티티의 시작 오프셋(텍스트 내 위치)이며 페이지네이션과 무관. 목록 API가 늘어나면 적용.

### 실행 체크리스트
```
[ ] src/common/dto/pagination.dto.ts 생성
[ ] 기존 목록 API에 PaginationQueryDto 적용
[ ] 응답에 PaginationMeta 포함
```

---

## D19. 파일 다운로드 StreamableFile 전환 (Express @Res 제거)

- **난이도**: 보통 | **효과**: 높음 | **위험도**: 🟡 중간 | **범위**: 1파일
- **선행**: 없음

### 현재 문제

`file-share.controller.ts`의 `downloadFile()` 메서드가 Express `@Res()` + `pipe(res)` 패턴으로 파일 스트리밍:

```typescript
// 현재 — Express 레거시 패턴
async downloadFile(
  @Param('filename') filename: string,
  @Res() res: Response,                          // ← Express Response 직접 사용
  ...
) {
  res.setHeader('Content-Type', 'application/octet-stream');     // ← 수동 헤더
  res.setHeader('Content-Disposition', `attachment; ...`);       // ← 수동 헤더
  res.setHeader('Content-Length', stats.size.toString());        // ← 수동 헤더
  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);                                          // ← Express 파이핑

  fileStream.on('error', error => {
    if (!res.headersSent) {
      res.status(500).json({...});                               // ← 수동 에러 응답
    }
  });
}
```

**문제점:**
- `@Res()` 사용 시 NestJS 응답 체인(Interceptor, ExceptionFilter) 완전 우회
- Express `Response` 타입에 직접 의존
- 에러 응답 형식이 `HttpExceptionFilter`와 불일치 (`timestamp` 포함, `data` 필드 없음)

### 개선 후

```typescript
import { StreamableFile, Header } from '@nestjs/common';

async downloadFile(
  @Param('filename') filename: string,
  ...
): Promise<StreamableFile> {
  // ... 인증/검증 로직 동일 ...

  const fileStream = fs.createReadStream(filePath);
  return new StreamableFile(fileStream, {
    type: 'application/octet-stream',
    disposition: `attachment; filename="${encodeURIComponent(filename)}"`,
    length: stats.size,
  });
}
```

**장점:**
- NestJS가 헤더 설정 + 스트리밍 + 에러 처리 자동 관리
- Interceptor/Filter 체인 정상 동작
- Express `Response` import 제거 가능

### ⚠️ 주의 사항

- **스트림 에러 처리**: `StreamableFile`은 내부적으로 스트림 에러 발생 시 NestJS가 처리. 기존 `fileStream.on('error')` 수동 핸들러 제거 가능하나, 로깅이 필요하면 별도 처리 검토
- **Content-Length**: `StreamableFile` 옵션의 `length`로 전달. 누락 시 chunked transfer 사용됨
- **프론트 영향**: 응답 헤더/본문 동일 → 프론트 변경 없음
- **에러 응답 형식 통일**: 기존 `res.status(500).json(...)` 제거 후 `HttpExceptionFilter`가 에러 처리 → 에러 응답 형식이 다른 API와 통일됨

### 실행 체크리스트
```
[ ] file-share.controller.ts: import StreamableFile from @nestjs/common
[ ] downloadFile(): @Res() res 파라미터 제거
[ ] res.setHeader() 3줄 → StreamableFile 옵션으로 이동
[ ] fileStream.pipe(res) → return new StreamableFile(fileStream, {...})
[ ] fileStream.on('error') 수동 핸들러 제거 (NestJS가 처리)
[ ] import { Response } from 'express' 제거
[ ] import { Res } from '@nestjs/common' 제거
[ ] tsc --noEmit + 앱 시작 확인
[ ] 파일 다운로드 정상 동작 확인 (Content-Disposition, Content-Length 헤더)
```

---

## D20. Swagger 리다이렉트 NestMiddleware 전환

- **난이도**: 쉬움 | **효과**: 보통 | **위험도**: 🟢 낮음 | **범위**: 2파일
- **선행**: 없음

### 현재 문제

`main.ts`에 Express 인라인 미들웨어로 Swagger 리다이렉트 등록:

```typescript
// main.ts:83-89 — Express 콜백 패턴
app.use((req: Request, res: Response, next: NextFunction) => {
  const originalUrl: string = req?.originalUrl ?? '';
  if (originalUrl === '/api/v1/docs/' || originalUrl.startsWith('/api/v1/docs/?')) {
    return res.redirect(originalUrl.replace('/api/v1/docs/', '/api/v1/docs'));
  }
  return next();
});
```

**문제점:**
- `main.ts`에 비즈니스 로직 혼재 (부트스트랩 파일은 설정만 담당해야 함)
- Express `Request`, `Response`, `NextFunction` 타입에 직접 의존
- 미들웨어가 NestJS DI 시스템 밖에 존재

### 개선 후

```typescript
// src/common/middleware/swagger-redirect.middleware.ts
@Injectable()
export class SwaggerRedirectMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const originalUrl = req?.originalUrl ?? '';
    if (originalUrl === '/api/v1/docs/' || originalUrl.startsWith('/api/v1/docs/?')) {
      return res.redirect(originalUrl.replace('/api/v1/docs/', '/api/v1/docs'));
    }
    next();
  }
}

// app.module.ts
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SwaggerRedirectMiddleware).forRoutes('*');
  }
}
```

### ⚠️ 주의 사항

- **Express 타입 import는 유지**: NestJS의 `NestMiddleware` 인터페이스가 Express 타입을 사용 — 이것은 NestJS 공식 패턴이므로 정상
- **LOCAL 전용 여부**: Swagger는 LOCAL 환경에서만 활성화됨. 리다이렉트 미들웨어도 LOCAL에서만 등록할지 검토 (현재는 전 환경 등록)
- **main.ts에서 Express 타입 import 제거 가능**: D19 완료 후 main.ts에서 `import { Request, Response, NextFunction } from 'express'` 제거 가능 (D17에서 추가한 것)
- **프론트 영향 없음**: Swagger 문서 경로만 관련

### 실행 체크리스트
```
[ ] src/common/middleware/swagger-redirect.middleware.ts 생성
[ ] app.module.ts: NestModule implements + configure() 추가
[ ] main.ts:83-89 인라인 미들웨어 제거
[ ] main.ts에서 Express 타입 import 제거 가능 여부 확인 (D19 완료 후)
[ ] tsc --noEmit + 앱 시작 확인
[ ] /api/v1/docs/ → /api/v1/docs 리다이렉트 정상 확인
```

---

## D21. 파일 다운로드 에러 응답 형식 통일

- **난이도**: 쉬움 | **효과**: 보통 | **위험도**: 🟢 낮음 | **범위**: D19에 포함
- **선행**: D19 (StreamableFile 전환)

### 현재 문제

`file-share.controller.ts:200`의 수동 에러 응답이 `HttpExceptionFilter`와 다른 형식:

```typescript
// 현재 — file-share.controller.ts (스트림 에러 시)
res.status(500).json({
  code: 'INTERNAL_SERVER_ERROR',
  message: '파일 전송 중 오류가 발생했습니다.',
  timestamp: new Date().toISOString(),     // ← 다른 API에는 없는 필드
  // data 필드 없음                         // ← 다른 API 에러에는 data 필드 있을 수 있음
});
```

### 개선

D19에서 `StreamableFile` 전환 시 이 수동 에러 핸들러가 제거됨 → NestJS가 스트림 에러를 `HttpExceptionFilter`로 라우팅 → 에러 형식 자동 통일

**별도 작업 불필요 — D19 완료 시 자동 해결됨.**

### 실행 체크리스트
```
[ ] D19 완료 후 자동 해결 확인
[ ] 파일 스트리밍 에러 시 HttpExceptionFilter 응답 형식 확인
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

Phase 5 — 작업 목록 (완료 10 + 미완료 10 + 보류 2)
  [ ] D2  테스트 인프라 구축 (패키지, Factory, Helper)
  [✓] D3  Port/Adapter — NotificationPort 완료
  [✓] D7  매직 문자열 enum화 — MANAGEMENT_ROLES 교체 + LoginType 타입 적용
  [✓] D11 ESLint 설정 — Flat Config + Prettier + 경고 0건 달성
  [✓] D9  응답 압축 — compression 미들웨어 적용 완료
  [✓] D12 Express 흔적 제거 — express-async-errors, swagger-jsdoc, data-source.ts 삭제
  [✓] D13 NestJS 비정석 수정 — process.env→ConfigService, WsExceptionFilter DI 전환
  [ ] D5  단위 테스트 (Service 10 + Controller 9 + Guard/Filter 6 + Gateway 8)
  [ ] D1  TeamService 분리 (1520줄 → 3~4 서비스)
  [ ] D6  E2E 테스트 (Mock Repository, HTTP 7플로우 + WS 2플로우)
  [ ] D4  typeorm-transactional (Oracle 호환성 확인 필요)
  [✓] D8  API Rate Limiting — 2단계 글로벌(초당5/분당60) + 로그인 엄격 + SkipThrottle 3곳
  [ ] D10 메트릭 수집 (추후 — Prometheus + Grafana + node_exporter + prom-client, 팀별 접속자 등 커스텀 메트릭 포함)
  [⏸] D14 ResponseInterceptor — 보류 (API별 code/message/action 커스텀 예정 → 인터셉터 불적합)
  [✓] D15 @CurrentUser 데코레이터 — 27곳 @Req() req.user → @CurrentUser() user 전환
  [✓] D16 하드코딩 상수화 — 8곳 → 상수 파일 3개 (app, throttle, external-api)
  [✓] D17 as any 타입 개선 — 6곳 → 적절한 타입 적용, eslint-disable 제거
  [ ] D18 PaginationDto 공통화 (추후 — 목록 API 확장 시)
  [ ] D19 파일 다운로드 StreamableFile 전환 (Express @Res 제거)
  [ ] D20 Swagger 리다이렉트 NestMiddleware 전환
  [ ] D21 파일 다운로드 에러 응답 통일 (D19 완료 시 자동 해결)
  [⏸] B3  Redis Custom Provider (보류)
```

---

## 프론트엔드 영향

대부분의 Phase 5 작업은 프론트엔드 수정 불필요. 예외:
- **D8 Rate Limiting**: 프론트에서 429 응답 처리 추가 필요 (FetchService.ts + SessionProvider.tsx, 각 4줄). 배포 순서 무관.
- ~~**D14 ResponseInterceptor**~~: 보류됨 (API별 code/message/action 커스텀 예정)

---

## 위험도 요약

| 작업 | 위험도 | 핵심 이유 |
|------|:---:|----------|
| D2 테스트 인프라 | 🟢 낮음 | 설정/유틸 추가만, 프로덕션 무변경 |
| D3 Port/Adapter | 🟢 낮음 | 주입처 1곳(TeamService). @Global() 유지 |
| D5 단위 테스트 | 🟢 낮음 | 테스트 코드 추가만 |
| D1 TeamService 분리 | 🟡 중간 | 1520줄 분리, 호출 체인 전수 확인 필요 |
| D6 E2E 테스트 | 🟡 중간 | 인메모리 DB 불가 + 상용 DB 공유 → Mock 전용 |
| D4 typeorm-transactional | 🟡 중간 | Oracle 호환성 미확인 + 테스트 DB 없음 |
| D11 ESLint | 🟢 낮음 | 설정 추가만, 프로덕션 무변경. 초기 경고 대량 발생 가능 (점진적 해결) |
| D12 Express 흔적 제거 | 🟢 낮음 | 미사용 패키지/파일 제거. 사전 grep 필수 |
| D13 NestJS 비정석 패턴 | 🟢 낮음 | process.env→ConfigService, WsExceptionFilter DI 전환 |
| D8 Rate Limiting | 🟢 낮음 | 추가만, IP/userId 기반 선택 필요. X-Forwarded-For 처리 주의 |
| D9 응답 압축 | 🟢 낮음 | 1줄 추가, CPU +1~3% (OCI 4 OCPU에서 무시 가능) |
| D10 메트릭 수집 | 🟢 낮음 | /metrics 보안 설정 필수. Docker 컨테이너 3개 추가 (Prometheus + Grafana + node_exporter global). RAM ~360MB |
| D14 ResponseInterceptor | ⏸ 보류 | API별 code/message/action 커스텀 예정 → 인터셉터 불적합 |
| D15 @CurrentUser | 🟢 낮음 | 데코레이터 추가 + 27곳 시그니처 교체. 로직 무변경 |
| D16 하드코딩 상수화 | 🟢 낮음 | 상수 파일 추가 + 8곳 참조 교체. 값 무변경 |
| D17 as any 타입 개선 | 🟢 낮음 | 타입 정의 추가 (6곳). 런타임 무변경 |
| D18 PaginationDto | 🟢 낮음 | 공통 DTO 추가. 추후 목록 API 확장 시 |
| D19 StreamableFile 전환 | 🟡 중간 | Express @Res() 제거. 스트림 에러 처리 방식 변경 |
| D20 Swagger NestMiddleware | 🟢 낮음 | 인라인 미들웨어 → 클래스. main.ts 단순화 |
| D21 에러 응답 통일 | 🟢 낮음 | D19 완료 시 자동 해결 |
| B3 Redis Provider | 🔴 높음 | 초기화 타이밍 불확실 → **보류** |

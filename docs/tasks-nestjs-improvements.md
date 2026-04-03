# NestJS 고도화 전략 — FiveSouth (bun)

> 작성일: 2026-04-03  
> 브랜치: `feat-onam`  
> 목표: 안정성 + 구조적 업그레이드  
> 참고 프로젝트: `mobisell-back` (Pino, Port/Adapter, 테스트 Factory 등)

---

## 완료된 작업 (Phase 1)

### A2. 환경변수 스키마 검증 추가
- **상태**: 완료
- **변경**: `src/config/env.validation.ts` (신규), `src/app.module.ts`
- **내용**: ConfigModule `validate` 옵션으로 필수 환경변수(DB, JWT) 누락 시 앱 시작 차단

### B1. console.* → NestJS Logger 통일
- **상태**: 완료
- **변경**: 8개 파일, 30+곳

### B4. 소켓 타입 안전성 강화
- **상태**: 완료
- **변경**: `fishing-ws.guard.ts`, `fishing.gateway.ts` — `(client as any)` 5곳 제거

---

## Phase 2 — NestJS 정석화

### A1. Entity 관계 데코레이터 수정

- **난이도**: 보통 | **효과**: 높음 | **위험도**: 낮음~중간 | **범위**: 5파일

#### 변경 대상 (전수 확인 완료)

| Entity | 현재 | 올바른 관계 | 파일:줄 |
|--------|------|-------------|---------|
| `Team.users` | `@ManyToMany` + `@JoinColumn` | `@ManyToOne(() => User)` | `Team.ts:39-41` |
| `Team.teamMembers` | `@ManyToMany` | `@OneToMany(() => TeamMember, tm => tm.team)` | `Team.ts:44-45` |
| `TaskComment.team` | `@OneToOne` | `@ManyToOne(() => Team)` | `TaskComment.ts:42-44` |
| `TaskComment.user` | `@OneToOne` | `@ManyToOne(() => User)` | `TaskComment.ts:50-52` |
| `TeamMember.team` | `@OneToOne` | `@ManyToOne(() => Team, t => t.teamMembers)` | `TeamMember.ts:25-27` |

#### 필드명 변경 필요

- `Team.users` → `Team.leader` (리더 1명인데 users 복수형은 혼란)
- 단, **프로젝트 전체에서 `team.users` 직접 참조 0곳** → 안전하게 변경 가능
- 타입 변경: `users: User[]` (배열) → `leader: User` (단일)

#### ⚠️ User.ts 역관계 주의

현재 `User.ts:32`:
```typescript
@OneToMany(() => Team, (team) => team.leaderId)
teams: Team[];
```
**문제**: `team.leaderId`는 **컬럼(숫자)**이지 **관계(엔티티)**가 아님.
TypeORM에서 역관계 콜백은 반드시 관계 프로퍼티를 가리켜야 함.

변경 후:
```typescript
@OneToMany(() => Team, (team) => team.leader)  // leaderId → leader
teams: Team[];
```

이 수정을 하지 않으면 `User.teams` relation loading 시 TypeORM이 올바른 FK를 찾지 못함.
(현재 `relations:` 사용 0곳이라 당장 에러는 안 나지만, 정확하지 않은 관계 정의는 향후 버그원.)

#### 영향받는 코드 (전수 확인)

**team.leaderId를 직접 참조하는 코드 (9곳 — 모두 안전):**

| 파일:줄 | 코드 | 변경 후 영향 |
|---------|------|-------------|
| `team.service.ts:142` | `'t.leaderId'` (select) | 안전 — `leaderId` 컬럼은 그대로 |
| `team.service.ts:176` | `tm.team.leaderId` | 안전 — 컬럼 필드 접근 |
| `team.service.ts:226` | `'team.leaderId'` (select) | 안전 — 컬럼 필드 접근 |
| `team.service.ts:264` | `task.team.leaderId` | 안전 — 컬럼 필드 접근 |
| `team.service.ts:308` | `createTeamDto.leaderId` | 안전 — DTO 필드 |
| `team.controller.ts:115` | `createTeamDto.leaderId = user.userId` | 안전 — DTO 필드 |
| `team.controller.ts:147` | `leaderId: team.leaderId` | 안전 — 컬럼 필드 접근 |
| `team.controller.ts:208` | `leaderId: team.leaderId` | 안전 — 컬럼 필드 접근 |

> `leaderId` **컬럼 프로퍼티**(`@Column`)는 그대로 유지. `leader` **관계 프로퍼티**(`@ManyToOne`)가 새로 추가되는 것이므로 기존 코드는 영향 없음.

**QueryBuilder join (4곳 — 모두 호환):**

| 파일:줄 | 코드 | 변경 후 영향 |
|---------|------|-------------|
| `team.service.ts:131` | `.innerJoinAndSelect('ut.team', 't')` | 호환 — QB join은 관계 타입 무관 |
| `team.service.ts:172-178` | `tm.team.teamName` 등 7곳 | 호환 — 필드 접근 동일 |
| `team.service.ts:806` | `.leftJoinAndSelect('comment.user', 'user')` | 호환 |
| `team.service.ts:827` | `comment.user?.userName` | 호환 |

#### 위험 요소

- **`relations: [...]` 옵션 사용 코드**: 0곳 → 안전
- **`find()`/`findOne()` with relations**: 0곳 → 안전
- **DB 스키마 변경**: 불필요 (FK/PK 그대로, TypeORM 데코레이터만 정정)
- **`leaderId` 컬럼 프로퍼티**: `@Column({ name: 'LEADER_ID' })` 그대로 유지 — 기존 9곳 참조에 영향 없음

#### 실행 체크리스트
```
[ ] Team.ts: users → leader (ManyToOne, 타입 User[] → User), teamMembers → OneToMany
[ ] Team.ts: import 정리 (ManyToMany 제거, ManyToOne/OneToMany 추가)
[ ] TeamMember.ts: team → ManyToOne (import OneToOne 제거)
[ ] TaskComment.ts: team, user → ManyToOne (import OneToOne 제거)
[ ] User.ts: teams 역관계 수정 (team.leaderId → team.leader)
[ ] tsc --noEmit 통과 확인
[ ] 앱 시작 후 팀 목록 조회 정상 확인 (getTeamMembersBy)
[ ] 앱 시작 후 태스크 조회 정상 확인 (getTeamTasksBy)
[ ] 앱 시작 후 댓글 조회 정상 확인 (getCommentsByTaskId)
```

---

### B2. 글로벌 Filter/Interceptor/Pipe를 DI 기반으로 전환

- **난이도**: 보통 | **효과**: 보통 | **위험도**: 낮음 | **범위**: 3파일

#### 현재 상태 (main.ts — C1 Pino 적용 후)

| 항목 | 줄 | 현재 방식 | 주입 서비스 |
|------|-----|----------|------------|
| `HttpExceptionFilter` | 37 | `new HttpExceptionFilter()` | 없음 (Logger만 내부 생성) |
| ~~`LoggingInterceptor`~~ | — | C1에서 제거됨 (pino-http 대체) | — |
| `ValidationPipe` | 85 | `new ValidationPipe({...})` | 없음 |

#### 전환 방법

```typescript
// app.module.ts providers에 추가
{
  provide: APP_FILTER,
  useClass: HttpExceptionFilter,
},
{
  provide: APP_INTERCEPTOR,
  useClass: LoggingInterceptor,  // ConfigService 자동 주입됨
},
{
  provide: APP_PIPE,
  useFactory: () => new ValidationPipe({ whitelist: true, transform: true, ... }),
},
```

#### 위험 요소

- **WsExceptionFilter는 건드리지 않음**: Gateway별 `@UseFilters(new WsExceptionFilter())`는 HTTP 필터와 독립. 현 구조 유지
- **APP_INTERCEPTOR의 WebSocket 영향**: 없음 — NestJS 정책상 HTTP만 처리
- **순환 의존성**: LoggingInterceptor는 ConfigService만 의존 → 문제 없음

#### C1 Pino 완료로 인한 변경

LoggingInterceptor는 C1에서 이미 제거됨 → B2에서는 **`APP_FILTER`와 `APP_PIPE`만 전환**하면 됨. Interceptor 관련 작업 불필요.

#### 실행 체크리스트
```
[ ] app.module.ts에 APP_FILTER, APP_PIPE 등록
[ ] main.ts에서 useGlobalFilters, useGlobalPipes 제거
[ ] WsExceptionFilter는 Gateway에서 그대로 유지 확인
[ ] HTTP 에러 응답 포맷 동일 확인 ({ code, message, timestamp })
[ ] WebSocket 이벤트 에러 처리 정상 확인
[ ] ValidationPipe 옵션이 동일한지 확인 (whitelist, transform, forbidNonWhitelisted, enableImplicitConversion)
```

---

### C3. Graceful Shutdown

- **난이도**: 보통 | **효과**: ⚠️ 매우 높음 | **위험도**: 낮음 | **범위**: 3파일

#### 현재 문제 (전수 확인)

| 컴포넌트 | 종료 시 정리 | 현재 상태 | 위험도 |
|---------|------------|----------|--------|
| TypeORM 연결 풀 | `app.close()` 시 자동 | 미호출 | 🔴 |
| Redis pub/sub 연결 | 수동 `quit()` 필요 | disconnect 메서드 없음 | 🔴 |
| WebSocket 클라이언트 | `disconnectSockets()` 필요 | 미처리 (강제 종료 시 고아 키) | 🔴 |
| 스케줄러 Cron | `app.close()` 시 자동 취소 | 미호출 | 🟡 |
| Redis 고아 키 | TTL 1-2시간 후 자동 정리 | 안전장치 있음 | 🟢 |

#### 구현 계획

**1. RedisIoAdapter에 disconnect 추가** (`redis-io.adapter.ts`)
```typescript
async disconnect(): Promise<void> {
  try {
    await Promise.all([this.pubClient.quit(), this.subClient.quit()]);
    this.logger.log('Redis 연결 정리 완료');
  } catch (error) {
    this.logger.error('Redis 연결 정리 실패:', (error as Error).message);
  }
}
```

**2. main.ts에 shutdown handler 추가** (app.listen() 직후)
```typescript
// NestJS 라이프사이클 훅 활성화 (OnModuleDestroy 등)
app.enableShutdownHooks();

// Redis Adapter는 NestJS DI 밖이라 수동 정리 필요
const shutdown = async (signal: string) => {
  logger.log(`${signal} 수신, graceful shutdown 시작...`);
  
  try {
    // 1. Redis 어댑터 연결 정리 (DI 밖이라 수동)
    await redisAdapter.disconnect();
    
    // 2. NestJS app.close()
    //    → TypeORM 연결 풀 자동 정리
    //    → ScheduleModule Cron 자동 취소
    //    → WebSocket Gateway의 OnModuleDestroy 실행
    await app.close();
    
    logger.log('Graceful shutdown 완료');
    process.exit(0);
  } catch (error) {
    logger.error('Graceful shutdown 실패:', error);
    process.exit(1);
  }
};

// 30초 타임아웃 (Docker Swarm 기본 stop_grace_period: 10s보다 여유있게)
const withTimeout = (signal: string) => {
  const timer = setTimeout(() => {
    logger.error('Graceful shutdown 타임아웃, 강제 종료');
    process.exit(1);
  }, 30_000);
  timer.unref();  // 타이머가 프로세스 종료를 방해하지 않도록
  shutdown(signal);
};

process.on('SIGTERM', () => withTimeout('SIGTERM'));
process.on('SIGINT', () => withTimeout('SIGINT'));
```

#### ⚠️ redisAdapter 변수 스코프 주의

현재 `redisAdapter`는 `bootstrap()` 함수의 try 블록 안에서 선언됨 (`main.ts:54`).
shutdown handler에서 접근하려면 try 블록 상단에서 `let redisAdapter: RedisIoAdapter;`로 선언하거나,
handler를 try 블록 안에 배치해야 함.

```typescript
async function bootstrap() {
  // ...
  try {
    // ...
    const redisAdapter = new RedisIoAdapter(app);  // ← 현재 위치
    // ...
    
    await app.listen(port, '0.0.0.0');
    
    // shutdown handler는 여기 (redisAdapter 스코프 안)
    process.on('SIGTERM', () => withTimeout('SIGTERM'));
    process.on('SIGINT', () => withTimeout('SIGINT'));
    
  } catch (error) { ... }
}
```

#### 위험 요소

- **`app.enableShutdownHooks()`와 Docker Swarm**: Docker 기본 stop_grace_period 10초. 30초 타임아웃이면 Docker가 먼저 SIGKILL 보냄. → Docker Compose/Swarm에서 `stop_grace_period: 35s`로 늘려야 30초 graceful이 의미 있음
- **진행 중인 Cron 작업**: `autoArchiveTasks`는 UPDATE 쿼리 → 강제 종료 시 부분 업데이트 가능하나, Oracle은 커밋 안 된 트랜잭션을 자동 rollback
- **Redis 고아 키**: TTL 설정으로 자동 정리 → graceful shutdown 실패해도 안전장치 있음
- **이중 종료 방지**: SIGINT 2번 누르면 handler가 2번 실행됨 → `let isShuttingDown = false;` 가드 추가 권장

#### 실행 체크리스트
```
[ ] redis-io.adapter.ts에 disconnect() 메서드 추가
[ ] main.ts에 app.enableShutdownHooks() 추가
[ ] main.ts에 shutdown handler 추가 (redisAdapter 스코프 안)
[ ] 이중 종료 방지 가드 (isShuttingDown flag)
[ ] SIGTERM 시 정상 종료 테스트 (로그 확인)
[ ] 진행 중인 WS 연결이 있을 때 종료 테스트
[ ] Docker 배포 시 stop_grace_period 설정 확인 (필요 시 조정)
```

---

## 완료된 작업 (Phase 3)

### C1. Pino 로깅 도입
- **상태**: 완료
- **변경 파일**:
  - `package.json` — `nestjs-pino`, `pino`, `pino-http` 추가 / `pino-pretty`, `pino-roll` (dev)
  - `src/common/logger/logger.module.ts` — 신규 (환경별 분리, 민감정보 마스킹, Request ID)
  - `src/app.module.ts` — `LoggerModule` import
  - `src/main.ts` — `bufferLogs: true`, `app.useLogger()`, LoggingInterceptor 제거, 미사용 domain 변수 제거
  - `src/config/env.validation.ts` — `LOG_LEVEL` 검증 추가
  - `.gitignore` — `logs/` 추가
- **자동 해결**: F2(Request ID), F3(민감정보 마스킹)
- **후속**: `pnpm install` 실행 필요 (pnpm store 문제로 CLI에서 설치 불가)
- **RedisIoAdapter**: DI 밖이라 기존 `new Logger()` 유지 중. Pino 활성화 후에도 정상 동작 (NestJS Logger가 Pino로 위임)

---

## Phase 4 — 에러/HTTP 강화

### F1. ValidationPipe exceptionFactory

- **난이도**: 쉬움 | **효과**: 보통 | **위험도**: ⚠️ 프론트 확인 필수 | **범위**: 1파일

#### 현재 문제

NestJS 기본 ValidationPipe는 에러 시 다음 형태로 응답:
```json
{ "statusCode": 400, "message": ["taskName must be a string"], "error": "Bad Request" }
```

이 프로젝트의 에러 포맷(`{ code, message, timestamp }`)과 불일치.

#### 프론트엔드 영향 분석 (전수 확인)

| 프론트 파일 | message 배열 처리 | 영향 |
|-----------|:---:|------|
| `authService.ts` | ✅ `Array.isArray(message)` 처리 | 안전 |
| `teamService.ts` | ❌ 미처리 (문자열로 가정) | **현재도 배열이 올 수 있어 잠재 버그** |
| `userService.ts` | ❌ 미처리 | **동일** |
| `FetchService.ts` | `data.code && data.message` 체크 | NestJS 기본 포맷은 `code` 없어서 폴백 |

#### 결론

**exceptionFactory 추가하면 오히려 프론트 호환성이 개선됨:**
- `message`가 항상 문자열로 정규화 → teamService/userService의 잠재 버그 해소
- `code: 'VALIDATION_ERROR'` 포함 → FetchService의 `data.code` 체크 통과

현재 ValidationPipe 옵션 (`main.ts:85-93`, B2 전환 후 `app.module.ts`):
```typescript
new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  transformOptions: {
    enableImplicitConversion: true,
  },
  // ↓ 추가
  exceptionFactory: (errors) => {
    const messages = errors
      .map(e => Object.values(e.constraints || {}).join(', '))
      .join('; ');
    return new ApiValidationErrorResponseDto(messages || '요청 값이 올바르지 않습니다.');
  },
})
```

> `ApiValidationErrorResponseDto`는 `src/common/dto/api-error.dto.ts`에 이미 정의됨 (status 422, code 'VALIDATION_ERROR')

#### ⚠️ 에러 포맷 변경 전후 비교

| | 변경 전 (NestJS 기본) | 변경 후 (exceptionFactory) |
|---|---|---|
| HTTP 상태 | 400 | **422** (ApiValidationErrorResponseDto) |
| `code` | 없음 | `VALIDATION_ERROR` |
| `message` | `["taskName must..."]` (배열) | `"taskName must..."` (문자열) |
| `timestamp` | 없음 | 있음 (HttpExceptionFilter에서 추가) |

> HTTP 상태가 400 → 422로 변경됨. 프론트의 `handleApiError`는 status 기반 폴백을 사용하는데, 422는 `UNPROCESSABLE_ENTITY`로 매핑됨. 그러나 응답에 `code: 'VALIDATION_ERROR'`가 포함되므로 프론트는 이 코드를 우선 사용 → **실질 영향 없음**.

#### 실행 체크리스트
```
[ ] ValidationPipe에 exceptionFactory 추가 (main.ts 또는 app.module.ts)
[ ] ApiValidationErrorResponseDto import 확인
[ ] Swagger에서 잘못된 요청 보내서 에러 포맷 확인:
    - code: 'VALIDATION_ERROR'
    - message: 문자열 (배열 아님)
    - timestamp 포함
    - HTTP 상태 422
[ ] 프론트 팀 서비스/유저 서비스에서 validation 에러 toast 정상 확인
[ ] 프론트 auth 서비스에서 카카오 로그인 validation 에러 정상 확인
```

---

### F2. 에러 응답에 Request ID 포함
- **Pino 도입 시 자동 해결** (req.id 접근 가능)
- Pino 미도입 시: 에러 필터에서 `request.headers['x-request-id']` 또는 UUID 생성

### F3. 민감정보 마스킹
- **Pino 도입 시 자동 해결** (serializer에 redactSensitiveData 포함)

### F4. 에러 필터 로깅 강화
- **현재 이미 양호** (500+ → error with stack, 나머지 → warn)
- 추가 가능: 알 수 없는 예외의 원본 객체 전체 로깅

---

## Phase 5 — 확장 대비

### C2. Health Check 강화
- **난이도**: 쉬움 | **효과**: 보통 | **위험도**: 낮음
- `@nestjs/terminus` 도입, DB/Redis 연결 상태 포함

### D1. TeamService 분리 (Fat Service 해소)
- **난이도**: 어려움 | **효과**: 높음 | **위험도**: 중간
- `TaskService`, `CommentService`, `InvitationService`로 분리

### D2. 테스트 인프라 구축
- **난이도**: 어려움 | **효과**: 높음 | **위험도**: 낮음
- mobisell-back 참고: Entity Factory (`@faker-js/faker`) + Mock Adapter

### D3. Port/Adapter 패턴 (알림 서비스)
- **난이도**: 보통 | **효과**: 보통 | **위험도**: 낮음
- `INotificationPort` 인터페이스 + Symbol 토큰 DI
- 테스트 시 Mock 교체 가능

### D4. typeorm-transactional 도입
- **난이도**: 보통 | **효과**: 보통 | **위험도**: ⚠️ Oracle 호환성 확인 필요
- `@Transactional()` 데코레이터로 선언적 트랜잭션
- `initializeTransactionalContext()`는 `NestFactory.create` 전 호출 필수

### B3. Redis 클라이언트 수동 주입 → Custom Provider (보류)
- **난이도**: 보통 | **효과**: 보통 | **위험도**: 🔴 높음 | **상태**: 보류
- **보류 이유**: RedisIoAdapter가 `app.useWebSocketAdapter()` 전에 준비 완료되어야 하는데, Provider `onModuleInit` 타이밍이 이를 보장하지 못함. Silent failure 가능성.
- **현재 방식**: main.ts에서 수동 관리 (명시적 초기화 순서 보장, 안전)
- **재검토 시점**: NestJS가 WebSocket Adapter의 DI 지원을 공식 개선할 때

---

## 추천 실행 순서 (위험도 리뷰 반영)

> Phase 내에서도 아래 순서대로 실행 권장. 각 작업 완료 후 `tsc --noEmit` + 앱 시작 확인.

| 순서 | 작업 | 위험도 | 근거 |
|:---:|------|:---:|------|
| ~~1~~ | ~~C1 Pino 도입~~ | ✅ | 완료 |
| 2 | **C3 Graceful Shutdown** | 🟢 | 가장 시급. 추가만 함, 기존 코드 변경 없음 |
| 3 | **A1 Entity 관계 수정** | 🟢 | 직접 참조 0곳, QB join 호환 확인 완료 |
| 4 | **B2 DI 기반 전환** | 🟢 | WS 독립, Filter/Pipe만 (Interceptor는 C1에서 제거됨) |
| 5 | **F1 ValidationPipe 에러 통일** | 🟡 | 프론트 호환성 개선 방향이지만 확인 필요 |
| 6 | **F4 에러 필터 로깅 강화** | 🟢 | 작은 추가 |

---

## 실행 체크리스트 (전체)

```
Phase 1 — 완료
  [✓] A2  환경변수 검증
  [✓] B1  console → Logger
  [✓] B4  소켓 타입 안전성

Phase 2 — NestJS 정석화
  [ ] C3  Graceful shutdown          ← 가장 시급 (현재 정리 0)
  [ ] A1  Entity 관계 수정           ← 안전 확인 (직접 참조 0곳, QB 호환)
  [ ] B2  글로벌 설정 DI 기반        ← 안전 확인 (WS 독립, 의존성 단순)

Phase 3 — Pino 로깅
  [✓] C1  Pino 도입                  ← F2(Request ID) + F3(마스킹) 자동 해결. pnpm install 필요

Phase 4 — 에러/HTTP 강화
  [ ] F1  ValidationPipe 에러 통일   ← 프론트 잠재 버그 해소
  [✓] F2  Request ID                ← C1에서 해결됨
  [✓] F3  민감정보 마스킹            ← C1에서 해결됨
  [ ] F4  에러 필터 로깅 강화

Phase 5 — 확장 대비
  [ ] C2  Health check 강화
  [ ] D1  TeamService 분리
  [ ] D2  테스트 인프라
  [ ] D3  Port/Adapter (알림)
  [ ] D4  typeorm-transactional
  [⏸] B3  Redis Custom Provider     ← 보류 (타이밍 위험, 현재 방식이 안전)
```

---

## 프론트엔드 영향 상세

| 작업 | 프론트 수정 | 상세 |
|------|:---:|------|
| Phase 1~2 | 없음 | |
| C1 Pino | 없음 | 서버 내부 로깅만 변경 |
| F1 ValidationPipe | **없음 (오히려 개선)** | message가 항상 문자열로 → 잠재 버그 해소 |
| F2 Request ID | 없음 | 에러 응답에 필드 추가 (하위 호환) |
| Phase 5 | 없음 | 내부 리팩토링 |

---

## 위험도 요약

| 작업 | 위험도 | 핵심 이유 |
|------|:---:|----------|
| A1 Entity | 🟢 낮음 | 직접 참조 0곳, QB join 호환 |
| B2 DI 전환 | 🟢 낮음 | WS 독립, 단순 의존성 |
| B3 Redis Provider | 🔴 높음 | 초기화 타이밍 불확실 → **SKIP** |
| C3 Graceful Shutdown | 🟢 낮음 | 추가만 함, 기존 코드 변경 없음 |
| C1 Pino | 🟢 낮음 | Logger 인터페이스 호환, 기존 코드 변경 없음 |
| F1 ValidationPipe | 🟡 중간 | 에러 포맷 변경이지만 프론트 호환성 개선 방향 |
| D4 typeorm-transactional | 🟡 중간 | Oracle 호환성 미확인 |

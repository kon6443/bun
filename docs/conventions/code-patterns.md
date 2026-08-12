# 코드 패턴 (SSOT)

> 최종 확인일: 2026-08-12 · 근거: `src` 전체 113개 `.ts`(spec 27개 포함) 실측 — 각 규약에 사용 카운트 병기
> **용도**: 새 코드를 "이 프로젝트 모양"으로 작성하기 위한 규약. 신규 API·모듈·Gateway·테스트 작성 **전에** 해당 섹션을 확인한다.
> **경계**: 여기는 *코드를 어떻게 쓰는가*. 금지·함정·현재 상태는 [`CLAUDE.md`](../../CLAUDE.md), 사실·사용법은 [`README.md`](../../README.md), 반복 결함 진단은 [`playbooks/recurring-issues-playbook.md`](../playbooks/recurring-issues-playbook.md).

규모 참고: 컨트롤러 7 · 서비스 9 · Gateway 2 · Entity 8 · 마이그레이션 3.

---

## 1. 계층 규약 — Repository 클래스 없음

- **Controller → Service → TypeORM Entity** 2계층. 별도 Repository 클래스를 만들지 않는다 (`*repository*.ts` **0건**).
- Service가 `@InjectRepository(Entity)`로 `Repository<Entity>`를 직접 주입받는다 (**11개 파일**).
- 로직이 커지면 협력 서비스로 분리한다 (예: `online-user.service.ts`, `fishing-online.service.ts`) — DB 접근 방식은 동일 유지.
- 횡단 관심사는 `src/common/` 아래로: `guards`, `filters`, `pipes`, `decorators`, `adapters`, `port`, `metrics`, `logger`, `constants`, `enums`, `dto`, `utils`.

### Path Aliases

```typescript
@/*         → src/*
@entities/* → src/entities/*
@modules/*  → src/modules/*
@common/*   → src/common/*
@config/*   → src/config/*
```

## 2. DB 접근 스타일

| 상황 | 사용 | 근거 |
|---|---|---|
| 단건·단순 목록 | `repository.findOne / find / findAndCount` | 지배적 |
| 조인·집계·동적 조건 | `createQueryBuilder` | **5건** |
| raw `.query()` | **0건 — 쓰지 않는다** | 신규 사용 전 재고 |

- Entity는 `src/entities/`에 **테이블당 1파일**(PascalCase, 예: `TeamTask.ts`), 컬럼은 `@Column({ name: 'UPPER_SNAKE' })`로 Oracle 실제 컬럼명을 명시한다.
- 쿼리 결과 전용 타입(`*View`)이 필요하면 Entity와 별도로 두고, 테스트 팩토리도 `create*View`로 함께 만든다 (§8).
- `synchronize: false` — 스키마는 마이그레이션만이 바꾼다. Entity의 `nullable`/`length`/`default` 표기는 **런타임 효과가 없다**(읽는 사람을 위한 문서일 뿐, 실제 제약은 DB가 강제). 상세: CLAUDE.md Pitfalls #4.

## 3. 트랜잭션 — `dataSource.transaction()` 콜백

```typescript
await this.dataSource.transaction(async (manager: EntityManager) => {
  await manager.save(...);
  await manager.update(...);
});
```

- 여러 테이블에 걸친 쓰기는 위 형태로 감싼다 — **4곳** (`team.service.ts:291,1178`, `telegram.service.ts:343,442`).
- `@Transactional`(typeorm-transactional) **0건**, `queryRunner` 수동 열기/닫기 **0건** — 둘 다 이 프로젝트에서 쓰지 않는다. 새 의존성을 들이지 말고 위 콜백을 쓴다.
- ⚠️ **Oracle DDL은 자동 커밋**이라 마이그레이션에는 트랜잭션이 무의미하다 — 멱등 가드가 유일한 방어책 (CLAUDE.md Pitfalls #2).

## 4. 에러 처리 — `defineDomainError` 팩토리

```typescript
// {module}.error.dto.ts — 7개 파일, 정의 39건
export const TeamNotFoundErrorResponseDto = defineDomainError({
  code: 'TEAM_NOT_FOUND',
  status: 404,
  message: '팀을 찾을 수 없습니다.',
  name: 'TeamNotFoundErrorResponseDto',
});

// service에서
throw new TeamNotFoundErrorResponseDto();               // 기본 메시지
throw new AuthUnauthorizedErrorResponseDto('카카오 액세스 토큰이 필요합니다.'); // 메시지 override
```

- 전역 `HttpExceptionFilter`(`APP_FILTER`)가 3단 분기 → **`{ code, message, timestamp }`** 로 통일. `details`는 있을 때만 포함된다.
  1. `ApiErrorResponseDto` 인스턴스 → DTO가 들고 있는 code/message/details
  2. 일반 `HttpException` → 상태코드 매핑표로 code 생성 (예: `429 → TOO_MANY_REQUESTS`)
  3. 그 외 → `INTERNAL_SERVER_ERROR` + 고정 메시지 (원본 노출 안 함)
- 응답 바디에 **`statusCode` 필드는 없다** — HTTP 상태와 `code`로 분기한다.
- 로그 레벨은 필터가 분리한다: `status >= 500`은 `error`(스택 포함), 그 외는 `warn`.
- ⚠️ 에러 경로 테스트는 **status·code를 정확히 고정**한다. `expect([403,404]).toContain(status)` 같은 느슨한 단정은 그 차이가 곧 방어의 유무일 때 테스트를 조용히 무력화한다 (CLAUDE.md Pitfalls #8).

## 5. 입력 검증 — 전역 ValidationPipe만

`src/common/pipes/global-validation-pipe.ts`의 `createGlobalValidationPipe()` 하나가 `APP_PIPE`와 E2E에서 **공유**된다. 설정을 한쪽에서만 바꾸면 E2E가 프로덕션과 다른 규칙으로 검증하게 되므로 **이 파일만 고친다**.

```typescript
whitelist: true,              // DTO에 없는 필드 제거
forbidNonWhitelisted: true,   // 없는 필드가 오면 에러 (조용히 무시하지 않음)
transform: true,
transformOptions: { enableImplicitConversion: true },
exceptionFactory: → ApiValidationErrorResponseDto
```

- `enableImplicitConversion: true`이므로 쿼리/파라미터 숫자 변환에 `@Type(() => Number)`가 필요 없다 — class-transformer `@Type`은 쓰지 않는 것이 현행 패턴.
- 날짜 DTO는 `@IsDate()` + 암묵 변환에 의존한다.
- 커스텀 Pipe는 없다.

## 6. 인증/인가 — Guard는 메서드/클래스에 개별 부착

| 구분 | Guard | 사용 | 사용자 주입 |
|---|---|---|---|
| HTTP 인증 | `@UseGuards(JwtAuthGuard)` | **25곳** | `@CurrentUser()` (**26곳**) |
| HTTP 선택 인증 | `OptionalJwtAuthGuard` | 1곳 | |
| WS `/teams` | `WsJwtGuard` | 3곳 | |
| WS `/fishing` | `FishingWsGuard` | 6곳 | |
| 전역 | `CustomThrottlerGuard` (`APP_GUARD`) | 전 라우트 | |

- **전역 인증 Guard와 `@Public` 데코레이터는 없다** — 공개 라우트는 Guard를 안 붙이는 방식. 신규 라우트에서 `JwtAuthGuard`를 빠뜨리면 그대로 무인증 공개된다.
- 토큰 위치: HTTP는 cookie `access_token` → Bearer 헤더 순, WS는 `handshake.auth.token` → Bearer 헤더 순.
- **인증 ≠ 인가**: Guard는 "로그인했는가"까지만 본다. **팀 멤버십·역할 검증은 서비스/컨트롤러가 직접** 한다 (`MANAGEMENT_ROLES.includes(...)` 등). 여기가 실제로 반복 누락된 지점이므로 신규 엔드포인트마다 확인한다 (playbook 클러스터 1).
- 스로틀 제외는 `@SkipThrottle()` — 현재 `telegram`(Bot API 호출), `main`, `health` 3개 컨트롤러.
- 스로틀 식별자는 로그인 시 `user-{userId}`, 비로그인 시 `X-Forwarded-For` 첫 IP → `req.ip` (`CustomThrottlerGuard.getTracker`).

## 7. 응답/직렬화 — 전역 인터셉터 없음, 컨트롤러가 리터럴 반환

```typescript
// 컨트롤러 공통 패턴 — 30건
return { code: 'SUCCESS', data: teamMembers, message: '' };
```

- **응답 인터셉터가 없다.** 컨트롤러가 `{ code, data, message }` **객체 리터럴을 직접 반환**한다.
- `extends ApiSuccessResponseDto` (**26건**)는 **Swagger 명세용 타입 선언 전용**이다 — `new`로 인스턴스를 만들어 반환하지 않는다. 베이스는 `code: 'SUCCESS'` + `message`만 갖고, `data`는 상속 DTO가 정의한다.
- Swagger 에러 명세는 공통 데코레이터로 붙인다: `@ApiCommonUnauthorizedResponse()`(28) · `@ApiCommonInternalServerErrorResponse()`(28) · `@ApiCommonValidationResponse()`(18) · `@ApiThrottledResponse()`(2).

## 8. 테스트 패턴 — mock Repository + Factory (⚠️ 실제 DB 아님)

**신규 spec에서 실제 DB에 붙이면 컨벤션 위반이다.** NestJS에서 흔한 "실DB + 트랜잭션 롤백" 방식과 정반대다 — 이 프로젝트는 LOCAL과 PROD가 **동일 Oracle DB**라서 연결 자체를 만들지 않는다.

- 표준 헬퍼 2종을 **반드시** 사용한다:
  - Mock: `src/common/__spec__/mock-repository.ts` → `createMockRepository()`, `createMockQueryBuilder()` (**17개 spec**)
  - Factory: `src/entities/__spec__/entity.factory.ts` → `createUser`/`createTeam`/`createTeamTask`… + 쿼리 결과용 `createTeamTaskView`/`createTeamMemberView`, 고정 시각 `FIXED_DATE` (**19개 spec**)
- 단위 spec 27개 · E2E 8개.
- spec은 **도메인별 분리**: `team.service.<도메인>.spec.ts`.
- **E2E는 DB에 접속하지 않는다**: `AppModule` import 금지(`TypeOrmModule`이 부팅만으로 상용 DB에 붙는다) → `test/helpers/e2e-app.ts`의 `createE2eApp()`을 쓴다. `test/setup/forbid-db.ts`가 oracledb 드라이버 레벨에서 차단한다. 롤백이 아니라 **연결이 없다**.
- 프로덕션 코드를 바꿀 때 그 코드를 검증하는 테스트를 **같은 커밋에서** 갱신한다 (CLAUDE.md Pitfalls #7).

## 9. WebSocket Gateway

- namespace 2개: `/teams`(`team.gateway.ts`) · `/fishing`(`fishing.gateway.ts`). room은 `team-{teamId}`.
- 멀티 레플리카 브로드캐스트는 `RedisIoAdapter`(`src/common/adapters/`)가 담당 — pub/sub 2연결, `lazyConnect: true` + `maxRetriesPerRequest: null`(redis-adapter 필수).
- Redis 연결 실패해도 앱은 기동한다 (HTTP 정상, WS 프레즌스만 중단).
- 온라인 상태는 **프로세스 메모리에 두지 않는다** — Redis Hash/Set + TTL (`online-user.service.ts`, `fishing-online.service.ts`). Redis 클라이언트는 `main.ts`에서 `setRedisClient(redisAdapter.getPubClient())`로 수동 주입한다(DI 아님).
- 같은 유저 다중 탭은 소켓 집합으로 관리해 `wasAlreadyOnline`으로 중복 입장/퇴장 알림을 막는다.
- ⚠️ `joinTeam` 등 room 진입 핸들러에서 인증 가드가 빠지면 **누구나 임의 팀 room의 모든 이벤트를 수신한다** (실제 결함 전례: 커밋 `54393a8`).

## 10. 스케줄러 — 멀티 레플리카 2단 가드 필수

```typescript
// scheduler.service.ts
private shouldSkip(): boolean {
  return !this.schedulerEnvs.includes(this.env) || this.TASK_SLOT !== 1;
}
```

- NestJS는 **3 replicas**로 뜬다. 가드 없는 `@Cron`은 전 레플리카에서 중복 실행된다.
- `TASK_SLOT`은 `docker-stack.app.yml`의 `{{.Task.Slot}}`으로 주입되며 **1인 레플리카만** 실행한다. env 화이트리스트도 함께 확인한다.
- 같은 이유로 Prometheus 게이지 등 "전역 1회 계산" 지표도 `TASK_SLOT=1`에서만 갱신한다 (중복 timeseries 방지).
- 인메모리 상태·타이머도 동일 — 공유 상태는 Redis로.

## 11. 외부 연동 — Port/Adapter

- `src/common/port/notification.port.ts` — 인터페이스 + DI 토큰(Symbol) 정의 후 구현체를 모듈에서 바인딩한다.
- 현재 **1쌍만** 존재한다. 새 외부 연동(HTTP API·메신저·스토리지)은 이 패턴을 따르고, 서비스가 `axios`를 직접 들지 않게 한다.

## 12. 날짜/시간 — UTC 저장, 표시 시점 변환

- Entity의 시각 컬럼은 **전부 `timestamp with time zone`** (시각 컬럼을 가진 Entity 7개에 걸쳐 14개 컬럼 실측 — `FileShare`만 시각 컬럼 없음).
- 컨테이너는 `TZ=UTC`(Dockerfile) — UTC로 저장/처리하고 **표시 단계에서만** 로컬 변환한다.
- 🚫 **`ORA_SDTZ` 설정 금지** — oracledb가 로컬 TZ 기준으로 Date를 저장하므로 세션 TZ를 자동 일치시켜야 한다.
- 🚫 Oracle `FROM_TZ()`에 리전 이름(`'UTC'`) 금지 → 오프셋(`'+00:00'`) 사용 (ORA-01805 방지).
- 텔레그램 등 알림 포맷은 `src/common/utils/date.utils.ts`의 `formatDateTime()`을 쓴다.
- ⚠️ `docs/architecture.md`의 "투과 방식(변환 없음) / timezone-naive" 서술은 **2026-04-14 커밋 `2c86d73`으로 폐기된 옛 정책**이다 — 그 문서를 근거로 삼지 말 것 (playbook 클러스터 3).

---

## 신규 기능 체크리스트

**신규 HTTP 엔드포인트**
- [ ] `@UseGuards(JwtAuthGuard)` 부착했는가? (§6 — 안 붙이면 무인증 공개)
- [ ] 팀 멤버십·역할 인가를 서비스/컨트롤러에서 검증하는가? (§6 — Guard는 인증까지만)
- [ ] 에러는 `defineDomainError`로 정의해 throw하는가? (§4)
- [ ] 응답을 `{ code:'SUCCESS', data, message }` 리터럴로 반환하는가? (§7)
- [ ] Swagger: `@ApiOperation` + 응답 DTO + 공통 에러 데코레이터 (§7)
- [ ] 다중 테이블 쓰기면 `dataSource.transaction()`으로 감쌌는가? (§3)
- [ ] spec: `createMockRepository` + Factory, 에러 경로는 status·code 정확 고정 (§8)

**신규 WS 이벤트**
- [ ] 핸들러에 WS Guard를 부착했는가? (§9 — room 무단 진입 전례 있음)
- [ ] 상태를 Redis에 두었는가? (인메모리 금지 — 3 replicas, §9)
- [ ] 프론트(`../next-bun`) 이벤트명·페이로드와 1:1 대조했는가?

**DB 스키마 변경**
- [ ] Entity 수정 + 마이그레이션 파일을 **세트로** 제출했는가? (드리프트 방지)
- [ ] 멱등 작성(`USER_TAB_COLUMNS` 존재 체크) · 1파일 1목적 · `down()` 포함?
- [ ] PK는 DB IDENTITY 종류와 맞췄는가? (`GENERATED ALWAYS`면 `@PrimaryGeneratedColumn`, CLAUDE.md Pitfalls #5)
- [ ] 🚫 **실행은 하지 않는다** — 파일 작성까지만, 실행은 담당자 요청 (LOCAL=PROD 동일 DB)

**스케줄러/배치 추가**
- [ ] `TASK_SLOT !== 1` + env 화이트리스트 2단 가드를 넣었는가? (§10)

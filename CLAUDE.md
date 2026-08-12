# FiveSouth Backend (NestJS)

NestJS 11 + TypeScript 백엔드. Oracle DB (TypeORM), Socket.IO + Redis Pub/Sub.

**문서 경계** — 같은 내용을 두 곳에 쓰지 않는다:

| 문서 | 담당 | 예시 |
|---|---|---|
| [`README.md`](README.md) | **사실·사용법** (What / How) — 사람·AI 공통 | 기술 스택, 모듈 구성, 명령어, 환경변수, 배포 구성, **문서 목록** |
| **이 문서** | **규약·금지·함정** (Rules) — AI 행동 지침 | 라우팅 표, 금지 사항, Pitfalls, DoD, 커밋 컨벤션 |
| [`docs/conventions/`](docs/conventions/) · [`docs/playbooks/`](docs/playbooks/) | **코드 규약 상세 · 결함 진단** | 계층·트랜잭션·테스트 패턴, 반복 결함 클러스터 |
| [`docs/tasks/*.md`](docs/tasks/) | **진행 상황·이력·결정 근거** (Status / Why) | 각 문서 헤더의 상태, 커밋 해시, 잔여 항목, 판정 근거 |

**이 문서에 진행 상황·완료 이력·커버리지 수치를 쓰지 않는다.** 두 곳에 두면 반드시 어긋난다 — 실제로 커버리지가 이 문서엔 `62.7%`, 태스크 문서엔 `62.64%`로 갈렸던 전례가 있다. 사실은 README를, 진행 상황은 해당 태스크 문서를 링크한다.

---

## 자동 라우팅 표 (MUST OBEY)

요청에서 아래 트리거가 매칭되면 **작업 시작 전에** 해당 문서를 `Read`한다. 둘 이상 매칭되면 모두 읽는다.

| 트리거 (요청 키워드 / 작업 성격) | 즉시 읽을 파일 |
|---|---|
| **코드 작성·수정·구현 (모든 `src` 작업)** · 신규 API/WS 이벤트 · 테스트 작성 | `docs/conventions/code-patterns.md` — 계층·DB·트랜잭션·에러·인증·응답·테스트 규약 SSOT (실측 카운트 병기) |
| **버그 · 장애 · 에러 · 회귀 · "안 됨" 조사** | `docs/playbooks/recurring-issues-playbook.md` — 반복 결함 클러스터별 **최우선 확인 지점**부터 진단 |
| 대규모 리팩터링·마이그레이션 **착수 전** · 사용자 교정 **직후** | `docs/lessons.md` — 작업 방식의 누적 교훈 (검토 후 새 교훈은 append) |
| 세션 재개 · `/compact` **직후** 맥락 복구 | `docs/handoff/` 최신 스냅샷 — PreCompact 훅이 남긴 핸드오프. 없으면 생략 |
| 구조 파악 · 신규 모듈 · 파일 위치 탐색 | `docs/architecture.md` — ⚠️ **날짜 처리 섹션은 2026-04-14 커밋 `2c86d73`으로 폐기된 옛 정책**이다(playbook 클러스터 3). 모듈 구성은 `README.md`가 더 정확하다 |
| 배포 · Swarm · 스택 · 롤백 · 서버 운영 | `docs/deploy.md` |
| DB 스키마 변경 · 마이그레이션 · Entity 수정 | 이 문서 **DB Migrations** 섹션 + `docs/tasks/tasks-nestjs-improvements.md` D33/D34 |
| 테스트 작성 · 리팩터링 · 코드 품질 개선 | `docs/tasks/tasks-nestjs-improvements.md` (D2/D5 등 해당 태스크) |
| 에러 응답 · 도메인 에러 DTO · Swagger 에러 명세 | `docs/tasks/tasks-error-dto-refactor.md` |
| 실시간 채팅 · WS 이벤트 추가 | `docs/tasks/tasks-team-chat.md` |
| 메트릭 · Prometheus · Grafana | `docs/tasks/tasks-monitoring.md` |
| 로그 수집 · Loki · Promtail | `docs/tasks/tasks-logging.md` |
| Redis Pub/Sub · 멀티 레플리카 브로드캐스트 | `docs/prd-redis-pubsub.md` + `docs/tasks/tasks-redis-pubsub.md` |
| **프론트(`../next-bun`) 코드 확인 또는 작업** (API 계약·소켓 이벤트·날짜 표시 대조) | `../next-bun/CLAUDE.md` — 🔴 **자동 로드되지 않는다** (추가 작업 디렉터리라 세션 시작 시 컨텍스트에 없음). "코드만 잠깐 본다"도 예외 아님 — 미로드 시 그쪽 고유 규약을 놓친다 |

**면제**: 단일 한 줄 수정, 단순 정보 조회, 1회성 명령 실행.

---

## 작업 경계: Never / Ask — 상시 적용

문맥에서 승인을 유추하지 않는다. **의심되면 멈추고 물어본다.**

### Never — 어떤 경우에도 하지 않는다

| 금지 | 이유 |
|---|---|
| **DB에 접속하는 명령 실행** — `db:migrate:up`/`fake`/`revert`/**`list`**, `sqlplus`, DataSource를 직접 여는 스크립트(`tsx`·`node` 포함) | **LOCAL과 PROD가 동일 DB** — 모든 `up`이 곧 상용 적용. `list`조차 첫 실행 시 이력 테이블을 생성한다. AI는 **파일 작성까지만** (↓ DB Migrations) |
| `db:migrate:fake`를 평상시 사용 | pending이 있는 상태면 DDL 없이 기록만 되어 **조용히 미적용** (↓ Pitfalls #1) |
| Caddyfile을 Git에 커밋 | 공개 저장소 — 도메인·IP 노출 (↓ Deployment) |
| 시크릿(JWT_SECRET·wallet·봇 토큰)을 코드·로그·응답·문서에 기입 | 커밋 이력에 영구 보존된다 |
| `ORA_SDTZ` 설정 · Oracle `FROM_TZ()`에 리전 이름(`'UTC'`) | 전자는 oracledb가 로컬 TZ로 Date를 저장, 후자는 ORA-01805 (↓ Date/Time) |
| E2E에서 `AppModule` import | `TypeOrmModule`이 **부팅만으로 상용 DB에 붙는다** — `createE2eApp()`을 쓴다 |
| 인메모리 변수·타이머로 공유 상태 관리 | NestJS 3 replicas — 레플리카별로 중복 실행된다. Redis + `TASK_SLOT` 가드 |
| `any` · `@ts-ignore` 등 타입 억제 | 글로벌 `engineering.md` §3 |
| 사용자 지시 없는 `git commit`·`push` | auto mode에서도 금지 (↓ Rules) |

### Ask — 실행 전 반드시 사용자 승인

| 확인 대상 | 비고 |
|---|---|
| 커밋 · 푸시 · 머지 · 리베이스 · 태그 | `main` push는 곧 자동 배포다 |
| 배포 · `docker` 명령 · `ssh`/`scp` | 운영 서버 영향 |
| 파일·디렉토리 삭제, 비가역 변경 | |
| **마이그레이션 실행 요청** | 파일 작성은 AI, 실행은 담당자 — 완료 조건에서 분리해 명시한다 |
| **API 계약 변경** (상태코드·에러코드) | 프론트(`../next-bun`) 대응 필요 여부까지 커밋 본문에 명시 |
| 새 의존성 추가 | 기존 스택으로 안 풀리는지 먼저 확인 |
| 외부로 발송되는 알림 경로 변경 (Telegram·Discord) | 실제 사용자에게 도달한다 |

---

## Commands

명령어·환경변수 전체 목록은 [`README.md`](README.md)가 SSOT다. 작업 시 자주 쓰는 것만:

- 검증: **`pnpm ci:core`**(lint → test → build) · PR 직전 **`pnpm ci:all`**(+ 스텁 검사 + E2E). 개별 실행은 `pnpm build`·`pnpm lint`·`pnpm test`·`pnpm test:e2e`
  - **테스트는 전부 통과하는 상태가 기준선이다 — 실패가 보이면 내 변경 탓이다** (기준선 수치는 [`README.md`](README.md#주요-명령어))
  - E2E는 **DB·Redis에 접속하지 않는다** (아래 Never 표 참조)
- 실행: `pnpm dev` → `localhost:3500/api/v1` · Swagger `/api/v1/docs` (LOCAL only)
- 부분 테스트로 좁혀 돌리는 방법은 [`README.md`](README.md#주요-명령어) 참조
  - ⚠️ `--testPathPattern`(구 단수형)은 jest 30에서 **동작하지 않는다** — 실측 에러: `Option "testPathPattern" was replaced by "--testPathPatterns"`. 복수형을 쓴다.

### Path Aliases

`@/*` → `src/*` · `@entities/*` · `@modules/*` · `@common/*` · `@config/*` (`tsconfig.json`)

## Key Patterns

> 요약만 둔다. **코드를 쓰기 전에 상세와 실측 카운트는 [`docs/conventions/code-patterns.md`](docs/conventions/code-patterns.md)를 읽는다** (라우팅 표 1행).

- **응답 포맷**: `{ code, data, message }` — 전역 인터셉터 없음, 컨트롤러가 **객체 리터럴을 직접 반환**한다. `ApiSuccessResponseDto` 상속 DTO는 **Swagger 명세용 타입 선언 전용**(`new`로 만들어 반환하지 않는다)
- **에러**: `defineDomainError` 팩토리로 정의 후 throw → `HttpExceptionFilter`가 `{ code, message, timestamp }`로 통일. 응답 바디에 `statusCode` 필드는 **없다**
- **계층**: Repository 클래스 없음 — Service가 `@InjectRepository`로 직접 주입
- **트랜잭션**: `dataSource.transaction(async (manager) => ...)` 콜백 — `@Transactional`·`queryRunner` 수동 사용은 0건(도입하지 않는다)
- **인증**: Kakao OAuth + JWT — HTTP는 cookie `access_token` 우선 → Bearer 헤더 / WS는 `handshake.auth.token` → Bearer 헤더. **Guard는 인증까지만 — 팀 멤버십·역할 인가는 서비스/컨트롤러가 직접 검증한다**(반복 누락 지점, playbook 클러스터 1)
- **ValidationPipe**: `whitelist: true`, **`forbidNonWhitelisted: true`**, `transform: true`, `enableImplicitConversion: true` — 설정 본체는 `src/common/pipes/global-validation-pipe.ts` 한 곳에 있고 E2E와 공유한다(한쪽만 바꾸면 E2E가 다른 규칙으로 검증하게 된다)
- **Rate Limiting**: 글로벌 2단계 (초당 5회 + 분당 60회), 제외는 `@SkipThrottle()`
- **WS**: namespace `/teams`·`/fishing`, room `team-{teamId}` — 멀티 레플리카는 Redis Pub/Sub, 온라인 상태는 인메모리 금지(Redis)
- **프론트엔드 프로젝트**: `../next-bun` (Next.js 15 App Router + Bun) — 코드 확인 시 그쪽 `CLAUDE.md`를 먼저 읽는다(자동 로드 안 됨)

## Date/Time Handling
- UTC 저장, 로컬 표시 — DB 컬럼 전부 `TIMESTAMP WITH TIME ZONE`
- **ORA_SDTZ 설정 금지** — oracledb가 로컬 TZ 기반으로 Date를 저장하므로 세션 TZ는 자동 일치시켜야 함
- Oracle `FROM_TZ()`에 리전 이름(`'UTC'`) 금지 → 오프셋(`'+00:00'`) 사용 (ORA-01805 방지)

## DB Migrations — AI 행동 규칙

명령어·파일 규칙은 [`README.md`](README.md#db-마이그레이션) 참조. DB 접속 금지는 위 **Never 표**가 정의한다. **여기서는 파일을 작성할 때 지킬 것만**:

- ⚠️ **deny 규칙은 서브프로세스를 막지 못한다** — 공식 문서 기준 permission 규칙은 Claude Code가 인식하는 명령에만 적용되고, 스크립트가 직접 파일·DB를 여는 경우(`tsx`/`node`로 DataSource 생성 등)에는 걸리지 않는다. 그래서 Never 표의 행동 규칙이 최후 방어선이다.
- 스키마 변경은 항상 **Entity 수정 + 마이그레이션 파일을 세트로** 제출한다 (드리프트 방지).
- 마이그레이션은 **멱등 작성**(`USER_TAB_COLUMNS` 등 존재 체크), **1개 = 1목적**, `down()` 필수(init 제외).
- 결정 이력·대조 결과: `docs/tasks/tasks-nestjs-improvements.md` D33/D34

## Common Pitfalls to Avoid

이 프로젝트에서 실제로 발생했거나 근거로 확인된 함정. 같은 실수를 반복하지 않기 위한 목록이다.

> 여기는 **"하지 말 것" 목록**이다. **증상에서 출발해 원인을 찾는 진단**은 [`docs/playbooks/recurring-issues-playbook.md`](docs/playbooks/recurring-issues-playbook.md)를 쓴다 (클러스터별 최우선 확인 지점 + fix 커밋 18건 전수 분류).

1. **`db:migrate:fake`는 베이스라인 등록 1회용** — pending 마이그레이션이 있는 상태에서 실행하면 DDL 실행 없이 기록만 되어 **조용히 미적용**된다. 평상시엔 `up`만 사용.
2. **Oracle DDL은 자동 커밋** — 마이그레이션이 중간에 실패하면 부분 적용 상태로 남는다. `migrationsTransactionMode`는 DDL에 무의미하므로 멱등 가드 + 1파일 1목적이 유일한 방어책.
3. **`migration:show`(=`db:migrate:list`)도 이력 테이블을 생성한다** — 읽기 전용이 아니다 (TypeORM `MigrationExecutor.showMigrations()`가 `createMigrationsTableIfNotExist()` 호출).
4. **Entity의 `nullable`/`length`/`default`는 런타임에 아무 효과가 없다** — `synchronize: false` + `migration:generate` 미사용이므로 스키마에 반영되는 경로가 없다. 표기는 "읽는 사람을 위한 문서"일 뿐이고, 실제 제약은 DB가 강제한다.
5. **PK 선언은 DB의 IDENTITY 종류와 맞춰야 한다** — `GENERATED ALWAYS AS IDENTITY` 컬럼에 명시 값을 INSERT하면 ORA-32795로 거부된다. `@PrimaryGeneratedColumn`을 써서 ID를 생략해야 한다 (예: `TASK_COMMENTS.COMMENT_ID`, `TEAM_TELEGRAM_LINKS.LINK_ID`).
6. **문자열 컬럼을 number 타입으로 선언하지 말 것** — Oracle이 컬럼 쪽을 숫자로 암묵 변환해 비교하므로, 비숫자 값이 한 건이라도 생기면 ORA-01722로 해당 기능 전체가 깨진다 (`USERS.KAKAO_ID`가 이 사례였음). 외부 API 값은 도메인 진입 경계에서 한 번만 변환한다.
7. **프로덕션 코드를 바꿀 때 그 코드를 검증하는 테스트도 같은 커밋에서 갱신한다** — 과거 테스트가 대량 실패했을 때 원인은 인프라가 아니라 에러 DTO 리팩토링·`@CurrentUser` 전환에서 테스트를 함께 고치지 않은 것이었다.
8. **에러 경로 테스트는 status·code를 정확히 고정한다** — `expect([403, 404]).toContain(status)`처럼 느슨하게 받으면 **그 차이가 곧 방어의 유무일 때 테스트가 조용히 무력해진다**. 실제로 파일 공유 경로 탐색 테스트가 방어를 통째로 제거해도 통과했다(2026-08-12, D6). 방어를 걷어내고 테스트가 깨지는지 확인하는 것이 유일한 검증법이다.
9. **민감정보 컬럼은 Entity에 선언하지 않는 것이 안전하다** — TypeORM은 선언된 컬럼을 모든 `find`에서 SELECT하므로 응답·로그로 새어나갈 수 있다. 꼭 필요하면 `select: false`를 함께 쓴다 (`USERS.KAKAO_REFRESH_TOKEN`은 미선언 유지 결정).

## Rules
- **추측/추론 금지**: 항상 코드, 로그, DB 데이터 등 근거 기반으로 작업. 확인 불가한 사항은 추측하지 말고 사용자에게 확인 요청
- **필요 시 요청**: 정보가 부족하거나 판단이 어려운 경우 반드시 사용자에게 질문. 임의로 결정하지 않음
- 코드에 있는 그대로 보고 판단 (추론/추측 금지)
- **검증 시 grep 전수 확인 필수**: 변경된 함수/API 이름으로 프로젝트 전체 grep 후 호출 위치 전수 파악. 파일 부분 읽기(offset/limit)로 "전체 정상" 판단 금지. 특히 중복 API 호출, useEffect 간 중복 패턴 교차 비교
- **`git diff`로 변경 범위를 볼 때 pathspec `**` 금지** — 기본 pathspec은 `**`를 glob으로 해석하지 않아 `'src/**/*.ts'`가 **`src/` 직속 파일(app.module.ts·main.ts 등)을 건너뛴다**. 실측: 같은 커밋을 `'src/**/*.ts'`로 보면 1 file, `src/`로 보면 2 files(2026-08-12 D6 리뷰에서 `app.module.ts` 변경을 놓칠 뻔함). **`-- src/`(디렉토리)** 또는 **`-- ':(glob)src/**/*.ts'`**(glob 매직 명시)를 쓴다. "프로덕션 변경 0건" 같은 판정을 이 명령에 근거해 내리므로 누락이 곧 오판이다
- **커밋은 명시 지시 후에만** 실행한다 (auto mode에서도 자동 커밋 금지)

## Git & 커밋 컨벤션

- 형식: **`type(scope): 한국어 설명`** (Conventional Commits) — 실측 type: `feat`(25) `test`(18) `fix`(18) `docs`(16) `refactor`(4) `chore`(2)
  - scope는 도메인·모듈명: `team` `auth` `role` `entities` `e2e` `infra` `ci` `monitor`
  - 예: `fix(team): joinTeam의 인증 없음 폴백을 조기 차단으로 전환`
  - 예: `test(e2e): WS 팀 게이트웨이 실제 소켓 검증 (D6)`
- 한 커밋 = 한 의도. 포맷팅 전용 변경과 행위 변경을 섞지 않는다.
- **본문에 "왜"를 남긴다** — 제목이 "무엇"이면 본문이 "왜"다. `fix` 커밋 18건 전부 본문에 원인이 기재되어 있어 반복 결함 분류가 가능했다([playbook](docs/playbooks/recurring-issues-playbook.md) "판정 불가: 없음") — **이 상태를 유지한다**. 특히 revert는 본문에 원인 1줄 필수 (현재 revert 커밋 0건).
- **API 계약이 바뀌면 본문에 명시**한다 (상태코드·에러코드 변경 등) — 프론트 대응 필요 여부까지.

## Definition of Done (이 프로젝트)

글로벌 DoD(`~/.claude/CLAUDE.md`)에 더해 이 프로젝트에서 추가로 요구되는 항목:

1. **`pnpm ci:core` 통과** (= lint → test → build) — 에러 0건, **경고 수를 늘리지 않는다**(기준선은 [`README.md`](README.md#주요-명령어)). PR 직전에는 `pnpm ci:all`(+ 스텁 검사 + E2E)
2. **변경 심볼 grep 전수 확인** — 호출처를 빠뜨리지 않았음을 증거로 제시
3. **DB 변경이 있으면** 마이그레이션 파일 + Entity 수정을 세트로 제출. 실행은 담당자에게 요청하고, **실행 여부를 완료 조건에서 분리해 명시**
4. **인증이 필요해 검증 못 한 경로는 "미검증"으로 명시** — 빌드 통과를 동작 검증으로 포장하지 않는다
5. **Verification Story 1~2줄** — 무엇이 어떻게 바뀌었고 어떻게 확인했는가

## Deployment — 작업 시 알아야 할 것

스택 구성·노드·볼륨·서비스 DNS·이미지 태그는 [`docs/deploy.md`](docs/deploy.md)가 SSOT다. **코드를 쓸 때 지켜야 할 것만**:

- **멀티 레플리카 전제** (NestJS 3 replicas) — 인메모리 상태·타이머·스케줄러는 레플리카별로 중복 실행된다. 공유 상태는 Redis, 단일 실행이 필요한 작업은 `TASK_SLOT` 가드를 쓴다.


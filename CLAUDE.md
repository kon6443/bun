# FiveSouth Backend (NestJS)

NestJS 11 + TypeScript 백엔드. Oracle DB (TypeORM), Socket.IO + Redis Pub/Sub.

**문서 경계** — 같은 내용을 두 곳에 쓰지 않는다:

| 문서 | 담당 | 예시 |
|---|---|---|
| [`README.md`](README.md) | **사실·사용법** (What / How) — 사람·AI 공통 | 기술 스택, 모듈 구성, 명령어, 환경변수, 배포 구성 |
| **이 문서** | **규약·금지·함정·현재 상태** (Rules / Now) — AI 행동 지침 | 라우팅 표, 금지 사항, Pitfalls, DoD, Active Work |

사실 정보가 필요하면 여기에 복사하지 말고 README를 링크한다.

---

## 자동 라우팅 표 (MUST OBEY)

요청에서 아래 트리거가 매칭되면 **작업 시작 전에** 해당 문서를 `Read`한다. 둘 이상 매칭되면 모두 읽는다.

| 트리거 (요청 키워드 / 작업 성격) | 즉시 읽을 파일 |
|---|---|
| 구조 파악 · 신규 모듈 · 파일 위치 탐색 | `docs/architecture.md` |
| 배포 · Swarm · 스택 · 롤백 · 서버 운영 | `docs/deploy.md` |
| DB 스키마 변경 · 마이그레이션 · Entity 수정 | 이 문서 **DB Migrations** 섹션 + `docs/tasks/tasks-nestjs-improvements.md` D33/D34 |
| 테스트 작성 · 리팩터링 · 코드 품질 개선 | `docs/tasks/tasks-nestjs-improvements.md` (D2/D5 등 해당 태스크) |
| 에러 응답 · 도메인 에러 DTO · Swagger 에러 명세 | `docs/tasks/tasks-error-dto-refactor.md` |
| 실시간 채팅 · WS 이벤트 추가 | `docs/tasks/tasks-team-chat.md` |
| 메트릭 · Prometheus · Grafana | `docs/tasks/tasks-monitoring.md` |
| 로그 수집 · Loki · Promtail | `docs/tasks/tasks-logging.md` |
| Redis Pub/Sub · 멀티 레플리카 브로드캐스트 | `docs/prd-redis-pubsub.md` + `docs/tasks/tasks-redis-pubsub.md` |

**면제**: 단일 한 줄 수정, 단순 정보 조회, 1회성 명령 실행.

---

## Commands

명령어·환경변수 전체 목록은 [`README.md`](README.md)가 SSOT다. 작업 시 자주 쓰는 것만:

- 검증: `pnpm build` (tsc, `tsconfig.build.json`) · `pnpm lint` · `pnpm test` (현재 273/273 통과 — 실패가 보이면 내 변경 탓이다)
- 실행: `pnpm dev` → `localhost:3500/api/v1` · Swagger `/api/v1/docs` (LOCAL only)

## Key Patterns
- **응답 포맷**: `{ code, data, message }` — 전역 인터셉터 없음, 컨트롤러가 직접 반환 (`ApiSuccessResponseDto` 계열 DTO 상속)
- **에러**: `defineDomainError` 팩토리로 정의 후 throw → `HttpExceptionFilter`가 형식 통일
- **계층**: Repository 클래스 없음 — Service가 `@InjectRepository`로 직접 주입
- **인증**: Kakao OAuth + JWT — HTTP는 cookie `access_token` 우선 → Bearer 헤더 / WS는 `handshake.auth.token` → Bearer 헤더
- **ValidationPipe**: `transform: true`, `enableImplicitConversion: true`
- **Rate Limiting**: 글로벌 2단계 (초당 5회 + 분당 60회), 제외는 `@SkipThrottle()`
- **WS**: namespace `/teams`, room `team-{teamId}` — 멀티 레플리카는 Redis Pub/Sub
- **프론트엔드 프로젝트**: `../next-bun` (Next.js 15 App Router + Bun)

## Date/Time Handling
- UTC 저장, 로컬 표시 — DB 컬럼 전부 `TIMESTAMP WITH TIME ZONE`
- **ORA_SDTZ 설정 금지** — oracledb가 로컬 TZ 기반으로 Date를 저장하므로 세션 TZ는 자동 일치시켜야 함
- Oracle `FROM_TZ()`에 리전 이름(`'UTC'`) 금지 → 오프셋(`'+00:00'`) 사용 (ORA-01805 방지)

## DB Migrations — AI 행동 규칙

명령어·파일 규칙은 [`README.md`](README.md#db-마이그레이션) 참조. **여기서는 지켜야 할 것만 정의한다.**

- 🚫 **DB에 접속하는 명령을 직접 실행하지 않는다** — LOCAL/PROD가 동일 DB이므로 모든 `up`이 곧 상용 적용이다. `db:migrate:up/fake/revert`는 물론 **`list`도 첫 실행 시 이력 테이블을 생성**하므로 담당자에게 요청한다. AI는 **마이그레이션 파일 작성까지만**.
  - `.claude/settings.json` deny로 기술적 차단도 걸려 있으나, deny는 prefix 매칭이라 우회 변형(스크립트로 DataSource 직접 실행 등)까지 막지 못한다 → **이 행동 규칙이 우선**이다.
- 스키마 변경은 항상 **Entity 수정 + 마이그레이션 파일을 세트로** 제출한다 (드리프트 방지).
- 마이그레이션은 **멱등 작성**(`USER_TAB_COLUMNS` 등 존재 체크), **1개 = 1목적**, `down()` 필수(init 제외).
- 결정 이력·대조 결과: `docs/tasks/tasks-nestjs-improvements.md` D33/D34

## Common Pitfalls to Avoid

이 프로젝트에서 실제로 발생했거나 근거로 확인된 함정. 같은 실수를 반복하지 않기 위한 목록이다.

1. **`db:migrate:fake`는 베이스라인 등록 1회용** — pending 마이그레이션이 있는 상태에서 실행하면 DDL 실행 없이 기록만 되어 **조용히 미적용**된다. 평상시엔 `up`만 사용.
2. **Oracle DDL은 자동 커밋** — 마이그레이션이 중간에 실패하면 부분 적용 상태로 남는다. `migrationsTransactionMode`는 DDL에 무의미하므로 멱등 가드 + 1파일 1목적이 유일한 방어책.
3. **`migration:show`(=`db:migrate:list`)도 이력 테이블을 생성한다** — 읽기 전용이 아니다 (TypeORM `MigrationExecutor.showMigrations()`가 `createMigrationsTableIfNotExist()` 호출).
4. **Entity의 `nullable`/`length`/`default`는 런타임에 아무 효과가 없다** — `synchronize: false` + `migration:generate` 미사용이므로 스키마에 반영되는 경로가 없다. 표기는 "읽는 사람을 위한 문서"일 뿐이고, 실제 제약은 DB가 강제한다.
5. **PK 선언은 DB의 IDENTITY 종류와 맞춰야 한다** — `GENERATED ALWAYS AS IDENTITY` 컬럼에 명시 값을 INSERT하면 ORA-32795로 거부된다. `@PrimaryGeneratedColumn`을 써서 ID를 생략해야 한다 (예: `TASK_COMMENTS.COMMENT_ID`, `TEAM_TELEGRAM_LINKS.LINK_ID`).
6. **문자열 컬럼을 number 타입으로 선언하지 말 것** — Oracle이 컬럼 쪽을 숫자로 암묵 변환해 비교하므로, 비숫자 값이 한 건이라도 생기면 ORA-01722로 해당 기능 전체가 깨진다 (`USERS.KAKAO_ID`가 이 사례였음). 외부 API 값은 도메인 진입 경계에서 한 번만 변환한다.
7. **테스트는 현재 전부 통과한다 (38/38)** — 실패가 보이면 내 변경이 원인이다. ~~과거 20건 실패~~는 D2(2026-08-05)에서 해소됐고, 원인은 인프라가 아니라 **에러 DTO 리팩토링·`@CurrentUser` 전환 때 테스트를 함께 갱신하지 않은 것**이었다. 프로덕션 코드를 바꿀 때 그 코드를 검증하는 테스트도 같은 커밋에서 갱신한다.
8. **민감정보 컬럼은 Entity에 선언하지 않는 것이 안전하다** — TypeORM은 선언된 컬럼을 모든 `find`에서 SELECT하므로 응답·로그로 새어나갈 수 있다. 꼭 필요하면 `select: false`를 함께 쓴다 (`USERS.KAKAO_REFRESH_TOKEN`은 미선언 유지 결정).

## Rules
- **추측/추론 금지**: 항상 코드, 로그, DB 데이터 등 근거 기반으로 작업. 확인 불가한 사항은 추측하지 말고 사용자에게 확인 요청
- **필요 시 요청**: 정보가 부족하거나 판단이 어려운 경우 반드시 사용자에게 질문. 임의로 결정하지 않음
- 코드에 있는 그대로 보고 판단 (추론/추측 금지)
- **검증 시 grep 전수 확인 필수**: 변경된 함수/API 이름으로 프로젝트 전체 grep 후 호출 위치 전수 파악. 파일 부분 읽기(offset/limit)로 "전체 정상" 판단 금지. 특히 중복 API 호출, useEffect 간 중복 패턴 교차 비교
- **커밋은 명시 지시 후에만** 실행한다 (auto mode에서도 자동 커밋 금지)

## Definition of Done (이 프로젝트)

글로벌 DoD(`~/.claude/CLAUDE.md`)에 더해 이 프로젝트에서 추가로 요구되는 항목:

1. **`pnpm build` 통과** (tsc 에러 0건) + **`pnpm lint` 에러 0건** (경고는 기존 수준 유지)
2. **변경 심볼 grep 전수 확인** — 호출처를 빠뜨리지 않았음을 증거로 제시
3. **DB 변경이 있으면** 마이그레이션 파일 + Entity 수정을 세트로 제출. 실행은 담당자에게 요청하고, **실행 여부를 완료 조건에서 분리해 명시**
4. **인증이 필요해 검증 못 한 경로는 "미검증"으로 명시** — 빌드 통과를 동작 검증으로 포장하지 않는다
5. **Verification Story 1~2줄** — 무엇이 어떻게 바뀌었고 어떻게 확인했는가

## Deployment — 작업 시 알아야 할 것

스택 구성·노드·볼륨 등 전체는 [`docs/deploy.md`](docs/deploy.md)가 SSOT다. 코드 작업에 영향을 주는 부분만:

- **멀티 레플리카 전제** (NestJS 3 replicas) — 인메모리 상태·타이머·스케줄러는 레플리카별로 중복 실행된다. 공유 상태는 Redis, 단일 실행이 필요한 작업은 `TASK_SLOT` 가드를 쓴다.
- **서비스 간 DNS**: 백엔드 `prod_nest_app:3500` · 프론트 `prod_next_app:3000` · Redis `infra_redis:6379`
- **Caddyfile은 Git에 커밋하지 않는다** (공개 저장소 보안 정책 — 서버에서 직접 관리)
- 배포는 `main` push → CI/CD 자동. 이미지 태그는 git SHA 7자 (`latest` 없음)

## Active Work
- **팀 단위 실시간 채팅**: 백엔드+프론트 구현 완료 (저장 없음, 빌드/타입체크/코드리뷰 통과) — 수동 E2E·배포 대기. `docs/tasks/tasks-team-chat.md`
- **에러 DTO 리팩토링 (defineDomainError)**: ✅ 구현·검증·커밋 완료 (2026-07-22, 커밋 `73adc28`~`8b678c4`) — 잔여: 인증 필요 수동 E2E 2건 (팀 미존재 404, WS FORBIDDEN/CHAT_NOT_JOINED)
- **DB 마이그레이션 환경 (D33)**: ✅ 완료 (2026-07-23, 커밋 `169ee9a`) — init fake 등록 + TOKEN 확장 up 실행까지 검증
- **Entity↔DB 정합화 (D27/D34)**: ✅ 완료 (2026-07-31, 커밋 `f9d2a35`·`669e338`) — 배포 후 카카오 로그인·초대 생성/수락·댓글 생성 전부 검증
- **토큰 Unique Index (D23)**: ✅ 완료 (2026-08-05, 커밋 `02aefd8`·`4f0260c`) — jti 선행 수정 후 인덱스 2개 생성. 실측 확인 완료
- **테스트 인프라 (D2)**: ✅ 완료 (2026-08-05) — Factory(`src/entities/__spec__/entity.factory.ts`) + Mock 헬퍼(`src/common/__spec__/mock-repository.ts`) 표준 수립. 테스트 작성 시 이 둘을 반드시 사용한다
- **단위 테스트 (D5)**: 🔄 진행 중 — Phase A(Guard·Filter) + B(Auth·Scheduler) + C(권한 정책·초대·역할 변경) 완료 (2026-08-05, 커밋 `95faefe`~`c6affe0`, 273/273 통과, 커버리지 27.97%)
  - **▶ 다음 작업: C-2** (TeamService 태스크 상태·댓글 CRUD). **코드 조사가 끝나 있으므로 `docs/tasks/tasks-nestjs-improvements.md`의 "C-2 실행 계획"을 먼저 읽을 것** — 검증할 계약이 메서드:줄 단위로 정리돼 있어 team.service.ts(1,520줄)를 다시 훑을 필요가 없다
  - 테스트 작성 시 반드시 기존 표준 사용: Factory `src/entities/__spec__/entity.factory.ts`, Mock `src/common/__spec__/mock-repository.ts`. spec은 도메인별 분리(`team.service.<도메인>.spec.ts`)

## Docs

```
docs/
├── architecture.md          # 아키텍처 & 주요 파일 (구조 파악 기준)
├── deploy.md                # 배포 & 인프라
├── prd-redis-pubsub.md      # Redis Pub/Sub PRD
└── tasks/                   # 진행 중 태스크
    ├── tasks-nestjs-improvements.md   # NestJS 고도화 (D1~D34, 진행률 27/50)
    ├── tasks-error-dto-refactor.md    # 에러 DTO (구현 완료, E2E 2건 잔여)
    ├── tasks-team-chat.md             # 실시간 채팅 (구현 완료, E2E·배포 대기)
    ├── tasks-redis-pubsub.md          # Redis Pub/Sub (구현 완료, 검증 잔여)
    ├── tasks-monitoring.md            # Prometheus + Grafana + node_exporter
    ├── tasks-logging.md               # Loki + Promtail (Step 1~5 배포 완료)
    └── archive/                       # 완료 태스크
        └── tasks-swarm-stack-migration.md   # ✅ 완료 (2026-04-18)
```

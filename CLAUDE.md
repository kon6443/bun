# FiveSouth Backend (NestJS)

NestJS + TypeScript 백엔드. Oracle DB (TypeORM), Socket.IO + Redis Pub/Sub. 버전은 [`README.md`](README.md) 기술 스택.

**문서 경계** — 같은 내용을 두 곳에 쓰지 않는다:

| 문서 | 담당 | 예시 |
|---|---|---|
| [`README.md`](README.md) | **사실·사용법** (What / How) — 사람·AI 공통 | 기술 스택, 모듈 구성, 명령어, 환경변수, 배포 구성, **문서 목록** |
| **이 문서** | **규약·금지·라우팅** (Rules) — AI 행동 지침 | 라우팅 표, 금지 사항, DoD, 커밋 컨벤션 |
| [`.claude/rules/*.md`](.claude/rules/) | **파일 종류별 코드 규약** — 해당 파일을 읽으면 자동 로드 | 계층·HTTP·데이터 접근·날짜·실시간·스키마·테스트 |
| [`docs/playbooks/`](docs/playbooks/) · [`docs/lessons.md`](docs/lessons.md) | **결함 진단 · 작업 교훈** | 반복 결함 클러스터, 교정 이력 |
| [`docs/tasks/`](docs/tasks/) | **진행 상황·이력·결정 근거** (Status / Why) | 상태, 커밋 해시, 잔여 항목, 판정 근거 |

**이 문서에는 규칙과 문서 경로만 둔다.** 진행 상황·완료 이력·수치·날짜·커밋 수·태스크 ID는 쓰지 않는다 — 두 곳에 두면 반드시 어긋난다. 근거가 필요하면 태스크 문서·lessons에 쓰고 여기서는 경로만 가리킨다.

---

## 세션 운영 — 백·프 2세션 체제 (상시 적용, 사용자가 따로 말하지 않아도)

- **이 레포 세션(백엔드)이 메인이다.** 사용자는 메인과만 소통한다 — 프론트 요청도 메인이 받아 프론트 세션에 전달하고, 프론트 세션의 보고·질문은 메인이 요약해 사용자에게 전달한다.
- **역할 경계**: 백엔드 작업·코드 읽기는 메인, 프론트(`../next-bun`) 작업·코드 읽기·조사·리뷰 루프는 **프론트 세션**. 메인은 프론트 소스를 읽거나 고치지 않고 프론트 리뷰 서브에이전트를 띄우지 않는다. 프론트가 API·소켓을 어떻게 쓰는지는 프론트 세션에 질의한다 — 답은 `파일:라인 + 인용`, 정확성은 답한 세션 책임. 프론트 앱을 띄워 브라우저로 확인하는 최종 검증(Playwright)은 소스 읽기가 아니라 메인의 몫이다.
- **메인의 몫**: 요청 라우팅 · 태스크 문서(SSOT) 작성·관리(어느 레포에 있든) · 사용자 질문·결정 중계 · 양쪽 결과 대조 · 최종 검증(build·실제 API·Playwright) · 보고.
- **세션 찾기**: 직접 탐색하지 않는다(`ListAgents`로 고르지 않는다). 태스크 폴더 STATUS의 "세션·브랜치" 표에 있으면 그 세션으로, 없으면 사용자에게 어느 세션인지 묻는다. 프론트 세션이 없으면 사용자에게 새 프론트 세션을 열어 달라고 요청한다. 정해진 세션은 STATUS 표에 기록하고, 바뀌면 갱신한다.
- **소통**: `SendMessage`로 지시(작업 위치·범위·완료 기준·보고 형식 포함)하고, 완료 대기는 `notify_when_idle`로 받는다.

## 자동 로드되는 것 (읽으라고 지시하지 않는다)

- `.claude/rules/*.md` — 파일 종류별 규약. `src/`의 `.ts`를 읽으면 `core.md`(rule 지도 포함)와 그 파일 종류의 rule이 로드된다. 코드를 아직 안 연 설계 단계엔 아래 Key Patterns를 보고, 상세가 필요하면 해당 rule을 직접 Read한다
- 스킬 `next-bun` — 프론트가 API·소켓을 어떻게 쓰는지 알아야 하는 **설계 단계**에 발동해 프론트 세션 질의 양식을 안내한다

## 문서 라우팅 — 자동 로드되지 않는 문서

요청에서 아래 트리거가 매칭되면 **작업 시작 전에** 해당 문서를 `Read`한다. 둘 이상 매칭되면 모두 읽는다. 대화 상황(버그·교정·배포 등)으로만 판단할 수 있어 경로로 자동 로드할 수 없는 문서만 둔다. 큰 태스크 문서는 통째로 읽지 말고 `grep -n "^## "`로 목차를 본 뒤 필요한 절만 읽는다.

| 트리거 (요청 키워드 / 작업 성격) | 즉시 읽을 파일 |
|---|---|
| **버그 · 장애 · 에러 · 회귀 · "안 됨" 조사** | `docs/playbooks/recurring-issues-playbook.md` — 반복 결함 클러스터별 **최우선 확인 지점**부터 진단 |
| 대규모 리팩터링·마이그레이션 **착수 전** · 사용자 교정 **직후** | `docs/lessons.md` — 작업 방식의 누적 교훈 (검토 후 새 교훈은 append) |
| 세션 재개 · `/compact` **직후** 맥락 복구 | `docs/handoff/` 최신 스냅샷 — PreCompact 훅이 남긴 핸드오프(세션 작업 디렉토리 기준이라 worktree에서 compact했으면 그 worktree 안에 있다 — worktree를 지우기 전에 옮긴다). 없으면 생략 |
| 구조 파악 · 신규 모듈 · 파일 위치 탐색 | `README.md` "아키텍처 개요" + `docs/architecture.md` |
| Claude 설정 · 훅 · 권한 규칙 · 2세션 운영 | `docs/tasks/tasks-claude-config.md` (두 레포 공통 이력) + `docs/tasks/claude-config-audit/STATUS.md` + `docs/tasks/claude-sessions-2026-10/STATUS.md`. 권한 deny를 추가하면 **탐침으로 반드시 시험**한다 |
| 팀 태그 · 태스크 태그 · 태그 알림 | `docs/tasks/team-task-tags/STATUS.md` |
| 사용자 피드백 · 내 피드백 | `docs/tasks/feedback/STATUS.md` |
| 배포 · Swarm · 스택 · 롤백 · 서버 운영 | `docs/deploy.md` |
| DB 스키마 변경 · 마이그레이션 · Entity 수정 (설계 단계) | `.claude/rules/schema-migrations.md` + `docs/tasks/tasks-nestjs-improvements.md`에서 `grep -n 'DB 마이그레이션\|Entity↔DB'`로 찾은 절 |
| 테스트 작성 · 리팩터링 · 코드 품질 개선 | `docs/tasks/tasks-nestjs-improvements.md` (해당 태스크 절) |
| 에러 응답 · 도메인 에러 DTO · Swagger 에러 명세 | `docs/tasks/tasks-error-dto-refactor.md` |
| 카카오 로그인 지연 · 인증 성능 · next-auth 관련 조사 | `docs/tasks/tasks-kakao-login-latency.md` — 재조사 전에 현재 결론부터 읽는다 |
| 실시간 채팅 · WS 이벤트 추가 | `docs/tasks/tasks-team-chat.md` · 채팅 저장·읽음 표시는 `docs/tasks/team-chat-persistence/STATUS.md` |
| 메트릭 · Prometheus · Grafana | `docs/tasks/tasks-monitoring.md` |
| 로그 수집 · Loki · Promtail | `docs/tasks/tasks-logging.md` |
| Redis Pub/Sub · 멀티 레플리카 브로드캐스트 | `docs/prd-redis-pubsub.md` + `docs/tasks/tasks-redis-pubsub.md` |

**면제**: 단일 한 줄 수정, 단순 정보 조회, 1회성 명령 실행.

---

## 작업 경계: Never / Ask — 상시 적용

문맥에서 승인을 유추하지 않는다. **의심되면 멈추고 물어본다.**

### Never — 어떤 경우에도 하지 않는다

| 금지 | 이유 |
|---|---|
| **DB에 접속하는 명령 실행** — `db:migrate:up`/`fake`/`revert`/**`list`**, `sqlplus`, DataSource·드라이버를 직접 여는 스크립트(`tsx`·`node` 포함) | **LOCAL과 PROD가 동일 DB** — 모든 `up`이 곧 상용 적용. `list`조차 첫 실행 시 이력 테이블을 생성한다. AI는 **파일 작성까지만**. `.claude/settings.json` deny는 Claude Code가 인식하는 명령만 막고 스크립트 내부의 DB 연결은 못 막는다 — 이 행동 규칙이 최후 방어선이다. **예외 2개만**: ① 읽기 전용 조회 **`pnpm db:select '<SELECT>'`** — 허가 없이 실행한다(단일 SELECT·WITH 가드 + READ ONLY 트랜잭션 + 행 상한·민감 컬럼 가림, `scripts/db-select.ts`). 다른 경로로 조회 스크립트를 만들지 않는다 ② 로컬 실행 `pnpm dev`(부팅 시 접속) — 사용자 지시가 있을 때. **근거의 유효기간**: LOCAL과 PROD의 DB가 분리되면 재검토한다 |
| `db:migrate:fake`를 평상시 사용 | pending이 있는 상태면 DDL 없이 기록만 되어 **조용히 미적용** |
| Caddyfile을 Git에 커밋 · 설정 파일·커밋 문서에 회사명·무관한 타 프로젝트명 기입 | 공개 저장소 — 도메인·IP·조직 정보 노출. 짝 레포 `next-bun` 참조만 허용 |
| 시크릿(JWT_SECRET·wallet·봇 토큰)을 코드·로그·응답·문서에 기입 | 커밋 이력에 영구 보존된다 |
| `ORA_SDTZ` 설정 · Oracle `FROM_TZ()`에 리전 이름(`'UTC'`) | 상세는 `.claude/rules/datetime.md` |
| E2E에서 `AppModule` import | `TypeOrmModule`이 **부팅만으로 상용 DB에 붙는다** — `createE2eApp()`을 쓴다 |
| 인메모리 변수·타이머로 공유 상태 관리 | 여러 레플리카로 뜬다 — 레플리카별로 중복 실행된다. Redis + `TASK_SLOT` 가드 |
| `any` · `@ts-ignore` 등 타입 억제 | 글로벌 `engineering.md` §3 |

### Ask — 실행 전 반드시 사용자 승인

| 확인 대상 | 비고 |
|---|---|
| 커밋 · 푸시 · 머지 · 리베이스 · 태그 | **사용자 지시 없이는 하지 않는다(auto mode 포함)**. `main` push는 곧 자동 배포다 |
| 배포 · 원격·운영에 닿는 `docker`(stack·service·context·push 등) · `ssh`/`scp` | 운영 서버 영향. 로컬 docker는 조회(ps·images·logs·inspect·version·info·compose ps/logs)만 확인 없이 쓴다 — run·exec·rm·build·compose up/down/build와 `-c`/`--context`/`-H`·`DOCKER_HOST`/`DOCKER_CONTEXT` 접두가 붙은 명령은 확인(호스트 마운트·빌드 컨텍스트·`-o` 출력으로 sandbox 우회 가능) |
| 파일·디렉토리 삭제, 비가역 변경 | |
| **마이그레이션 실행 요청** | 파일 작성은 AI, 실행은 담당자 — 완료 조건에서 분리해 명시한다 |
| **API 계약 변경** (상태코드·에러코드) | 프론트 대응 필요 여부는 프론트 세션에 확인하고 커밋 본문에 명시 |
| 새 의존성 추가 | 기존 스택으로 안 풀리는지 먼저 확인 |
| 외부로 발송되는 알림 경로 변경 (Telegram·Discord) | 실제 사용자에게 도달한다 |

---

## Commands

명령어·환경변수 전체 목록과 테스트 기준선은 [`README.md`](README.md#주요-명령어)가 SSOT다. 작업 시 자주 쓰는 것만:

- 검증: **`pnpm ci:core`**(lint → test → build) · PR 직전 **`pnpm ci:all`**(+ 스텁 검사 + E2E). 개별 실행은 `pnpm build`·`pnpm lint`·`pnpm test`·`pnpm test:e2e`
  - **테스트는 전부 통과하는 상태가 기준선이다 — 실패가 보이면 내 변경 탓이다**
  - ⚠️ Claude Code **sandbox 안에서는 E2E가 `listen EPERM`으로 대량 실패**한다(테스트 서버가 포트를 못 연다) — 코드 회귀가 아니다. sandbox 밖에서 다시 돌려 판정한다
  - ⚠️ 부분 실행은 `--testPathPatterns`(복수형) — 단수형 `--testPathPattern`은 현재 jest가 거부한다
- 실행: `pnpm dev` → `/api/v1` · Swagger `/api/v1/docs` (LOCAL only, 포트는 README)
- 조회: `pnpm db:select '<SELECT …>'` — 읽기 전용, 허가 불필요(Never 표 예외). SQL은 작은따옴표로 감싼다 — 문자열 리터럴이 있으면 큰따옴표로 감싼다(`$` 주의)

## Key Patterns — 설계 단계 요약

> 코드를 열기 전 설계·계획 단계용 요약이다. 상세는 `.claude/rules/`의 해당 rule이 SSOT다(파일을 읽으면 자동 로드).

- **계층**: Repository 클래스 없음 — Service가 `@InjectRepository`로 직접 주입 (`core.md`·`data-access.md`)
- **응답**: `{ code, data, message }` 객체 리터럴을 컨트롤러가 직접 반환, 전역 인터셉터 없음. `ApiSuccessResponseDto` 상속 DTO는 Swagger 명세용 타입 전용 (`api-http.md`)
- **에러**: `defineDomainError`로 정의 후 throw → `HttpExceptionFilter`가 `{ code, message, timestamp }`로 통일, `statusCode` 필드 없음 (`api-http.md`)
- **인증/인가**: HTTP는 cookie `access_token` → Bearer, WS는 `handshake.auth.token` → Bearer. 전역 **인증** Guard 없음(전역은 스로틀러뿐) — 라우트마다 부착. **Guard는 인증까지만, 팀 멤버십·역할은 서비스/컨트롤러가 직접 검증**(반복 누락 지점) (`api-http.md`)
- **검증**: 전역 ValidationPipe(`whitelist`·**`forbidNonWhitelisted`**·`transform`·암묵 변환) 설정은 `src/common/pipes/global-validation-pipe.ts` 한 곳, E2E와 공유 (`api-http.md`)
- **스로틀**: 전역 2단계 + 로그인 라우트 강화, 한도는 `src/common/constants/throttle.constants.ts`. 제외는 `@SkipThrottle()` (`api-http.md`)
- **트랜잭션**: `dataSource.transaction(async (manager) => ...)` 콜백만 — `@Transactional`·`queryRunner`는 도입이 결정되기 전까지 쓰지 않는다 (`data-access.md`)
- **날짜**: UTC 저장, 표시 시점에만 로컬 변환, 시각 컬럼은 `timestamp with time zone` (`datetime.md`)
- **WS**: namespace `/teams`·`/fishing`, room `team-{teamId}`, 멀티 레플리카는 Redis 어댑터, 온라인 상태는 Redis (`realtime-ws.md`)
- **스키마**: Entity + 마이그레이션 세트, 멱등·1파일 1목적·`down()` (`schema-migrations.md`)
- **테스트**: mock Repository + factory, 실제 DB 연결 없음, 에러 경로는 status·code 정확 고정 (`testing.md`)
- **멀티 레플리카**: 공유 상태는 Redis, 단일 실행 작업은 `TASK_SLOT` 가드 (`core.md`·`data-access.md`)

## Rules

- **근거 기반**: 코드·로그·데이터에 있는 그대로 보고 판단한다. 확인할 수 없는 것은 추측하지 말고 사용자에게 묻는다
- **검증 시 grep 전수 확인 필수**: 변경된 함수/API 이름으로 프로젝트 전체를 grep해 호출 위치를 전부 파악한다. 파일 부분 읽기(offset/limit)로 "전체 정상"이라 판단하지 않는다
- **`git diff`로 변경 범위를 볼 때 pathspec `**` 금지** — 기본 pathspec은 `**`를 glob으로 해석하지 않아 `'src/**/*.ts'`가 **`src/` 직속 파일(app.module.ts·main.ts 등)을 건너뛴다**. **`-- src/`(디렉토리)** 또는 **`-- ':(glob)src/**/*.ts'`**를 쓴다. "프로덕션 변경 없음" 같은 판정을 이 명령에 근거해 내리므로 누락이 곧 오판이다

## Git & 커밋 컨벤션

- 형식: **`type(scope): 한국어 설명`** (Conventional Commits) — type: `feat` `fix` `test` `docs` `refactor` `chore`
  - scope는 도메인·모듈명: `team` `auth` `role` `entities` `e2e` `infra` `ci` `monitor` `claude`
  - 예: `fix(team): joinTeam의 인증 없음 폴백을 조기 차단으로 전환`
- **본문에 "왜"를 남긴다** — `fix`는 원인을, revert는 되돌리는 원인 1줄을 반드시 쓴다. 반복 결함 분류(playbook)가 이 본문에 의존한다
- **API 계약이 바뀌면 본문에 명시**한다 (상태코드·에러코드 변경 등) — 프론트 대응 필요 여부까지

## Definition of Done (이 프로젝트)

글로벌 DoD(`~/.claude/CLAUDE.md`)에 더해:

1. **`pnpm ci:core` 통과** — 에러 0건, **경고 수를 늘리지 않는다**(기준선은 [`README.md`](README.md#주요-명령어)). PR 직전에는 `pnpm ci:all`
2. **변경 심볼 grep 전수 확인** — 호출처를 빠뜨리지 않았음을 증거로 제시
3. **DB 변경이 있으면** 마이그레이션 파일 + Entity 수정을 세트로 제출. 실행은 담당자에게 요청하고, **실행 여부를 완료 조건에서 분리해 명시**
4. **인증이 필요해 검증 못 한 경로는 "미검증"으로 명시** — 빌드 통과를 동작 검증으로 포장하지 않는다
5. **결정이 바뀌면 코드보다 태스크 문서를 먼저 고친다** — 진행 상황·결정 근거의 SSOT는 `docs/tasks/`다
6. **남은 항목은 게이트로 분류해 보고한다** — 코드 결함과 배포 환경 의존성을 섞지 않는다. 코드 수정 항목은 게이트로 분류하지 말고 고쳐서 같은 작업에 담는다
   - **머지 전 차단**: 미충족 상태로 배포하면 장애 (예: 마이그레이션 미실행 상태의 Entity 변경, 스택 YAML·시크릿 미반영)
   - **배포 직후 조치**: 머지는 가능하나 배포하면 즉시 해야 함 (예: 담당자의 마이그레이션 실행, 기능 플래그 활성화)
   - **후속**: 품질·일관성 — 별건으로 태스크 문서에 등재

## Deployment — 작업 시 알아야 할 것

스택 구성·노드·볼륨·서비스 DNS·이미지 태그·레플리카 수는 [`docs/deploy.md`](docs/deploy.md)가 SSOT다. 코드 쪽 전제는 Key Patterns "멀티 레플리카".

# FiveSouth Backend

팀 협업 앱의 NestJS 백엔드. 팀·태스크·댓글 관리와 Socket.IO 실시간 동기화를 제공한다.

> AI 에이전트용 작업 규약은 [`CLAUDE.md`](CLAUDE.md)가 진입점이다. [AI Assistant 가이드](#ai-assistant-가이드) 참조.

## 목차

- [프로젝트 맵](#프로젝트-맵)
- [기술 스택](#기술-스택)
- [아키텍처 개요](#아키텍처-개요)
- [개발 환경 설정](#개발-환경-설정)
- [주요 명령어](#주요-명령어)
- [DB 마이그레이션](#db-마이그레이션)
- [API 문서](#api-문서)
- [배포 및 인프라](#배포-및-인프라)
- [AI Assistant 가이드](#ai-assistant-가이드)

## 프로젝트 맵

| 프로젝트 | 스택 | 역할 |
|---|---|---|
| **`bun`** (이 저장소) | NestJS 11 + TypeScript | 백엔드 API + WebSocket 서버 |
| `../next-bun` | Next.js 15 App Router + Bun | 프론트엔드 |

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| 프레임워크 | NestJS 11 (Express 어댑터) |
| 언어 | TypeScript 5.7 (strict) |
| DB | Oracle (TypeORM 0.3, `synchronize: false`) |
| 실시간 | Socket.IO + Redis Pub/Sub (`@socket.io/redis-adapter`) |
| 인증 | Kakao OAuth + JWT |
| 로깅 | Pino (nestjs-pino, 민감정보 마스킹) |
| 모니터링 | Prometheus (`prom-client`, `/api/v1/metrics`) |
| 보안·성능 | helmet, compression, `@nestjs/throttler` |
| 문서화 | Swagger (`@nestjs/swagger`) |
| 패키지 매니저 | pnpm 8 |

## 아키텍처 개요

### 요청 처리 흐름

```
클라이언트
  → helmet / compression / cookie-parser
  → ThrottlerGuard (글로벌: 초당 5회 + 분당 60회)
  → JwtAuthGuard (cookie `access_token` 우선 → Bearer 헤더)
  → Controller (globalPrefix `/api/v1`)
  → ValidationPipe (transform, enableImplicitConversion)
  → Service → TypeORM Repository → Oracle
  → 응답 `{ code, data, message }`
  ※ 에러는 HttpExceptionFilter가 도메인 에러 DTO 형식으로 통일
```

WebSocket은 namespace `/teams`, room `team-{teamId}` 기준. 인증은 `handshake.auth.token` → Bearer 헤더 순으로 확인하며, 멀티 레플리카 브로드캐스트는 Redis Pub/Sub이 담당한다.

### 모듈 구성

| 모듈 | 라우트 | 역할 |
|---|---|---|
| `team` | `/teams` | 팀·태스크·댓글·초대 CRUD, TeamGateway(실시간), OnlineUserService |
| `auth` | `/auth` | Kakao OAuth 로그인/회원가입, JWT 발급 |
| `users` | `/users` | 프로필 조회·수정 |
| `notification` | `/telegram` | Telegram 봇 webhook, Discord webhook 알림 |
| `file-share` | `/files` | API Key 기반 파일 공유 |
| `fishing` | — | FishingGateway (실시간 맵/위치) |
| `scheduler` | — | Cron (태스크 자동 아카이브) |
| `main` | `/`, `/health-check` | 루트, 헬스체크 (`@nestjs/terminus` DB ping) |

`src/common/`에 횡단 관심사가 모여 있다 — `guards`, `filters`, `decorators`, `adapters`(RedisIoAdapter), `port`(Port/Adapter), `metrics`, `logger`, `constants`, `enums`, `dto`, `utils`.

### 주요 테이블

`USERS`, `TEAMS`, `USER_TEAMS`, `TEAM_TASKS`, `TASK_COMMENTS`, `TEAM_INVITATIONS`, `TEAM_TELEGRAM_LINKS`, `FILE_SHARES`

## 개발 환경 설정

### 사전 요구사항

- Node.js + pnpm 8 (`packageManager` 필드 기준)
- Oracle Instant Client — thick 모드로 동작하므로 wallet 접속에 필요
- Redis — 실시간 프레즌스용. 없어도 HTTP API는 정상 기동한다

### 설치 및 실행

```bash
pnpm install
pnpm dev          # watch 모드 → http://localhost:3500/api/v1
```

### 로컬 Redis 실행

WebSocket 온라인 상태(프레즌스)와 멀티 레플리카 브로드캐스트에 쓰인다. **없어도 HTTP API는 정상 기동**하며 WS 프레즌스만 동작하지 않는다.

```bash
# 운영과 동일 이미지로 띄우기
docker run -d --name bun-redis -p 6379:6379 redis:7-alpine

# 연결 확인 (PONG 이 나와야 한다)
docker exec -it bun-redis redis-cli ping

# 앱이 만든 키 확인 (팀 입장 후)
docker exec -it bun-redis redis-cli KEYS '*'
#   socket:*  ·  team:*:online  ·  team:*:user:*:sockets

# 종료 / 정리
docker stop bun-redis && docker rm bun-redis
```

- 접속 정보 기본값은 `localhost:6379`이므로(`src/common/adapters/redis-io.adapter.ts`) `.env`에 `REDIS_HOST`를 안 넣어도 로컬에서는 붙는다. `REDIS_PORT`는 검증 대상 필수 변수다.
- 운영(`infra_redis`)은 `--appendonly yes --maxmemory 128mb --maxmemory-policy allkeys-lru`로 뜬다 — 영속성·축출 정책까지 재현하려면 같은 옵션을 붙인다.
- Redis를 끈 상태로 앱을 띄우면 경고 로그만 남고 기동은 성공해야 한다. 이 동작 자체가 검증 항목이다.

### 환경 변수

`.env`를 프로젝트 루트에 둔다. 부팅 시 `src/config/env.validation.ts`가 검증하며 누락 시 앱이 시작되지 않는다.

**검증 대상(필수)**: `ENV`, `EXPRESS_PORT`, `JWT_SECRET`, `LOG_LEVEL`, `NEXT_PUBLIC_DOMAIN`, `ORACLE_DB_USER`, `ORACLE_DB_PW`, `ORACLE_DB_CONNECT_STR`, `REDIS_PORT`

**그 외 사용 변수**: `ORACLE_WALLET_PATH`, `ORACLE_LIB_DIR`(Oracle thick client), `REDIS_HOST`, `JWT_ACCESS_TOKEN_EXPIRES_IN`, `BOT_TOKEN_TELEGRAM`, `BOT_USERNAME_TELEGRAM`, `TASK_SLOT`(스케줄러 단일 실행 보장)

> ⚠️ **LOCAL과 PROD가 동일한 Oracle DB를 공유한다.** 로컬에서 실행하는 쿼리가 곧 상용 데이터에 영향을 준다.

## 주요 명령어

```bash
# 개발
pnpm dev                 # watch 모드 (nest start --watch)
pnpm dev:tsx             # tsx watch (빠른 재시작)

# 빌드 / 실행
pnpm build               # tsc → dist/
pnpm start:prod          # node dist/main.js

# 코드 품질
pnpm lint                # eslint (flat config)
pnpm lint:fix

# 테스트
pnpm test                # jest (단위 테스트)
pnpm test:e2e            # E2E (test/jest-e2e.json, DB 없이 HTTP 파이프라인)
pnpm test:cov            # 커버리지

# 부분 테스트 (전체 대신 좁혀 돌릴 때)
pnpm test -- src/common/constants/role.constants.spec.ts   # 단일 파일 (경로 직접 전달)
npx jest --testPathPatterns=team                           # 패턴 매칭 (jest 30: 복수형)
pnpm test:e2e -- team-gateway                              # E2E 부분 실행

# 통합 검증 (푸시 전 필수 — 아래 ⚠️ 참조)
pnpm ci:core             # lint → test → build (빠른 검증)
pnpm ci:all              # lint → 스텁 검사 → test → test:e2e → build (PR 전 최종)
pnpm check:stubs         # TODO/FIXME/XXX/HACK + describe/it/test.only 검출 (발견 시 실패)
```

> ⚠️ **CI 파이프라인은 lint·test·E2E를 실행하지 않는다.** `deploy-to-oci.yml`은 docker build → push → ssh deploy만 하고, `Dockerfile`도 `pnpm install` 후 `pnpm run build`만 돌린다. 즉 **테스트를 통과시키는 관문은 로컬의 `pnpm ci:all`이 유일하다** — `main` push는 검증 없이 배포로 직행한다.
>
> `pnpm ci:all` 기준선(2026-08-12 실측): lint 0 errors / 경고 7건, 스텁 0건, 단위 **639/639**, E2E **79/79**, build 통과.
> ⚠️ `--testPathPattern`(단수형)은 jest 30에서 동작하지 않는다 — `--testPathPatterns`(복수형)를 쓴다.

## DB 마이그레이션

TypeORM 마이그레이션을 사용한다. 런타임 설정(`src/config/database.config.ts`)과 **분리된** CLI DataSource(`migration-datasource.ts`)로 동작하며, 앱은 시작 시 마이그레이션을 실행하지 않는다(`migrationsRun: false` — Swarm 멀티 레플리카 동시 기동 시 중복 실행 방지).

```bash
pnpm db:migrate:create <Name>   # 빈 마이그레이션 파일 생성 (DB 접속 없음)
pnpm db:migrate:up              # 적용
pnpm db:migrate:revert          # 되돌리기
pnpm db:migrate:list            # 적용 상태 확인
pnpm db:migrate:fake            # 베이스라인 등록 전용 (1회성)
```

- 이력 테이블: `TYPEORM_MIGRATIONS` · 파일: `migrations/<timestamp>-PascalCase.ts`
- **작성 규칙**: 멱등 작성(Oracle DDL은 자동 커밋이라 실패 시 부분 적용됨), 1개 = 1목적, `down()` 필수(init 제외)
- **스키마 변경은 항상 Entity 수정 + 마이그레이션 파일 세트로** — 드리프트 방지
- ⚠️ LOCAL/PROD 동일 DB이므로 **DB에 접속하는 명령은 담당자가 직접 실행**한다 (`.claude/settings.json`의 deny로 기술적 차단)
- ⚠️ `db:migrate:fake`는 pending이 있는 상태에서 실행하면 DDL 없이 기록만 되어 **조용히 미적용**된다 — 평상시엔 `up`만 사용

상세: [`docs/tasks/tasks-nestjs-improvements.md`](docs/tasks/tasks-nestjs-improvements.md) D33/D34

## API 문서

Swagger UI: `http://localhost:3500/api/v1/docs` — **LOCAL 환경에서만 활성**.

응답 포맷은 `{ code, data, message }`로 통일되어 있고, 에러는 `defineDomainError` 팩토리로 정의한 도메인 에러 DTO를 사용한다.

## 배포 및 인프라

Docker Swarm 기반. `main` 브랜치 push 시 GitHub Actions가 빌드 후 배포한다.

| 스택 | 구성 |
|---|---|
| `infra` | caddy + redis + registry |
| `prod_nest` | NestJS (3 replicas) — DNS `prod_nest_app:3500` |
| `prod_next` | Next.js (10 replicas) — DNS `prod_next_app:3000` |

- 이미지 태그는 git SHA 7자 (`latest` 없음), 배포는 `docker stack deploy`로 통일
- 배포 서버: fs-01 (ARM64, Manager) / fs-02 (registry) / fs-03 (모니터링)
- Caddyfile은 서버에서 직접 관리한다 (공개 저장소 보안 정책 — Git 커밋 안 함)

상세: [`docs/deploy.md`](docs/deploy.md)

## AI Assistant 가이드

AI 에이전트용 작업 규약은 [`CLAUDE.md`](CLAUDE.md)가 진입점(SSOT)이다. 사람·AI 공통 참고 문서:

| 문서 | 담당 |
|---|---|
| **[코드 패턴](docs/conventions/code-patterns.md)** | 계층·DB·트랜잭션·에러·인증·응답·테스트 규약 SSOT (실측 카운트 병기) — `src` 작업 전 필독 |
| **[반복 이슈 플레이북](docs/playbooks/recurring-issues-playbook.md)** | 결함 클러스터별 최우선 확인 지점 — 버그·장애 조사 진입점 |
| **[교훈 로그](docs/lessons.md)** | 작업 방식의 누적 교훈 — 리팩터링 착수 전·교정 직후 |
| **[배포 & 인프라](docs/deploy.md)** | Swarm 스택, 노드, 볼륨, CI/CD |
| **[태스크 문서](docs/tasks/)** | 태스크별 상태·이력·결정 근거 (완료분은 [`archive/`](docs/tasks/archive/)) |
| [아키텍처 & 주요 파일](docs/architecture.md) | ⚠️ **날짜 처리 섹션은 폐기된 옛 정책**이다 — 모듈 구성은 위 "아키텍처 개요"가 정확하다 |
| [Redis Pub/Sub PRD](docs/prd-redis-pubsub.md) · [API 스로틀링 가이드](docs/blog-api-throttling.md) | 배경 문서 (후자는 외부 발행용 초안, 프로젝트 규약 아님) |

**프로젝트를 처음 접하는 사람/AI는:**

1. 이 README로 전체 그림 파악 (프로젝트 맵, 아키텍처, 배포)
2. `CLAUDE.md`의 자동 라우팅 표에서 작업 유형에 맞는 문서 확인
3. 작업 시 기존 코드 패턴과 컨벤션을 우선적으로 따름

## 라이선스

UNLICENSED

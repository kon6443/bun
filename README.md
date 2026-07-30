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
pnpm test                # jest
pnpm test:cov            # 커버리지
```

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
| `prod_next` | Next.js (20 replicas) — DNS `prod_next_app:3000` |

- 이미지 태그는 git SHA 7자 (`latest` 없음), 배포는 `docker stack deploy`로 통일
- 배포 서버: fs-01 (ARM64, Manager) / fs-02 (registry) / fs-03 (모니터링)
- Caddyfile은 서버에서 직접 관리한다 (공개 저장소 보안 정책 — Git 커밋 안 함)

상세: [`docs/deploy.md`](docs/deploy.md)

## AI Assistant 가이드

AI 에이전트용 작업 규약은 [`CLAUDE.md`](CLAUDE.md)가 진입점(SSOT)이다. 사람·AI 공통 참고 문서:

- **[아키텍처 & 주요 파일](docs/architecture.md)** — 구조 파악의 기준
- **[배포 & 인프라](docs/deploy.md)** — Swarm 스택, 운영
- **[진행 중 태스크](docs/tasks/)** — 작업별 체크리스트와 결정 기록 (완료분은 [`docs/tasks/archive/`](docs/tasks/archive/))

**프로젝트를 처음 접하는 사람/AI는:**

1. 이 README로 전체 그림 파악 (프로젝트 맵, 아키텍처, 배포)
2. `CLAUDE.md`의 자동 라우팅 표에서 작업 유형에 맞는 문서 확인
3. 작업 시 기존 코드 패턴과 컨벤션을 우선적으로 따름

## 라이선스

UNLICENSED

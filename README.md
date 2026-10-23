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
| `../next-bun` | Next.js App Router (버전은 그 레포 README) | 프론트엔드 — 별도 세션이 담당(`CLAUDE.md` "세션 운영") |

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
| 패키지 매니저 | pnpm 10 |

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

WebSocket은 namespace `/teams`(팀·채팅·태그)·`/fishing`·`/tetris-battle`(테트리스 대전), room `team-{teamId}` 기준. 인증은 `handshake.auth.token` → Bearer 헤더 순으로 확인하며, 멀티 레플리카 브로드캐스트는 Redis Pub/Sub이 담당한다.

### 모듈 구성

| 모듈 | 라우트 | 역할 |
|---|---|---|
| `team` | `/teams` | 팀·태스크·댓글·초대·태그 CRUD, 팀 채팅(저장·읽음), TeamGateway(실시간), OnlineUserService |
| `auth` | `/auth` | Kakao OAuth 로그인/회원가입, JWT 발급 |
| `users` | `/users` | 프로필 조회·수정 |
| `feedback` | `/feedbacks` | 사용자 피드백 작성·내 피드백 조회, 운영자 피드백 채널 알림 |
| `games` | `/games` | 게임 모음집 — 세션 발급(Redis, 게임별 엔진 레지스트리), 리플레이 재실행 검증 후 랭킹 등록(검증 확정 후 세션 소모 — 검증기 실패는 503 + 세션 유지), 보드·기간별 랭킹(`BOARD_KEY` — 테트리스 `default`, 디펜스 무한 `endless-s{시즌}`·주간 `weekly-YYYY-wNN`), 보드 목록, 기록 요약(공유 미리보기용), 리플레이 재생. 엔진은 프론트 원본의 사본(`tetris-engine/`·`defense-engine/`, 직접 수정 금지 — 디펜스는 매니페스트 해시 spec이 강제). 디펜스 검증은 레플리카마다 worker thread 풀(`defense-verify.worker.ts`, 첫 제출 때 기동) |
| `notification` | `/telegram` | Telegram 봇 webhook, Discord webhook 알림(팀·운영자 피드백 채널) |
| `file-share` | `/files` | API Key 기반 파일 공유 |
| `tetris-battle` | `/tetris-battle` (REST) | 테트리스 2~4인 대전 — 방·로비·채팅·매치(`/tetris-battle` WS, 상태는 Redis Hash+Lua), 경기 후 리플레이 재검증·결과 저장(`TETRIS_BATTLE_*`), 로비 방 수·최근 경기 목록(REST), 같은 사람 중복 자리 방지(토큰·로그인 userId 넘겨받기)·강퇴·하트비트 온라인 표시. 대전 래퍼는 프론트 원본의 사본(`src/modules/tetris-battle/battle-engine/`, 직접 수정 금지 — `engine-copy-hashes.json`이 사본 해시를 감시) |
| `fishing` | — | FishingGateway (실시간 맵/위치) |
| `scheduler` | — | Cron (태스크 자동 아카이브) |
| `main` | `/`, `/health-check` | 루트, 헬스체크 (`@nestjs/terminus` DB ping) |

`src/common/`에 횡단 관심사가 모여 있다 — `guards`, `filters`, `decorators`, `adapters`(RedisIoAdapter), `throttler`(Redis 스로틀 저장소), `port`(Port/Adapter), `metrics`, `logger`, `constants`, `enums`, `dto`, `utils`.

### 주요 테이블

`USERS`, `TEAMS`, `USER_TEAMS`, `TEAM_TASKS`, `TASK_COMMENTS`, `TEAM_INVITATIONS`, `TEAM_TELEGRAM_LINKS`, `FILE_SHARES`, `TEAM_CHAT_MESSAGES`, `TEAM_CHAT_READ_CURSORS`, `TEAM_TAGS`, `TEAM_TASK_TAGS`, `FEEDBACKS`, `GAME_SCORES`, `GAME_REPLAYS`

## 개발 환경 설정

### 사전 요구사항

- Node.js + pnpm 10 — `corepack enable` 후 `package.json` `packageManager`가 버전의 단일 기준(Dockerfile도 corepack 사용)
- Oracle Instant Client — thick 모드로 동작하므로 wallet 접속에 필요
- Redis — 실시간 프레즌스·Socket.IO 브로드캐스트·채팅 레이트리밋·**HTTP 스로틀 카운터 공유**·**게임 세션(seed)**용. 없어도 HTTP API는 정상 기동한다(스로틀은 레플리카 인메모리로 폴백). 단 게임 세션 발급·랭킹 등록은 Redis가 필요하다(없으면 503 `GAME_SESSION_UNAVAILABLE` — 플레이는 프론트 로컬로 가능)

### 설치 및 실행

```bash
pnpm install
pnpm dev          # watch 모드 → http://localhost:3500/api/v1
```

### 로컬 Redis 실행

WebSocket 온라인 상태(프레즌스)와 멀티 레플리카 브로드캐스트, 게임 세션에 쓰인다. **없어도 HTTP API는 정상 기동**하며 WS 프레즌스와 게임 랭킹 등록(503)만 동작하지 않는다.

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
- ⚠️ 6379를 **다른 프로젝트의 Redis가 이미 쓰고 있으면** 그 Redis(비밀번호 있음)에 붙어 `NOAUTH Authentication required`가 난다 — `-p 6380:6379`로 띄우고 `.env`의 `REDIS_PORT=6380`. 확인: `printf 'PING\r\n' | nc -w 2 localhost 6380` → `+PONG`
- 운영(`infra_redis`)은 `--appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru`로 뜬다 — 영속성·축출 정책까지 재현하려면 같은 옵션을 붙인다.
- Redis를 끈 상태로 앱을 띄우면 경고 로그만 남고 기동은 성공해야 한다. 이 동작 자체가 검증 항목이다.

### 환경 변수

`.env`를 프로젝트 루트에 둔다. 부팅 시 `src/config/env.validation.ts`가 검증하며 누락 시 앱이 시작되지 않는다.

**검증 대상(필수)**: `ENV`, `EXPRESS_PORT`, `JWT_SECRET`, `LOG_LEVEL`, `NEXT_PUBLIC_DOMAIN`, `ORACLE_DB_USER`, `ORACLE_DB_PW`, `ORACLE_DB_CONNECT_STR`, `REDIS_PORT`

**그 외 사용 변수**: `ORACLE_WALLET_PATH`, `ORACLE_LIB_DIR`(Oracle thick client), `REDIS_HOST`, `JWT_ACCESS_TOKEN_EXPIRES_IN`, `BOT_TOKEN_TELEGRAM`, `BOT_USERNAME_TELEGRAM`, `TASK_SLOT`(스케줄러 단일 실행 보장), `FEEDBACK_DISCORD_WEBHOOK_URL`·`FEEDBACK_TELEGRAM_CHAT_ID`(운영자 피드백 알림 대상 — 없으면 그 채널은 보내지 않음), `GAME_IP_HASH_SECRET`(게임 랭킹 등록 IP의 HMAC 키 — 없으면 IP 해시를 저장하지 않음), `GAME_WEEKLY_SEED_SECRET`(디펜스 주간 도전 seed의 HMAC 키 — 없으면 주간 도전만 503, 무한 모드 정상), `GAME_VERIFY_WORKERS`(레플리카당 디펜스 검증 워커 수 1~8 — 없으면 1)

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

> **CI 게이트**: `.github/workflows/ci.yml`이 PR마다(`pull_request`) `pnpm install --frozen-lockfile` → `pnpm ci:core` → `pnpm test:e2e`를 돌린다. `main` push 배포(`deploy-to-oci.yml`)는 같은 워크플로를 먼저 호출하고(`workflow_call`, `needs: ci`) 통과해야 이미지 빌드·배포로 간다. 스텁 검사(`check:stubs`)는 CI에 없으므로 PR 전 `pnpm ci:all`로 확인한다.
>
> `pnpm ci:all` 기준선(2026-10-23 실측): lint 0 errors / 경고 6건, 스텁 0건, 단위 **1545/1545**(65 스위트), E2E **240 통과 · 58 skip**(Redis·opt-in 필요 — 테트리스 대전 실제 Redis 스펙은 `TETRIS_BATTLE_REDIS_TEST_PORT`, 주면 296 통과 · 2 skip), build 통과.
> ⚠️ `--testPathPattern`(단수형)은 현재 jest가 거부한다 — `--testPathPatterns`(복수형)를 쓴다.

## DB 마이그레이션

TypeORM 마이그레이션을 사용한다. 런타임 설정(`src/config/database.config.ts`)과 **분리된** CLI DataSource(`migration-datasource.ts`)로 동작하며, 앱은 시작 시 마이그레이션을 실행하지 않는다(`migrationsRun: false` — Swarm 멀티 레플리카 동시 기동 시 중복 실행 방지).

```bash
pnpm db:migrate:create <Name>   # 빈 마이그레이션 파일 생성 (DB 접속 없음)
pnpm db:migrate:up              # 적용
pnpm db:migrate:revert          # 되돌리기
pnpm db:migrate:list            # 적용 상태 확인
pnpm db:migrate:fake            # 베이스라인 등록 전용 (1회성)

pnpm db:select '<SELECT …>'     # 읽기 전용 조회 — 단일 SELECT·WITH만, READ ONLY 트랜잭션, 행 상한 200(--max-rows=N, 최대 1000), 토큰·웹훅 컬럼 값 가림, --json
```

- 이력 테이블: `TYPEORM_MIGRATIONS` · 파일: `migrations/<timestamp>-PascalCase.ts`
- **작성 규칙**: 멱등 작성(Oracle DDL은 자동 커밋이라 실패 시 부분 적용됨), 1개 = 1목적, `down()` 필수(init 제외)
- **스키마 변경은 항상 Entity 수정 + 마이그레이션 파일 세트로** — 드리프트 방지
- ⚠️ LOCAL/PROD 동일 DB이므로 **DB에 접속하는 명령은 담당자가 직접 실행**한다. 예외는 읽기 전용 `pnpm db:select`(쓰기는 `scripts/db-select.ts`의 SQL 가드 + READ ONLY 트랜잭션이 거부). `.claude/settings.json` deny는 마이그레이션·`sqlplus` 같은 **주요 CLI만** 막고 스크립트 안의 DB 연결은 못 막는다 — 나머지는 `CLAUDE.md` Never 표의 행동 규칙이다
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
| `prod_next` | Next.js (4 replicas) — DNS `prod_next_app:3000` |

- 이미지 태그는 git SHA 7자 (`latest` 없음), 배포는 `docker stack deploy`로 통일
- 배포 서버: fs-01 (ARM64, Manager) / fs-02 (registry) / fs-03 (모니터링)
- Caddyfile은 서버에서 직접 관리한다 (공개 저장소 보안 정책 — Git 커밋 안 함)

상세: [`docs/deploy.md`](docs/deploy.md)

## AI Assistant 가이드

AI 에이전트용 작업 규약은 [`CLAUDE.md`](CLAUDE.md)가 진입점(SSOT)이다. 사람·AI 공통 참고 문서:

| 문서 | 담당 |
|---|---|
| **[코드 규약](.claude/rules/)** | 파일 종류별 rule — 공통 구조(`core.md`) · HTTP(`api-http.md`) · 데이터 접근(`data-access.md`) · 날짜(`datetime.md`) · 실시간(`realtime-ws.md`) · 스키마(`schema-migrations.md`) · 테스트(`testing.md`). 해당 파일을 읽으면 자동 로드 |
| **[반복 이슈 플레이북](docs/playbooks/recurring-issues-playbook.md)** | 결함 클러스터별 최우선 확인 지점 — 버그·장애 조사 진입점 |
| **[교훈 로그](docs/lessons.md)** | 작업 방식의 누적 교훈 — 리팩터링 착수 전·교정 직후 |
| **[배포 & 인프라](docs/deploy.md)** | Swarm 스택, 노드, 볼륨, CI/CD |
| **[태스크 문서](docs/tasks/)** | 태스크별 상태·이력·결정 근거 (완료분은 [`archive/`](docs/tasks/archive/)) |
| [아키텍처 & 주요 파일](docs/architecture.md) | 주요 파일·날짜 처리 요지 — 모듈 구성은 위 "아키텍처 개요"가 정확하다 |
| [Redis Pub/Sub PRD](docs/prd-redis-pubsub.md) · [API 스로틀링 가이드](docs/blog-api-throttling.md) | 배경 문서 (후자는 외부 발행용 초안, 프로젝트 규약 아님) |

**프로젝트를 처음 접하는 사람/AI는:**

1. 이 README로 전체 그림 파악 (프로젝트 맵, 아키텍처, 배포)
2. `CLAUDE.md`의 문서 라우팅 표에서 작업 유형에 맞는 문서 확인 (코드 규약은 자동 로드). 프론트는 별도 세션이 담당한다 — `CLAUDE.md` "세션 운영"
3. 작업 시 기존 코드 패턴과 컨벤션을 우선적으로 따름

## 라이선스

UNLICENSED

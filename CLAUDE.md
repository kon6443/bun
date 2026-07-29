# FiveSouth Backend (NestJS)

NestJS 11 + TypeScript 백엔드. Oracle DB (TypeORM), Socket.IO + Redis Pub/Sub.

## Commands
- `pnpm dev` | `pnpm run build` (tsc) | Port: 3500, prefix `/api/v1`
- Swagger: `/api/v1/docs` (LOCAL only)

## Conventions
- Auth: Kakao OAuth + JWT — HTTP: cookie `access_token` 우선 → Bearer 헤더 | WS: `handshake.auth.token` → Bearer 헤더
- ValidationPipe: `transform: true`, `enableImplicitConversion: true`
- 날짜: UTC 저장, 로컬 표시 — DB 컬럼 전부 `TIMESTAMP WITH TIME ZONE`, ORA_SDTZ 설정 금지 (oracledb가 로컬 TZ 기반으로 Date 저장하므로 세션 TZ는 자동 일치시켜야 함)
- Oracle `FROM_TZ()` 사용 시 리전 이름(`'UTC'`) 금지 → 오프셋(`'+00:00'`) 사용 (ORA-01805 방지)
- 프론트엔드 프로젝트: `../next-bun` (Next.js 15 App Router + Bun)

## DB Migrations (TypeORM)
- CLI DataSource: `migration-datasource.ts` (루트, 런타임 설정과 분리) | 이력 테이블: `TYPEORM_MIGRATIONS` | 파일: `migrations/<timestamp>-PascalCase.ts`
- 명령: `pnpm db:migrate:create <Name>` / `db:migrate:up` / `db:migrate:fake` / `db:migrate:revert` / `db:migrate:list`
- ⚠️ `db:migrate:fake`는 베이스라인 등록 1회용 — pending 마이그레이션이 있는 상태에서 실행하면 **DDL 실행 없이 기록만 되어 조용히 미적용**됨. 평상시엔 `up`만 사용
- **LOCAL/PROD 동일 DB — DB 접속이 발생하는 `db:migrate:*`(list 포함, 첫 실행 시 이력 테이블 자동 생성)는 담당자가 직접 실행. AI·자동화 도구는 마이그레이션 파일 작성까지만**
- 작성 규칙: 멱등 작성(`USER_TAB_COLUMNS` 등 존재 체크 — Oracle DDL은 자동 커밋이라 실패 시 부분 적용됨), 1개 = 1목적, `down()` 필수(init 제외)
- 스키마 변경은 항상 **Entity 수정 + 마이그레이션 파일 세트**로 (드리프트 방지). 상세: `docs/tasks-nestjs-improvements.md` D33/D34

## Rules
- **추측/추론 금지**: 항상 코드, 로그, DB 데이터 등 근거 기반으로 작업. 확인 불가한 사항은 추측하지 말고 사용자에게 확인 요청
- **필요 시 요청**: 정보가 부족하거나 판단이 어려운 경우 반드시 사용자에게 질문. 임의로 결정하지 않음
- 코드에 있는 그대로 보고 판단 (추론/추측 금지)
- **검증 시 grep 전수 확인 필수**: 변경된 함수/API 이름으로 프로젝트 전체 grep 후 호출 위치 전수 파악. 파일 부분 읽기(offset/limit)로 "전체 정상" 판단 금지. 특히 중복 API 호출, useEffect 간 중복 패턴 교차 비교

## Deployment (Docker Swarm)
- **스택**: `infra` (caddy + redis + registry), `prod_nest` (NestJS 3 replicas), `prod_next` (Next.js 20 replicas)
- **배포 방식**: `docker stack deploy` 통일 (CI/CD가 자동 rsync + deploy)
- **이미지 태그**: git SHA 7자 (예: `prod_nest:a53eb5c`). `latest` 없음.
- **DNS 이름**: 백엔드 = `prod_nest_app:3500`, 프론트 = `prod_next_app:3000`, Registry = `infra_registry:5000`, Redis = `infra_redis:6379`
- **배포 서버**: fs-01 (ARM64, Manager). 추가 노드: fs-02 (infra_registry), fs-03 (모니터링 예약)
- **Caddyfile**: 서버 직접 관리 (공개 레포 보안 정책, Git 커밋 안 함)

## Active Work
- **팀 단위 실시간 채팅**: 백엔드+프론트 구현 완료 (저장 없음, 빌드/타입체크/코드리뷰 통과) — 수동 E2E·배포 대기. `docs/tasks-team-chat.md`
- **에러 DTO 리팩토링 (defineDomainError)**: ✅ 구현·검증·커밋 완료 (2026-07-22, 커밋 `73adc28`~`8b678c4`) — 잔여: 인증 필요 수동 E2E 2건 (팀 미존재 404, WS FORBIDDEN/CHAT_NOT_JOINED). `docs/tasks-error-dto-refactor.md` Results 참조
- **Swarm 스택 마이그레이션**: ✅ 완료 (2026-04-18) — 세부사항 `docs/tasks-swarm-stack-migration.md`
- **DB 마이그레이션 환경 (D33)**: ✅ 완료 (2026-07-23, 커밋 `169ee9a`) — init fake 등록 + TOKEN 확장 up 실행까지 검증. 이후 스키마 변경은 Entity 수정 + 마이그레이션 파일 세트로
- **Entity↔DB 정합화 (D27/D34)**: 구현·커밋 완료 (2026-07-23, 커밋 `f9d2a35`·`669e338`) — 잔여: 인증 필요 수동 테스트 3건 (카카오 로그인, 초대 생성·수락, 댓글 생성). `docs/tasks-nestjs-improvements.md` D34
- **다음**: 모니터링 스택 (`docs/tasks-monitoring.md`) → 로그 중앙 수집 (`docs/tasks-logging.md`)

## Docs
- 배포 & 인프라: `docs/deploy.md`
- 아키텍처 & 주요 파일: `docs/architecture.md`
- Redis Pub/Sub PRD: `docs/prd-redis-pubsub.md`
- Redis Pub/Sub Tasks: `docs/tasks-redis-pubsub.md` (구현 완료)
- NestJS 고도화 Tasks: `docs/tasks-nestjs-improvements.md`
- 에러 DTO 리팩토링 Tasks: `docs/tasks-error-dto-refactor.md` (Phase 0~4 구현 완료, E2E·커밋 대기)
- Swarm 스택 마이그레이션 Tasks: `docs/tasks-swarm-stack-migration.md` (✅ 완료)
- 팀 단위 실시간 채팅 Tasks: `docs/tasks-team-chat.md` (구현 완료, E2E·배포 대기)
- 모니터링(Prometheus+Grafana+node_exporter) Tasks: `docs/tasks-monitoring.md`
- 로그 중앙 수집(Loki+Promtail) Tasks: `docs/tasks-logging.md`

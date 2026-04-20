# Deploy

## 현재 아키텍처 (Docker Swarm, 2026-04-18~)

### 스택 구성

| 스택 | 서비스 | Replicas | 배치 노드 | 내부 DNS |
|------|--------|:---:|---------|---------|
| `infra` | `infra_caddy` | 2 | fs-01 | `infra_caddy:80/443` |
| `infra` | `infra_redis` | 1 | fs-01 (Manager) | `infra_redis:6379` |
| `infra` | `infra_registry` | 1 | fs-02 | `infra_registry:5000` (영속 bind mount) |
| `prod_nest` | `prod_nest_app` | 3 | fs-01 | `prod_nest_app:3500` |
| `prod_next` | `prod_next_app` | 20 | fs-01 | `prod_next_app:3000` |

### 노드

| 노드 | 역할 | 스펙 | 라벨 |
|------|------|------|------|
| fs-01 | Manager (Reachable), 앱 배치 | ARM64, 4 OCPU / 24GB | `infra_caddy`, `infra_redis`, `prod_nest`, `prod_next` |
| fs-02 | Manager (Reachable), 레지스트리 | AMD64, 1 OCPU / 1GB | `infra_registry` |
| fs-03 | Manager (Leader), 모니터링 예약 | AMD64, 1 OCPU / 1GB | (모니터링 도입 시 추가) |

## CI/CD

### 앱 배포 (bun / next-bun 각 레포)
- `main` push → GitHub Actions 자동 실행
- 이미지 빌드 & push: `prod_nest:{short_sha}` / `prod_next:{short_sha}` (git SHA 7자)
- `infra/docker-stack.app.yml` → 서버 `/home/ubuntu/desktop/deploy/infra/prod_nest.yml` 또는 `prod_next.yml`로 rsync
- `docker stack deploy --detach=false -c prod_nest.yml prod_nest` (converge 대기 포함)

### 인프라 배포 (bun 레포 `infra/docker-stack.yml`)
- `infra/docker-stack.yml` 변경 시 `.github/workflows/deploy-infra.yml` 자동 실행
- 또는 Actions 탭 → `Deploy Infra Stack` → Run workflow 수동 트리거

### Caddyfile
- 서버 직접 관리 (`/home/ubuntu/desktop/deploy/infra/caddy/config/Caddyfile`)
- 공개 레포 보안 정책으로 **Git 커밋 안 함** (도메인/IP 노출 방지)
- Caddy `--watch` 옵션으로 자동 reload

## 레플리카 확장

각 레포의 `infra/docker-stack.app.yml` 의 `deploy.replicas` 수정 → PR merge → CI/CD 자동 반영.
수동 스케일은 `docker service scale prod_nest_app=N` (임시).

## Docker

### 이미지
- NestJS: `node:20-bullseye-slim` 기반 멀티 스테이지. multi-arch (amd64 + arm64)
- Next.js: `oven/bun:1` 기반 standalone. arm64 native (ARM runner 빌드)
- `ENV TZ=UTC` 명시 — 모든 날짜는 UTC로 저장/처리, 표시 단계에서만 KST 변환
- Next.js 컨테이너는 `HOSTNAME=0.0.0.0` 환경변수로 모든 인터페이스 bind

### 환경변수
- `.env` 파일은 **fs-01**의 `/home/ubuntu/desktop/deploy/sys/config/env/.env`에 위치
- 백엔드/프론트 **공유** (YAML `env_file:` 지시어로 컨테이너 주입)
- 프론트의 `NEXT_PUBLIC_*` 변수는 빌드 시 인라이닝 (`.env.build` 참조, 런타임 env 주입 불가)

## 영속 저장소

| 서비스 | 호스트 경로 | 컨테이너 경로 | 용도 |
|-------|-----------|-------------|------|
| `infra_redis` | Docker volume `redis-data` | `/data` | Redis AOF |
| `infra_registry` | `/home/ubuntu/desktop/deploy/sys/registry/data` | `/var/lib/registry` | 이미지 저장소 (재시작해도 유지) |
| `infra_registry` | `/home/ubuntu/desktop/deploy/sys/registry/auth` | `/auth` | htpasswd 인증 |
| `infra_registry` | `/home/ubuntu/desktop/deploy/sys/registry/config.yml` | `/etc/docker/registry/config.yml` | registry 설정 |
| `prod_nest_app` | `/home/ubuntu/desktop/deploy/sys/config/oracle` | `/opt/oracle` | Oracle wallet + instantclient |
| `prod_nest_app` | `/home/ubuntu/desktop/deploy/sys/shared` | `/app/shared` | 사용자 공유 파일 폴더 |

## 관련 문서
- Swarm 마이그레이션 이력 & 결정: `tasks-swarm-stack-migration.md`
- 모니터링 계획: `tasks-monitoring.md`
- 로그 중앙 수집 계획: `tasks-logging.md`

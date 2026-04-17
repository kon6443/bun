# Task Tracker: Swarm 서비스 정비 — 스택 관리 + 이름 변경 + CI/CD

> 생성일: 2026-04-16
> 최종 수정: 2026-04-17 (Step 1~1.5 완료, Step 2 시작 직전)
> 브랜치: `feat-onam`
> 선행: 이 작업 완료 후 → 모니터링 스택(`tasks-monitoring.md`) 진행 (서비스 DNS 이름 의존)
> 연관 문서: [`tasks-monitoring.md`](./tasks-monitoring.md), [`deploy.md`](./deploy.md)

---

## 🚦 현재 진행 상태 (2026-04-17)

```
Phase A — Swarm 서비스 정비
├─ Step 1   사전 준비 (inspect 캡처)          [✅ 완료]
├─ Step 1.3 공통 설정 (log rotation/swap/NTP) [✅ 완료]
├─ Step 1.5 신 라벨 병행 추가                  [✅ 완료]
├─ Step 2   YAML/CI/CD 파일 작성               [⏳ 다음 시작]  ← 여기부터
├─ Step 3   마이그레이션 실행 (Phase 0~7)       [⏸️ 유지보수 시간대]
├─ Step 4   검증                                [⏸️ 대기]
└─ Step 5   문서 정비                           [⏸️ 대기]
```

### ✅ 완료 사항 요약

**서버 상태 확인 완료:**
- fs-01: ARM64, Manager(Reachable), 디스크 60%, RAM 24GB
- fs-02: AMD64, Manager(Reachable), 디스크 30%, RAM 956Mi (현재 451Mi 사용)
- fs-03: AMD64, **Leader**, 디스크 22%, RAM 956Mi (현재 455Mi 사용)
- Docker: 전부 v28.3.1

**서버 설정 완료:**
- NTP 동기화 확인 (3노드 전부 active)
- vm.swappiness 60 → 10 (영구 적용, 스왑 사용량 즉시 감소 확인)
- Docker 로그 rotation (max-size 10m, max-file 3)

**노드 라벨 병행 추가:**
- fs-01: `prod_nest=1`, `prod_next=1` 추가 (sys_* 구 라벨 유지 중)
- fs-02: `infra_registry=1` 추가 (sys_registry 구 라벨 유지 중)
- fs-03: 비어있음 (모니터링 Phase에 추가 예정)

### ⏳ 다음 즉시 작업: Step 2 (YAML/CI/CD 파일 작성)

작성할 파일 (bun 레포):
1. `infra/docker-stack.app.yml` — prod_nest 스택 YAML
2. `infra/docker-stack.yml` 수정 — registry 서비스 추가 (기존 caddy + redis에)
3. `.github/workflows/deploy-to-oci.yml` 변경 — docker stack deploy 방식
4. `.github/workflows/deploy-infra.yml` 신규 — infra 자동 배포

작성할 파일 (next-bun 레포):
5. `infra/docker-stack.app.yml` — prod_next 스택 YAML
6. 배포 워크플로우 수정

> **다음 세션 재개**: 이 문서 "📦 생성/수정할 파일" 섹션 기반으로 실제 파일 작성 시작. inspect 결과(아래 "🖥️ 노드 현황" 섹션 참조)와 1:1 비교하며 작성.

---

## 📌 결정 사항 요약

| 항목 | 결정 | 근거 |
|------|------|------|
| 앱 서비스 관리 | **스택 per 서비스** — 각 앱이 독립 스택 (1 service each) | mobisell 동일 패턴. YAML이 설정 원천, `docker stack deploy`로 통일 |
| 마이그레이션 대상 | `sys_express` → `prod_nest_app`, `sys_next` → `prod_next_app` | 스택명\_서비스명 자동 생성 DNS |
| 스택 YAML | `infra/docker-stack.app.yml` (각 레포에 1개씩) | 레포별 독립 관리, 서로 영향 없음 |
| infra 스택 | `infra` **유지** (caddy + redis) + `sys_registry` 합류 → `infra_registry` | QA/PROD 공통 인프라 |
| 배포 방식 (전체) | **`docker stack deploy`** 통일 (앱/infra/모니터링 모두) | YAML이 단일 진실 원천. CI/CD에 플래그 작성 불필요 |
| 이미지 배포 | `docker stack deploy` — YAML의 image에 SHA 태그 주입 | 설정 + 이미지 동시 적용 |
| 이미지 태그 | **git SHA 7자만** (`prod_nest:a1b2c3d`). latest 없음 | SHA만으로 충분. latest는 혼동 유발 |
| infra CI/CD | **`deploy-infra.yml` 신규** | docker-stack.yml 변경 시 자동 배포 |
| Caddyfile | **서버 직접 관리** (Git 커밋 안 함) | 공개 레포 — 도메인/IP 노출 방지 |
| 파일 전송 | **rsync** | 변경 파일만 전송 |
| 다운타임 최소화 | **새 스택 먼저 배포 → Caddyfile 전환 → 구 서비스 삭제** | 무중단 전환 |
| 네트워크 | `sys_default` **유지** | 변경 위험 대비 이득 없음 |
| Docker 로그 rotation | `/etc/docker/daemon.json`에 `log-opts` 설정 (모든 노드) | 에러 루프 시 디스크 폭주 방지. 기본은 무제한 |
| NTP 시간 동기화 | 모든 노드 `timedatectl status`로 확인 | Prometheus 타임스탬프 정확도 필요. OCI Ubuntu 기본 동기화되지만 검증 |
| 서버 env 경로 | `/home/ubuntu/desktop/deploy/sys/config/env/.env` **유지** | 디렉터리명은 서비스와 무관 |
| REDIS_HOST | `infra_redis` **유지** (확인 완료) | 변경 불필요 |
| 노드 라벨 | **Rename** — `sys_*` → 새 이름 (`prod_nest=1`, `prod_next=1`, `infra_registry=1`) | 이름 일관성. 라벨 rm/add 동시 실행 |
| Healthcheck | **Swarm 서비스 레벨 추가** (현재 없음) | prod_nest: `/api/v1/health-check` (기존). prod_next: `/api/health` (신규 — next-bun에 route.ts 추가) |
| Registry 마이그레이션 충돌 방지 | Phase 5 시작 전 **GitHub Actions 수동 중단** + 팀 공지 | 10~30초 registry 끊김 대비 |
| Registry 영속성 보강 | **`/var/lib/registry` 영속 bind mount 추가** (config.yml은 정상) | 현재 이미지가 컨테이너 내부 저장 → 재시작 시 소실. Phase 5-0에서 `docker cp`로 무손실 이동 |
| CPU 아키텍처 | **multi-arch 이미지** (amd64 + arm64) 모두 지원 필수 | fs-01=ARM64, fs-02/03=AMD64. 앱 CI/CD가 이미 multi-arch 빌드, 공식 이미지도 전부 multi-arch |

---

## 🖥️ 노드 현황 (실제 확인 완료)

### 아키텍처 + Swarm 역할

| 노드 | 아키텍처 | 타입 | Swarm 역할 |
|------|---------|------|-----------|
| fs-01 | **arm64** (aarch64) | ARM A1.Flex (4 OCPU / 24GB) | Reachable (Manager) |
| fs-02 | **amd64** (x86_64) | AMD E2.1.Micro (1 OCPU / 1GB) | Reachable (Manager) |
| fs-03 | **amd64** (x86_64) | AMD E2.1.Micro (1 OCPU / 1GB) | ⭐ **Leader** |

### 현재 노드 라벨 & 서비스 배치

| 노드 | 라벨 | 현재 실행 중인 서비스 | Docker 버전 | 디스크 |
|------|------|---------------------|------------|--------|
| fs-01 | `sys_caddy=1`, `sys_express=1`, `sys_next=1`, `infra_redis=1` | infra_caddy (x2), infra_redis, sys_express (x3), sys_next (x20) | 28.3.1 | 27G/45G (60%) |
| fs-02 | `sys_registry=1` | sys_registry | 28.3.1 | 13G/45G (30%) |
| fs-03 | (없음) | 없음 (Swarm Leader) | 28.3.1 | 9.4G/45G (22%) |

📌 **디스크 자동 관리**: fs-01은 이미지 pull 반복으로 60%까지 사용. `cron`으로 매 분 `cleanup_disk.sh` 실행 → 65% 임계값 초과 시 `docker system prune -af` 자동 정리.

📌 **Loki 도입 후 fs-03 디스크 증가 예상**: 현재 22% → Loki retention 7일 기준 +1~3GB/주 수준. 임계 멀지만 모니터링 필요.

⚠️ **현재 특이점**: fs-01에 앱 전체 집중, fs-03은 비어있음 (모니터링 배치 예정 공간).

### 목표 노드 라벨 (마이그레이션 후)

| 노드 | 라벨 | 배치될 서비스 |
|------|------|-------------|
| fs-01 | `sys_caddy=1`, `prod_nest=1`, `prod_next=1`, `infra_redis=1` | infra_caddy, infra_redis, prod_nest_app, prod_next_app (+ shared 에이전트) |
| fs-02 | `infra_registry=1` (+ 모니터링 phase에 `prod_monitor_metrics=1`) | infra_registry (+ prometheus, alertmanager) |
| fs-03 | (모니터링 phase에 `prod_monitor_view=1`) | (+ grafana, loki) |

**Swarm 동작**: 이미지 manifest list가 있으면 Swarm이 각 노드 아키텍처에 맞는 이미지를 자동 pull.

**모든 이미지가 multi-arch여야 함:**

| 이미지 | multi-arch 지원 | 비고 |
|--------|---------------|------|
| `fivesouth.duckdns.org/prod_nest` | ✓ | CI/CD에서 `--platform linux/amd64,linux/arm64` 빌드 |
| `fivesouth.duckdns.org/prod_next` | ✓ | 동일 |
| `caddy:latest` | ✓ | 공식 |
| `redis:7-alpine` | ✓ | 공식 |
| `registry:2` | ✓ | 공식 |
| `prom/prometheus:v3.4.1` | ✓ | 공식 |
| `grafana/grafana:12.1.0` | ✓ | 공식 |
| `prom/alertmanager:v0.27.0` | ✓ | 공식 |
| `grafana/loki:3.1.0` | ✓ | 공식 |
| `prom/node-exporter:v1.8.2` | ✓ | 공식 |
| `grafana/promtail:3.1.0` | ✓ | 공식 |

**→ 추가 설정 불필요.** 단, 앱 이미지 빌드 시 `--platform linux/amd64,linux/arm64`를 **반드시 유지**.

---

## 🏗️ 현재 상태 vs 목표 상태

### 현재

```
docker stack ls:
  infra     2 services

docker service ls:
  infra_caddy     replicated  2/2   (infra 스택)
  infra_redis     replicated  1/1   (infra 스택)
  sys_express     replicated  3/3   (standalone)
  sys_next        replicated  20/20 (standalone)
  sys_registry    replicated  1/1   (standalone)

배포: docker service update sys_express (CI/CD)
      infra 스택 → 수동
```

### 목표

```
docker stack ls:
  infra       3 services
  prod_nest   1 service
  prod_next   1 service

docker service ls:
  infra_caddy      replicated  2/2   (infra 스택)
  infra_redis      replicated  1/1   (infra 스택)
  infra_registry   replicated  1/1   (infra 스택)
  prod_nest_app    replicated  3/3   (prod_nest 스택)
  prod_next_app    replicated  20/20 (prod_next 스택)

배포: docker stack deploy (전부 통일)
```

### mobisell과 비교

```
mobisell:
  mobisell-back-prod      1 service (app)     ← 스택 per 서비스
  mobisell-back-qa        1 service (app)
  mobisell-front-develop  2 services
  mobisell-monitoring-shared  3 services
  mobisell-monitoring-qa      3 services

우리 (목표):
  prod_nest               1 service (app)     ← 동일 패턴
  prod_next               1 service (app)
  infra                   3 services
  monitor_shared          2 services
  prod_monitor            4 services
```

---

## ⚠️ 영향 범위 분석

### DNS 이름 변경

| 변경 | 구 DNS | 신 DNS | 영향 |
|------|--------|--------|------|
| NestJS 백엔드 | `sys_express` | `prod_nest_app` | Caddyfile, 모니터링 scrape |
| Next.js 프론트 | `sys_next` | `prod_next_app` | Caddyfile |
| Registry | `sys_registry` | `infra_registry` | 없음 (외부 IP 접근) |

### Caddyfile 변경 (서버 직접) — **현재 실제 내용 반영**

현재 Caddyfile의 `route` 블록 (3개 handle):

```caddyfile
route {
    # 현재                                         # 변경 후
    handle /v2/* {
        reverse_proxy sys_registry:5000      →     reverse_proxy infra_registry:5000
    }
    handle /api/v1/* {
        reverse_proxy http://sys_express:3500  →   reverse_proxy http://prod_nest_app:3500
    }
    handle /socket.io/* {
        reverse_proxy http://sys_express:3500  →   reverse_proxy http://prod_nest_app:3500
    }
    handle {
        reverse_proxy http://sys_next:3000   →     reverse_proxy http://prod_next_app:3000
    }
}
```

**⚠️ Docker Registry 라우팅 주의**: `/v2/*` 경로로 `fivesouth.duckdns.org/v2/...`에 접근 = Docker registry API. CI/CD의 이미지 push/pull도 이 경로 사용. Caddyfile에서 `infra_registry` 로 바꾸는 순간 **진행 중인 docker push가 있으면 실패**. 마이그레이션 마지막 단계(Phase 5)에서 변경 필요.

---

## 📦 생성/수정할 파일

### 1. `infra/docker-stack.app.yml` (bun 레포, 신규) — **inspect 기반 확정**

```yaml
version: '3.9'

services:
  app:
    image: ${REGISTRY_URL}/prod_nest:${IMAGE_TAG}
    networks:
      - sys_default
    deploy:
      replicas: 3
      placement:
        constraints:
          - node.labels.prod_nest == 1   # 라벨 rename 필요 (구: sys_express)
      update_config:
        parallelism: 1
        order: start-first
        failure_action: rollback
        monitor: 10s
      rollback_config:
        parallelism: 1
        order: start-first            # ⚠️ 특이하지만 기존 설정 유지
      restart_policy:
        condition: on-failure
    ports:
      - target: 3500
        published: 23500
        mode: ingress
    volumes:
      - /home/ubuntu/desktop/deploy/sys/config/oracle:/opt/oracle
      - /home/ubuntu/desktop/deploy/sys/shared:/app/shared
    environment:
      # ⚠️ 전체 env는 .env 파일에서 주입. 여기는 Swarm 템플릿 var만
      TASK_SLOT: "{{.Task.Slot}}"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3500/api/v1/health-check"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

networks:
  sys_default:
    external: true
```

**inspect 반영 항목:**
- Replicas: 3 ✓
- Constraint: `node.labels.prod_nest == 1` (라벨 rename 완료)
- Update: parallelism 1, start-first, rollback on failure, monitor 10s ✓
- Rollback: parallelism 1, **start-first** (기존 설정 유지) ✓
- Port: 23500→3500 ingress ✓
- **Bind mount 2개** (Oracle wallet + shared) ✓
- **TASK_SLOT 템플릿 변수** ✓
- **Healthcheck 추가** — NestJS의 `/api/v1/health-check` 엔드포인트 사용 (무중단 배포 품질 향상)

> ⚠️ env 주입: CI/CD에서 `.env` source → YAML에 기타 env는 명시 안 함 (deploy 시 `--with-registry-auth` + env-file 방식으로 주입)

### 1-B. `infra/docker-stack.app.yml` (next-bun 레포, 신규) — **inspect 기반 확정**

```yaml
version: '3.9'

services:
  app:
    image: ${REGISTRY_URL}/prod_next:${IMAGE_TAG}
    networks:
      - sys_default
    deploy:
      replicas: 20
      placement:
        constraints:
          - node.labels.prod_next == 1
      update_config:
        parallelism: 1
        order: start-first
        failure_action: rollback
        monitor: 10s
      rollback_config:
        parallelism: 1
        order: start-first
      restart_policy:
        condition: on-failure
    ports:
      - target: 3000
        published: 23000
        mode: ingress
    healthcheck:
      # next-bun 레포에 /api/health 엔드포인트 추가 (아래 "next-bun 레포 추가 파일" 참조)
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

networks:
  sys_default:
    external: true
```

**inspect 반영 항목:**
- Replicas: 20 ✓
- Constraint: `node.labels.prod_next == 1` ✓
- Update/Rollback: prod_nest와 동일 ✓
- Port: 23000→3000 ingress ✓
- **Mount 없음** (inspect에서 Mounts 섹션 없음 확인) ✓
- **Healthcheck 추가** — 홈 경로 체크 (`/api/health` 추가 권장)

### 1-C. `next-bun` 레포 — Healthcheck 엔드포인트 신설

**파일**: `src/app/api/health/route.ts` (신규)

next-bun 프로젝트 패턴 확인 결과:
- App Router + `src/app/api/**/route.ts` 구조
- API prefix 없음 (`/api/health`로 직접 접근)
- `NextResponse.json()` 사용 패턴
- 기존 예시: `src/app/api/test/route.ts`

**생성할 파일 내용:**

```typescript
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ status: "ok" });
}
```

**검증:**
```bash
curl -f http://localhost:3000/api/health
# 응답: {"status":"ok"}
```

### 2. `infra/docker-stack.yml` 수정 — registry 추가 + **영속 bind 보강**

#### 📍 현재 Registry 상태 (정정)

- **배치 노드**: **fs-02** (`node.labels.sys_registry=1` 있는 노드)
- **config.yml 위치**: fs-02의 `/home/ubuntu/desktop/deploy/sys/registry/config.yml` (정상 존재)
- **현재 config.yml 내용**:
  ```yaml
  storage:
    cache:
      blobdescriptor: inmemory
    filesystem:
      rootdirectory: /var/lib/registry    # 컨테이너 내부 경로
  auth:
    htpasswd:
      # (인증 설정)
  ```
- **인증 파일**: `/auth` bind mount (기존 유지)

#### ⚠️ 여전히 남은 문제: 이미지 영속성

config.yml은 정상이지만, **이미지 저장 경로 `/var/lib/registry`는 컨테이너 내부** (bind mount 없음):
- 컨테이너 재시작 = 이미지 전부 소실
- 현재 컨테이너는 9개월째 재시작 없이 운영 중 → 운 좋게 유지 중
- **마이그레이션 시 컨테이너 재생성되므로 이미지 소실 발생**

→ 이번 기회에 **영속 bind mount 추가**로 근본 해결.

#### 📦 수정안

**서버 fs-02에 디렉터리 미리 생성:**
```bash
mkdir -p /home/ubuntu/desktop/deploy/sys/registry/data
```

**`infra/docker-stack.yml` registry 서비스:**
```yaml
  registry:
    image: registry:2
    ports:
      - target: 5000
        published: 5000
        mode: ingress
    environment:
      REGISTRY_CONFIGURATION_PATH: /etc/docker/registry/config.yml
    volumes:
      # 인증 파일 (기존)
      - /home/ubuntu/desktop/deploy/sys/registry/auth:/auth
      # config.yml (기존 — 이미 정상)
      - /home/ubuntu/desktop/deploy/sys/registry/config.yml:/etc/docker/registry/config.yml
      # ⭐ 이미지 저장 영속 bind (신규 — 기존에 없던 것)
      - /home/ubuntu/desktop/deploy/sys/registry/data:/var/lib/registry
    networks:
      - sys_default
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.labels.infra_registry == 1
      update_config:
        parallelism: 1
        order: stop-first
      restart_policy:
        condition: on-failure
```

#### ⚠️ 마이그레이션 시 주의

**무손실 이동 절차** (Phase 5-0):
```bash
# fs-02에서 실행
mkdir -p /home/ubuntu/desktop/deploy/sys/registry/data

# 기존 컨테이너 내부 이미지를 서버로 복사
CONTAINER=$(docker ps --filter "name=sys_registry" -q | head -1)
docker cp ${CONTAINER}:/var/lib/registry/. /home/ubuntu/desktop/deploy/sys/registry/data/
# → 수 MB ~ 수백 MB, 수 초 ~ 수십 초 소요

# 이후 Phase 5에서 서비스 재생성 시, 새 컨테이너가 data/ 를 bind mount → 기존 이미지 보존
```

### 3. `.github/workflows/deploy-to-oci.yml` (앱 배포 — 변경)

```yaml
name: Deploy NestJS to Docker Swarm

on:
  push:
    branches: [main]
    paths-ignore:
      - 'infra/docker-stack.yml'
      - 'infra/docker-stack.monitoring.*.yml'
      - 'infra/prometheus/**'
      - 'infra/alertmanager/**'
      - 'infra/grafana/**'
      - 'infra/loki/**'
      - 'infra/promtail/**'
      - 'docs/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: prod
    steps:
      - uses: actions/checkout@v4

      - name: Log in to Docker Registry
        run: echo "${{ secrets.REGISTRY_PASSWORD }}" | docker login ${{ secrets.REGISTRY_URL }} -u ${{ secrets.REGISTRY_USERNAME }} --password-stdin

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and Push (SHA 태그)
        run: |
          SHORT_SHA=$(echo "${{ github.sha }}" | cut -c1-7)
          docker buildx build \
            --platform linux/amd64,linux/arm64 \
            -t ${{ secrets.REGISTRY_URL }}/prod_nest:${SHORT_SHA} \
            --provenance=false \
            --sbom=false \
            --push .

      - name: Rsync stack file + Deploy
        uses: appleboy/ssh-action@v1.0.0
        with:
          host: ${{ secrets.DEPLOY_SERVER }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.SWARM_MANAGER_SSH_KEY }}
          script: |
            SHORT_SHA=$(echo "${{ github.sha }}" | cut -c1-7)
            ENV_PATH="/home/ubuntu/desktop/deploy/sys/config/env/.env"

            # .env를 환경변수로 로드
            set -a; source "$ENV_PATH"; set +a

            # 스택 배포 (YAML이 모든 설정 포함 — 플래그 불필요)
            export REGISTRY_URL=${{ secrets.REGISTRY_URL }}
            export IMAGE_TAG=${SHORT_SHA}
            docker stack deploy \
              -c /home/ubuntu/desktop/deploy/infra/docker-stack.app.yml \
              --with-registry-auth \
              prod_nest
```

> **설정 변경 시**: YAML(`docker-stack.app.yml`) 수정 → merge → CI/CD가 `docker stack deploy` → 자동 적용
> **예**: replicas 3→5 → YAML에서 변경 → merge → 반영

### 4. `.github/workflows/deploy-infra.yml` (infra CI/CD — 신규)

```yaml
name: Deploy Infra Stack

on:
  push:
    branches: [main]
    paths:
      - 'infra/docker-stack.yml'
      - '.github/workflows/deploy-infra.yml'
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: prod
    steps:
      - uses: actions/checkout@v4

      - name: Rsync infra stack file
        run: |
          echo "${{ secrets.SWARM_MANAGER_SSH_KEY }}" > /tmp/ssh_key
          chmod 600 /tmp/ssh_key
          rsync -avz \
            -e "ssh -i /tmp/ssh_key -o StrictHostKeyChecking=no" \
            infra/docker-stack.yml \
            ${{ secrets.DEPLOY_USER }}@${{ secrets.DEPLOY_SERVER }}:/home/ubuntu/desktop/deploy/infra/
          rm /tmp/ssh_key

      - name: Deploy infra stack
        uses: appleboy/ssh-action@v1.0.0
        with:
          host: ${{ secrets.DEPLOY_SERVER }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.SWARM_MANAGER_SSH_KEY }}
          script: |
            cd /home/ubuntu/desktop/deploy
            docker stack deploy -c infra/docker-stack.yml infra
            docker stack services infra
```

---

## 🚀 구현 단계

### Step 1 — 사전 준비 (서버 상태 캡처 ⚠️ 필수)

> 현재 서비스 설정을 정확히 모르는 상태. inspect 없이 YAML을 작성하면 설정 누락으로 마이그레이션 실패.
> **이 Step의 출력물이 이후 모든 Step의 입력.**

**서버에서 실행할 명령 (결과를 대화에 공유):**

```bash
# ──── 1. 서비스 설정 캡처 ────
echo "=== sys_express ==="
docker service inspect --pretty sys_express

echo "=== sys_next ==="
docker service inspect --pretty sys_next

echo "=== sys_registry ==="
docker service inspect --pretty sys_registry

# ──── 2. Caddyfile 확인 ────
echo "=== Caddyfile ==="
cat /home/ubuntu/desktop/deploy/infra/caddy/config/Caddyfile

# ──── 3. .env 서비스 참조 ────
echo "=== .env 서비스 참조 ==="
grep -iE 'HOST|URL|PORT|REGISTRY' /home/ubuntu/desktop/deploy/sys/config/env/.env

# ──── 4. 네트워크 ────
echo "=== sys_default ==="
docker network inspect sys_default --format '{{.Scope}} {{.Driver}} {{.IPAM.Config}}'
```

**inspect → YAML 매핑:**

| inspect 필드 | YAML 매핑 |
|-------------|----------|
| Replicas | `deploy.replicas` |
| Ports (Published/Target/Mode) | `ports` |
| UpdateConfig (Parallelism/Delay/Order) | `deploy.update_config` |
| RollbackConfig | `deploy.rollback_config` |
| RestartPolicy | `deploy.restart_policy` |
| Healthcheck | `healthcheck` |
| Placement Constraints | `deploy.placement.constraints` |
| Mounts | `volumes` |

### Step 1.3 — 모든 노드 공통 설정 (로그 rotation + 스왑 + NTP)

**각 노드(fs-01, fs-02, fs-03)에서 실행:**

```bash
# ──── 1. Docker 로그 rotation (에러 루프 시 컨테이너 로그 폭주 방지) ────
# 목적: 개별 컨테이너가 에러 로그 대량 출력 시 해당 컨테이너 로그 파일 크기 제한
# (※ fs-01의 60% 디스크 사용은 이미지 pull 누적 때문 — cron/cleanup_disk.sh가 자동 관리 중. 이 설정과 별개)
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
sudo systemctl restart docker
# ⚠️ docker restart 시 Swarm 서비스는 잠깐 중단 가능 → 한 노드씩 순차 실행

# ──── 2. vm.swappiness: 60 → 10 (현업 서버 표준) ────
# 현재 60 (Linux 기본 — 데스크톱용). 서버에선 10 권장.
# 60: 아이들 프로세스도 적극 스왑 → 재접속 시 지연
# 10: RAM 80%+ 찰 때만 스왑 → 활성 프로세스 응답 안정
# 0: 스왑 거의 미사용 → 1GB 환경에선 OOM 위험
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
sysctl vm.swappiness   # vm.swappiness = 10 확인

# ──── 3. NTP 동기화 확인 ────
timedatectl status
# "System clock synchronized: yes" + "NTP service: active" 확인

# ──── 4. Docker 엔진 버전 확인 ────
docker version --format '{{.Server.Version}}'
# 모든 노드 동일 버전인지 확인
```

⚠️ **Docker daemon 재시작 순서**: 전체 동시 재시작 금지. **Worker부터 한 대씩 → Leader 마지막**. 각 노드 재시작 후 `docker node ls` Status 모두 Ready 확인 후 다음 노드.

### 📌 권장 진행 순서 (요약)

```
[현재 — 서비스 영향 없음, 미리 해둬도 안전]
  ↓
  Step 1.5  신 라벨 병행 추가 (구 라벨 유지)
  Step 2    YAML/CI/CD 파일 작성 (로컬)
  ↓
[마이그레이션 타임 — 유지보수 시간대]
  ↓
  Step 3    Phase 0~7 실행 (GitHub Actions 중단 → 새 스택 배포 → Caddy 전환 → 구 서비스 삭제 → 구 라벨 제거 → 재개)
  ↓
[완료 후]
  ↓
  Step 4    검증
  Step 5    문서 정비
```

**Step 1.5 + Step 2는 언제든 미리 진행 가능** (서비스 무영향). 마이그레이션 준비 완료 후 Step 3만 유지보수 시간대에 실행.

---

### Step 1.5 — 노드 라벨 병행 추가 (✅ 지금 즉시 실행 가능, 서비스 무영향)

> 🔑 **핵심 전략**: 구 라벨(sys_*)은 그대로 두고 **신 라벨(prod_*, infra_*)을 추가만** 한다.
> → 구 서비스는 구 라벨로 계속 배치, 마이그레이션 때 새 서비스는 신 라벨로 배치.
> → 구 서비스 삭제 후 Phase 4/5에서 구 라벨 제거.

현재 라벨 분포 (확인 완료):
```
fs-01: sys_caddy=1, infra_redis=1, sys_express=1, sys_next=1
fs-02: sys_registry=1
fs-03: (없음)
```

**Rename 명령 (Swarm Manager 노드에서 실행):**

#### 🟢 지금 즉시 실행 (서비스 무영향)

구 라벨은 그대로 두고 **신 라벨만 추가**:

```bash
# fs-01: prod_nest, prod_next 라벨 추가 (sys_express, sys_next 구 라벨 유지)
docker node update \
  --label-add prod_nest=1 \
  --label-add prod_next=1 \
  fs-01

# fs-02: infra_registry 라벨 추가 (sys_registry 구 라벨 유지)
docker node update \
  --label-add infra_registry=1 \
  fs-02

# fs-03: 모니터링 phase에서 추가 예정 (prod_monitor_metrics=1 등)

# 확인
for node in fs-01 fs-02 fs-03; do
  echo "=== $node ==="
  docker node inspect --format '{{.Spec.Labels}}' $node
done
```

**예상 결과:**
```
fs-01: map[infra_redis:1 sys_caddy:1 sys_express:1 sys_next:1 prod_nest:1 prod_next:1]
fs-02: map[sys_registry:1 infra_registry:1]
fs-03: map[]
```

→ 구 서비스는 구 라벨로 계속 배치 (영향 없음), 새 서비스가 배포되면 신 라벨로 배치.

#### 🔴 구 라벨 제거 (Phase 4/5 이후, 구 서비스 삭제 후)

```bash
# Phase 4 이후 — sys_express, sys_next 구 서비스 삭제 완료 후
docker node update \
  --label-rm sys_express \
  --label-rm sys_next \
  fs-01

# Phase 5 이후 — sys_registry 삭제 완료 후
docker node update \
  --label-rm sys_registry \
  fs-02
```

⚠️ **순서가 중요**: 구 서비스가 아직 돌고 있을 때 라벨 제거하면 constraint 불일치로 서비스 Pending 상태. 반드시 `docker service rm` 후 라벨 제거.

### Step 2 — YAML/CI/CD 파일 작성 (✅ 지금 즉시 실행 가능, 로컬 작업)

> 신 라벨(`prod_nest=1`, `prod_next=1`, `infra_registry=1`) 기준으로 YAML 작성.
> 서비스 영향 없음. 마이그레이션 실행 전까지 PR/merge 안 하면 배포 안 됨.

- `infra/docker-stack.app.yml` — 앱 스택 YAML (inspect 기반)
- `infra/docker-stack.yml` 수정 — registry 추가
- `.github/workflows/deploy-to-oci.yml` 변경
- `.github/workflows/deploy-infra.yml` 신규
- (next-bun 레포) `infra/docker-stack.app.yml` + workflow
- **inspect 결과와 YAML 1:1 비교 검증**

### Step 3 — 마이그레이션 실행

#### 🎯 무중단 원칙 (앱 서비스)

```
신 생성 → Caddy 전환 → 구 삭제 → 구 라벨 제거
```

- **Phase 2 (신 생성)**: prod_nest, prod_next 배포 — 구 서비스와 공존. **트래픽은 아직 구 서비스로**
- **Phase 3 (Caddy 전환)**: Caddyfile reverse_proxy 대상 변경 — **atomic 전환, 다운타임 0**
- **Phase 4 (구 삭제)**: sys_express, sys_next 제거 + 구 라벨 제거 — 이미 트래픽 전환됨
- → **앱 서비스 다운타임 0**

#### ⚠️ Registry 예외

Registry는 포트 5000 ingress 점유로 신/구 공존 불가 → 10~30초 끊김 불가피. Phase 0 GitHub Actions 중단 상태에서 수행하므로 **실질 영향 0**.

**전체 순서: GitHub Actions 중단 → 새 스택 먼저 → Caddy 전환 → 구 서비스 삭제 → Registry 전환 → Actions 재개**

```bash
# ──── Phase 0: 마이그레이션 진입 (CI/CD 충돌 방지) ────
# 1. 팀 공지: main 브랜치 merge freeze (예: Slack/Discord)
# 2. GitHub Actions 일시 중단:
#    GitHub 저장소 → Settings → Actions → General → Disable Actions
#    (또는 workflow 파일의 on.push 섹션 임시 주석 처리 후 push)
# 3. 현재 진행 중인 CI/CD job 완료 대기

# ──── Phase 1: 이미지 준비 ────
docker pull ${REGISTRY_URL}/sys_express:latest
docker tag ${REGISTRY_URL}/sys_express:latest ${REGISTRY_URL}/prod_nest:migrate
docker push ${REGISTRY_URL}/prod_nest:migrate

docker pull ${REGISTRY_URL}/sys_next:latest
docker tag ${REGISTRY_URL}/sys_next:latest ${REGISTRY_URL}/prod_next:migrate
docker push ${REGISTRY_URL}/prod_next:migrate

# ──── Phase 2: 새 스택 배포 (구 서비스와 공존) ────
ENV_PATH="/home/ubuntu/desktop/deploy/sys/config/env/.env"
set -a; source "$ENV_PATH"; set +a

export REGISTRY_URL=fivesouth.duckdns.org
export IMAGE_TAG=migrate
docker stack deploy -c infra/docker-stack.app.yml --with-registry-auth prod_nest
# (next-bun 레포의 YAML로 prod_next도 동일)

# 새 서비스 정상 확인
docker service ps prod_nest_app   # 3/3 Running
docker service ps prod_next_app   # 20/20 Running

# ──── Phase 3: Caddyfile 전환 (서버 직접) ────
# sys_express:3500 → prod_nest_app:3500
# sys_next:3000 → prod_next_app:3000
# → Caddy --watch 자동 반영

# ──── Phase 4: 구 서비스 삭제 ────
docker service rm sys_express sys_next

# ──── Phase 5: registry infra 스택 합류 (⚠️ 10~30초 registry 끊김) ────
# GitHub Actions가 여전히 중단 상태인지 재확인 (Phase 0)

# 5-0. Registry 영속 저장 준비 (fs-02에서 실행)
# config.yml은 이미 존재. /var/lib/registry만 bind mount 추가 필요.

# 5-0-1. 이미지 저장 디렉터리 생성
mkdir -p /home/ubuntu/desktop/deploy/sys/registry/data

# 5-0-2. 기존 컨테이너 내부 이미지 복사 (무손실)
CONTAINER=$(docker ps --filter "name=sys_registry" -q | head -1)
docker cp ${CONTAINER}:/var/lib/registry/. /home/ubuntu/desktop/deploy/sys/registry/data/
ls -la /home/ubuntu/desktop/deploy/sys/registry/data/   # 복사 확인

# 5-1. sys_registry 삭제
docker service rm sys_registry

# 5-2. infra 스택 재배포 (registry 포함)
docker stack deploy -c infra/docker-stack.yml infra

# 5-3. registry 정상화 확인
docker service ps infra_registry     # Running 확인
curl -sf http://fivesouth.duckdns.org/v2/    # 응답 확인

# 5-4. Caddyfile 수정 (서버에서 직접)
# /v2/* 블록: sys_registry:5000 → infra_registry:5000
# → Caddy --watch 자동 반영

# ──── Phase 6: 최종 확인 ────
docker stack ls
docker service ls

# ──── Phase 7: GitHub Actions 재개 ────
# Settings → Actions → General → Enable
# 또는 workflow 파일 복구 commit
# 팀에 merge freeze 해제 공지
```

### Step 4 — 검증

```bash
docker stack ls
# infra       3
# prod_nest   1
# prod_next   1

docker service ls
# infra_caddy      2/2
# infra_redis      1/1
# infra_registry   1/1
# prod_nest_app    3/3
# prod_next_app    20/20

curl -s https://api.example.com/api/v1/health-check
# WebSocket, 프론트엔드 확인
```

### Step 5 — 문서 정비

- `CLAUDE.md` 업데이트
- `docs/deploy.md` 업데이트
- `infra/setup-redis.sh` 폐기
- `docker-compose.yml` 업데이트
- `tasks-monitoring.md` DNS: `tasks.sys_express` → `tasks.prod_nest_app`

---

## ✅ 실행 체크리스트

```
Step 1 — 사전 준비 (⚠️ 필수 — 이후 모든 Step의 기반):
  [x] docker service inspect --pretty sys_express → 완료
  [x] docker service inspect --pretty sys_next → 완료
  [x] docker service inspect --pretty sys_registry → 완료
  [x] inspect에서 확인: replicas, ports, update/rollback, healthcheck, mounts, constraints → 완료
  [x] .env REDIS_HOST=infra_redis 확인 완료
  [x] .env 서비스 참조 grep 완료 (EXPRESS_PORT, REDIS_HOST 등)
  [x] Caddyfile 내용 확인 완료 (서버 직접 관리)
  [x] sys_default 네트워크 설정 확인 완료 (swarm overlay)
  [x] 노드 라벨 분포 확인 완료 (fs-01: 앱 전체, fs-02: registry, fs-03: 비어있음)
  [x] CPU 아키텍처 확인 완료 (fs-01: arm64, fs-02/03: amd64)
  [x] fs-02, fs-03 메모리 baseline 확인 완료 (451/455MB 사용 중)
  [x] 모든 노드 Docker 로그 rotation 설정 완료 (max-size 10m, max-file 3)
  [x] 모든 노드 NTP 동기화 확인 완료 (3노드 전부 synchronized)
  [x] 모든 노드 vm.swappiness 60 → 10 완료 (스왑 사용량 즉시 감소 확인)
  [x] 모든 노드 Docker 엔진 버전 일치 확인 (전부 28.3.1)
  [x] 디스크 여유 확인 (fs-01 60%, fs-02 30%, fs-03 22%)

Step 1.5 — 노드 라벨 병행 추가 (완료):
  [x] fs-01에 prod_nest=1, prod_next=1 추가 완료
  [x] fs-02에 infra_registry=1 추가 완료
  [x] 3개 노드 라벨 확인 완료 (fs-01: 6개, fs-02: 2개, fs-03: 비어있음)
  [ ] ⚠️ 구 라벨 제거는 Phase 4/5 이후 (지금 제거하면 구 서비스 Pending)

Step 2 — YAML/CI/CD 작성:
  [ ] infra/docker-stack.app.yml 작성 (inspect 1:1 반영 + healthcheck 추가)
  [ ] infra/docker-stack.yml에 registry 추가 (bind mount 2개, REGISTRY_CONFIGURATION_PATH env)
  [ ] deploy-to-oci.yml 변경 (docker stack deploy 방식)
  [ ] deploy-infra.yml 신규 작성
  [ ] (next-bun) docker-stack.app.yml 작성
  [ ] (next-bun) src/app/api/health/route.ts 생성 (healthcheck 엔드포인트)
  [ ] (next-bun) 배포 워크플로우 수정
  [ ] inspect 결과와 YAML 1:1 비교 검증

Step 3 — 마이그레이션 실행:
  [ ] Phase 0: 팀에 merge freeze 공지 (Slack/Discord)
  [ ] Phase 0: GitHub Actions 중단 (Settings → Actions → Disable)
  [ ] Phase 0: 진행 중인 CI/CD job 완료 대기
  [ ] Phase 1: 이미지 re-tag + push (prod_nest:migrate, prod_next:migrate)
  [ ] Phase 2: docker stack deploy prod_nest / prod_next
  [ ] Phase 2 검증: prod_nest_app, prod_next_app healthy 상태 확인
  [ ] Phase 3: Caddyfile 전환 (서버 직접 — sys_express → prod_nest_app, sys_next → prod_next_app)
  [ ] Phase 3 검증: /api/v1/health-check 200 응답 + 프론트 정상 접근
  [ ] Phase 4: 구 서비스 삭제 (sys_express, sys_next)
  [ ] Phase 4: 구 노드 라벨 제거 (fs-01: sys_express, sys_next)
  [ ] Phase 5-0: fs-02에서 /home/ubuntu/desktop/deploy/sys/registry/data 디렉터리 생성
  [ ] Phase 5-0: 기존 컨테이너 /var/lib/registry 내용을 data/로 docker cp (무손실)
  [ ] Phase 5: sys_registry 삭제 + infra 스택 재배포
  [ ] Phase 5: Caddyfile /v2/* 경로 변경 (sys_registry → infra_registry)
  [ ] Phase 5 검증: curl fivesouth.duckdns.org/v2/ 응답 확인
  [ ] Phase 5 검증: 컨테이너 재시작 후 이미지 유지 확인 (docker service update --force infra_registry)
  [ ] Phase 5: 구 노드 라벨 제거 (fs-02: sys_registry)
  [ ] Phase 6: docker stack ls + service ls 최종 확인
  [ ] Phase 7: GitHub Actions 재개 + merge freeze 해제 공지

Step 4 — 검증:
  [ ] infra (3), prod_nest (1), prod_next (1) 스택 확인
  [ ] 5개 서비스 정상
  [ ] API 헬스체크 통과
  [ ] 프론트엔드 접근
  [ ] WebSocket (Socket.IO) 연결
  [ ] CI/CD 테스트: main push → prod_nest 스택 자동 배포
  [ ] infra CI/CD 테스트: docker-stack.yml 변경 → infra 자동 배포

Step 5 — 문서 정비:
  [ ] CLAUDE.md 업데이트
  [ ] docs/deploy.md 업데이트
  [ ] infra/setup-redis.sh 폐기
  [ ] docker-compose.yml 업데이트
  [ ] tasks-monitoring.md DNS: tasks.sys_express → tasks.prod_nest_app
  [ ] tasks-logging.md 참조 업데이트
```

---

## 🔄 롤백 절차

```bash
# Phase 2 실패 (새 스택이 안 뜸):
docker stack rm prod_nest prod_next
# → 구 서비스 그대로 운영 중 → 무영향

# Phase 3 실패 (Caddy 전환 후 502):
# Caddyfile 원복: prod_nest_app → sys_express → Caddy 자동 반영

# Phase 4 이후 (구 서비스 삭제 완료):
# 구 서비스 재생성 (inspect 캡처 기반)
docker service create --name sys_express --network sys_default \
  --replicas 3 --publish 23500:3500 --with-registry-auth \
  --image ${REGISTRY_URL}/sys_express:latest
# Caddyfile 원복
```

---

## ⚠️ 위험도 요약

| 작업 | 위험도 | 이유 |
|------|:---:|------|
| Step 1~2 (준비/YAML) | 🟢 낮음 | 서버 무영향 |
| Step 3 Phase 1~2 (이미지/스택) | 🟢 낮음 | 구 서비스 그대로, 새 스택 추가만 |
| Step 3 Phase 3 (Caddy 전환) | 🟡 중간 | 트래픽 전환 — 즉시 롤백 가능 |
| Step 3 Phase 4 (구 삭제) | 🟡 중간 | Phase 3 검증 후에만 진행 |
| Step 4~5 (검증/문서) | 🟢 낮음 | 서버 무영향 |

---

## 📚 참고

**수정 대상 파일:**

| 파일 | 변경 | 레포 |
|------|------|------|
| `infra/docker-stack.app.yml` | **신규** — 앱 스택 YAML (설정 원천) | bun |
| `infra/docker-stack.yml` | **수정** — registry 추가 (영속 bind 포함) | bun |
| 서버 fs-02 `/home/ubuntu/desktop/deploy/sys/registry/data/` | **신규 디렉터리** — 이미지 영속 저장 (config.yml은 정상, 변경 불필요) | 서버 |
| `.github/workflows/deploy-to-oci.yml` | **수정** — docker stack deploy 방식 | bun |
| `.github/workflows/deploy-infra.yml` | **신규** — infra 자동 배포 | bun |
| `infra/setup-redis.sh` | **폐기** | bun |
| `docker-compose.yml` | **수정** — 로컬 개발 | bun |
| `CLAUDE.md` | **수정** | bun |
| `docs/deploy.md` | **수정** | bun |
| `docs/tasks-monitoring.md` | **수정** — DNS `tasks.prod_nest_app` | bun |
| `infra/docker-stack.app.yml` | **신규** — 앱 스택 YAML | next-bun |
| `src/app/api/health/route.ts` | **신규** — healthcheck 엔드포인트 | next-bun |
| 배포 워크플로우 | **수정** — docker stack deploy 방식 | next-bun |
| Caddyfile | **수정** — `prod_nest_app:3500` (서버 직접, Git 안 함) | 서버 |

# Task Tracker: 모니터링 스택 (Prometheus + Grafana + node_exporter)

> 분리일: 2026-04-15 | 원본: `docs/tasks-nestjs-improvements.md` D10
> 최종 수정: 2026-04-16 (mobisell-back 패턴 비교 분석 반영 — sha256 config, shared 스택 분리, XFF 방어, QA 준비)
> 브랜치: `feat-onam`
> 상태: **추후 적용 예정** (미진행)
> **선행 작업**: [`tasks-swarm-stack-migration.md`](./tasks-swarm-stack-migration.md) — 서비스 이름 변경 (`prod_nest_app` → `prod_nest_app`, 스택 per 서비스 패턴) 완료 후 진행.
> 본 문서는 마이그레이션 완료 후 상태 기준으로 작성됨 (서비스 DNS: `prod_nest_app`, `prod_next_app`).
> 연관 문서: 로그 수집은 [`tasks-logging.md`](./tasks-logging.md) (Loki + Promtail)

---

## 📌 결정 사항 요약

| 항목 | 결정 | 근거 |
|------|------|------|
| 메트릭 경로 | `/api/v1/metrics` | NestJS globalPrefix `api/v1` 자동 적용 |
| 접근 제어 (1차) | **Caddyfile에서 `/api/v1/metrics` 외부 차단** (404) | Caddy가 기존 리버스 프록시로 동작 중 |
| 접근 제어 (2차) | **MetricsAccessMiddleware** — XFF 헤더 존재 시 즉시 차단(1차) + overlay 대역 IP 검증(2차) | mobisell-back 2단계 검증 패턴. Caddy가 외부 요청에 XFF 주입 → overlay 내부 Prometheus는 XFF 없음 |
| 미들웨어 등록 방식 | **`MiddlewareConsumer.apply().forRoutes()`** (app.module.ts) | NestJS 정석 패턴 |
| 모듈 등록 | `PrometheusModule.register({ path: 'metrics', defaultMetrics: { enabled: true } })` (app.module.ts) | globalPrefix 자동 적용 |
| 스택 분리 | **3개 스택**: 앱(개별 서비스) / **shared**(node_exporter+promtail) / **prod**(prometheus+grafana+alertmanager+loki) | mobisell-back 패턴. global 서비스(모든 노드)와 환경별 서비스 라이프사이클 분리 |
| 네트워크 연결 | `sys_default` (기존 앱 overlay)에 `external: true`로 참여 | 앱 스택 수정 0, 기존 DNS 재사용 |
| 설정 파일 주입 | **기본: Swarm `configs:`** (immutable). 단, **다중 파일 디렉터리(대시보드 JSON 등)는 bind mount** | 단일 YAML은 configs, 동적 디렉터리는 bind mount 하이브리드 |
| Config 버전 관리 | **sha256sum 12자 해시** → config `name:` 필드에 포함 (`prod_monitor_prometheus_yml_a1b2c3d4e5f6`) | mobisell-back 패턴. rolling update 시 무중단, 구 config 자동 보존. `docker config rm` 불필요 |
| QA 환경 준비 | QA 설정 파일은 `.disabled` 접미사로 비활성 보관 (예: `prometheus.qa.yml.disabled`) | 당분간 PROD 단일 운영, QA 도입 시 `.disabled` 제거 후 즉시 사용 |
| 외부 노출 (Grafana) | **Caddy 경유 + IP 화이트리스트 (1차) + Grafana admin 로그인 (2차)** | 재택/사무실 IP만 허용, 외부 접근 편의성 확보 |
| 외부 노출 (Prometheus/Alertmanager) | **SSH 터널로만 접근** (외부 노출 X) | 운영자 전용, 공격면 최소화 |
| 비밀번호 관리 | **기존 `.env` 주입 방식 그대로** (`.env` → `--env-add`) | GitHub Actions 워크플로우 재사용 |
| Grafana 환경변수 | `GRAFANA_HOSTNAME`, `GRAFANA_ALLOWED_IPS` (.env 추가) | Caddy 서브도메인 + IP 화이트리스트 |
| 배치 (선택 A) | 기존 앱 노드에 공존 (4 OCPU / 24GB, 여유 충분) | 운영 단순성 |
| 배치 (선택 B) | **OCI Always Free 1GB × 2 분리 배치** (fs-02, fs-03 / 스왑 2GB 적용 완료) | 앱 리소스 격리 (후술) |
| Prometheus retention | **7일** (`--storage.tsdb.retention.time=7d`) | 디스크 ~200MB/월 |
| scrape 간격 | `scrape_interval: 15s`, `scrape_timeout: 10s` | 표준값, 오버헤드 최소 |
| external_labels | `env=prod`, `cluster=oci-swarm` | Grafana 환경 필터링 + 멀티 환경 확장 대비 |
| Grafana Provisioning | **IaC** (`datasources.yml` + `dashboards.yml` + JSON 커밋) | 수동 설정 탈피, 서버 재배포 시 자동 재현 |
| Recording Rules | **사전 계산** (p95, error_rate, active_teams) | 대시보드 응답 속도 + 알림 안정성 |
| 알림 | **Alertmanager → Telegram** (기존 `BOT_TOKEN_TELEGRAM` 재사용) | 추가 서비스 없이 Telegram 통합 |
| bot_token 주입 | **Swarm secret → `bot_token_file`** (Alertmanager는 `${}` 치환 미지원) | YAML 환경변수 치환 실패 방지 |
| Grafana/Loki 볼륨 | `user:` 지시어로 uid 고정 (Grafana 472, Loki 10001) | 볼륨 권한 일관성 |
| CI/CD | **`deploy-monitoring.yml` 분리** + 앱 워크플로우에 `paths-ignore` | 앱/모니터링 배포 라이프사이클 독립 |
| CI/CD 배포 순서 | **shared 스택 → prod 스택** (needs 의존성) | node_exporter/promtail이 먼저 떠야 prometheus scrape + loki push 가능 |
| 롤백 순서 | **prod 스택 → shared 스택 → 앱 스택 순서로 내림** | external 네트워크 의존성 방지 |

---

## 개요

- **난이도**: 보통 | **효과**: 높음 | **위험도**: 🟢 낮음
- **선행**: 없음 (독립)
- **프론트 영향**: 없음
- **참고 구현**: `../mobisell/mobisell-back` (GCP/QA 환경 — 패턴만 차용, 인프라 세부는 OCI로 재작성)

서버에서 측정값(응답 시간, 에러 수 등)을 수집 → Prometheus가 저장 → Grafana가 시각화.

---

## 🏗️ 배포 환경 메모 (불변 팩트 — 수정 전 반드시 참조)

> 이 섹션은 **프로젝트 인프라의 팩트**입니다. 문서 수정 시 이 값들을 근거로 삼고, 팩트 자체가 변경되면 이곳을 먼저 갱신하세요.

- **클라우드**: OCI (Oracle Cloud Infrastructure)
- **오케스트레이션**: Docker Swarm
- **앱 배포 방식**: **`docker stack deploy`** (스택 per 서비스 — `prod_nest`, `prod_next` 각 1 service)
- **리버스 프록시**: **Caddy** (infra 스택, 포트 80/443, `infra_caddy` 라벨 노드 고정, replicas 2)
- **앱 서비스 DNS**: `prod_nest_app` (NestJS, globalPrefix `/api/v1`, 포트 3500), `prod_next_app` (Next.js, 3000)
- **Redis**: `infra_redis` (infra 스택, 128mb maxmemory)
- **Registry**: `infra_registry` (infra 스택)
- **네트워크**: `sys_default` (overlay, external) — 모든 스택 참여
- **기본 서버**: 4 OCPU / 24GB RAM (Always Free **ARM** A1.Flex → **arm64**)
- **모니터링 전용 인스턴스**: `fs-02`, `fs-03` (각 1 OCPU / 1GB RAM / 스왑 2GB — Always Free **AMD** E2.1.Micro → **amd64**)
- ⚠️ **아키텍처 혼합 환경**: 모든 이미지 multi-arch 필수. 본 문서에 사용된 공식 이미지(prometheus, grafana, alertmanager, loki, node-exporter, promtail)는 모두 multi-arch 지원
- **배포**: `main` push → GitHub Actions → `docker stack deploy -c docker-stack.app.yml prod_nest`
- **서버 env 파일**: `/home/ubuntu/desktop/deploy/sys/config/env/.env` (평문, `.env` → `--env-add`)
- **Caddyfile 위치** (서버): `/home/ubuntu/desktop/deploy/infra/caddy/config/Caddyfile`
- **Caddy 리로드**: `--watch` 플래그로 파일 변경 자동 감지 (caddy reload 명령 불필요)

---

## 🎯 배치 전략 (중요)

### 옵션 A — 기존 앱 노드에 공존 (간단)
- 24GB RAM 여유 충분, 리소스 격리만 덜 됨
- **라벨 체계는 옵션 B와 동일 유지** (역할별 분리)
  - Prometheus/Promtail/node_exporter/Alertmanager 배치 노드: `node.labels.prod_monitor_metrics == 1`
  - Grafana/Loki 배치 노드: `node.labels.prod_monitor_view == 1`
- 두 라벨을 **같은 노드**에 동시 부여 가능 (모든 서비스 한 노드 공존):
  ```bash
  docker node update --label-add prod_monitor_metrics=1 --label-add prod_monitor_view=1 <node>
  ```
- 옵션 A→B 전환 시 docker-stack 파일 수정 불필요, 노드 라벨만 이동하면 됨

### 옵션 B — OCI Always Free 1GB × 2 분리 배치 (권장)
Always Free tier AMD VM.Standard.E2.1.Micro (1 OCPU / 1GB RAM) 2대 활용. **fs-02, fs-03** (스왑 2GB 적용 완료).

#### 🧮 실측 기반 리소스 분석 (1GB RAM + 2GB 스왑)

**⚠️ 현재 실측 baseline (2026-04-16 측정):**
```
fs-02: Used 451Mi, Available 505Mi, Swap 111Mi  (infra_registry 포함, 당시엔 sys_registry)
fs-03: Used 455Mi, Available 501Mi, Swap 127Mi  (서비스 없음, OS+Docker만)
```
→ OS + Docker baseline이 **300MB가 아닌 실측 ~450MB**. 예상보다 150MB 더 높음. 이미 스왑 ~120MB 사용 중.

**fs-02 (메트릭) — infra_registry + Prometheus + Alertmanager + node_exporter + promtail-prod**

| 상태 | RAM 사용량 | 여유 | 스왑 사용 |
|------|-----------|------|----------|
| **현재 baseline** (infra_registry 포함) | ~451MB | 505MB | 111MB |
| + 정상 운영 (prometheus + alertmanager + 에이전트 아이들) | ~705MB | 250MB | 100~200MB |
| + 스파이크 (쿼리 + 컴팩션 동시) | ~850MB | ~100MB | 200~400MB |
| + 이상 스파이크 (장기 쿼리 + GC) | ~950MB+ | ~0MB | 400~600MB |

→ **평상시 OK**, 스파이크 시 스왑 400MB 이내 (2GB 스왑의 20%)

**fs-03 (시각화+로그) — Grafana + Loki + node_exporter + promtail-prod**

| 상태 | RAM 사용량 | 여유 | 스왑 사용 |
|------|-----------|------|----------|
| **현재 baseline** (서비스 없음) | ~455MB | 501MB | 127MB |
| + 아이들 (Grafana 아이들 150 + Loki 200 + 에이전트 30) | ~835MB | ~120MB | 150~300MB |
| + 대시보드 1~2개 열람 | ~900MB | ~50MB | 300~500MB |
| + 대시보드 + Loki 쿼리 병행 | ~1GB+ | ~0 | 500~800MB |

→ **아이들도 여유 타이트**, 대시보드 사용 시 스왑 적극 사용 (2GB 스왑의 25~40%)
→ **fs-03은 리스크 있음**. 아래 가드레일 필수 적용.

#### ✅ 2GB 스왑이 충분한 근거

1. **스파이크 최대치가 예상 스왑 사용량보다 훨씬 큰 여유**: Loki + Grafana 동시 스파이크에서도 스왑 300MB → 2GB 대비 15%만 사용
2. **지속적 스왑 사용이 아니라 일시적 완충**: 쿼리 끝나면 RAM으로 복귀
3. **swap thrashing만 막으면 성능 영향 미미**: `vm.swappiness=10`으로 RAM 우선 사용

#### ⚠️ 주의할 실패 시나리오

| 시나리오 | 증상 | 기술적 대응 | 운영 규칙 |
|---------|------|------------|----------|
| Loki 로그 수집 폭증 | Loki 메모리 ↑↑, OOM 위험 | `limits_config.ingestion_rate_mb: 4` + `memory: 400M` limit | — |
| Prometheus 장기 쿼리 | RAM 부족 → 스왑 → CPU wait | `queryTimeout: 30s`, Recording Rules 사전 계산, `memory: 400M` | 범위 긴 쿼리 지양 |
| Grafana 자동 새로고침 남발 | 쿼리 부하 ↑ | `GF_DASHBOARDS_MIN_REFRESH_INTERVAL=30s` | — |
| 대시보드 동시 열람 | Grafana 메모리 튐 | `memory: 350M` limit (OOM 보호만) | **1~2인 동시 접속 원칙** (팀 합의 — OSS Grafana는 동시 접속자 제한 설정 없음) |
| Prometheus 컴팩션 + 쿼리 | 메모리 스파이크 | retention 7d, 스왑 완충 | — |

#### 🛡️ Docker 서비스 memory limit 설정 (필수)

1GB RAM 노드에서는 **컨테이너별 memory limit 필수** (하나가 폭주해도 다른 서비스 보호):

```yaml
# docker-stack.monitoring.yml / monitoring.shared.yml 각 서비스에 추가
deploy:
  resources:
    limits:
      memory: 400M   # 서비스별 상한
```

**권장 memory limits (fs-02/fs-03 1GB 노드 기준):**

| 서비스 | limit | 근거 |
|--------|-------|------|
| prometheus | 400M | 평상시 200MB + 컴팩션 버퍼 |
| alertmanager | 100M | 평상시 25MB + 알림 burst 버퍼 |
| grafana | 350M | 아이들 150 + 대시보드 사용 시 버퍼 |
| loki | 400M | 수집 + 쿼리 버퍼 |
| node_exporter | 50M | 경량 |
| promtail-prod | 100M | 로그 수집 에이전트 |
| infra_registry | 200M | (fs-02만, 기존 서비스) |

**네트워크 구성**:
- VCN 내 private IP 통신 (외부 노출 없음)
- Swarm worker 노드로 join → `node.labels` 설정
  - fs-02: `node.labels.prod_monitor_metrics == 1`
  - fs-03: `node.labels.prod_monitor_view == 1`
- 서비스 배치를 constraint로 고정

**주의**:
- **스왑 2GB 적용 완료** (fs-02, fs-03 각 2GB) — 스파이크 흡수에 충분
- Prometheus retention 7일 유지 가능 (청크 ~200MB)
- Grafana는 사용 시에만 메모리 튀므로 여유 확보 필요
- `vm.swappiness=10` 권장 (RAM 우선 사용, 꼭 필요할 때만 스왑 — swap thrashing 방지)
- **지속 스왑 사용률 모니터링**: `node_memory_SwapFree_bytes` 가 스왑 전체의 50% 이하로 지속되면 경고 알림

---

## 🔌 구성

```
[외부 사용자]           [운영자 PC]                    [운영자 SSH]
      ↓                      ↓                              ↓
      │ HTTPS api.example.com │ HTTPS grafana.example.com  │ SSH -L
      │ (일반 요청)            │ (IP 화이트리스트)           │
      ↓                      ↓                              │
                [Caddy (infra_caddy, replicas=2)]           │
                ├── api.example.com → prod_nest_app:3500       │
                │   (/api/v1/metrics → 404)                  │
                └── grafana.example.com → tasks.prod_monitor_grafana:3000 │
                    (remote_ip 화이트리스트)                  │
                             │  (sys_default overlay)        │
                             ↓                               ↓
[NestJS prod_nest_app] ─── Pino JSON stdout ─────┐    [Prometheus :9090]
      ↑                                          │    [Alertmanager :9093]
      │ (15s scrape, tasks.prod_nest_app DNS)      │ docker logs
      │                                          ↓
─── shared 스택 (monitor_shared) ─────────────────────────
[node_exporter] ←─ scrape ─┐              [Promtail (global)]
(global, overlay 내부만)    │                    │ push
────────────────────────────────────────────────────────────────
                            │                    ↓
─── prod 스택 (prod_monitor) ──────────────────────────────────
                     [Prometheus] (fs-02)   [Loki] (fs-03)
                      │    ↑                     ↑
                      │    │ rule eval            │ query
                      ↓    │                      │
              [Alertmanager] (fs-02)              │
                      ↓ bot_token_file            │
                [Telegram]                        │
                                                  │
              [Grafana] (fs-03) ──── datasources ─┘
                                      ├── Prometheus (uid: prometheus)
                                      └── Loki (uid: loki)
                                      + Provisioning IaC
────────────────────────────────────────────────────────────────
```

**흐름 요약**:
- **메트릭**: NestJS `/metrics` → Prometheus scrape → (Recording Rules) → Grafana
- **로그**: NestJS Pino stdout → Docker → Promtail → Loki → Grafana
- **알림**: Prometheus alert rules → Alertmanager → Telegram
- **Drill-down**: Grafana Prometheus 패널 → Data Links → Loki LogQL 자동 쿼리

---

## 📦 패키지 및 도구

| 도구 | 역할 | 설치 위치 |
|------|------|----------|
| `prom-client` | Node.js 메트릭 라이브러리 | NestJS 앱 (npm) |
| `@willsoto/nestjs-prometheus` | NestJS 통합 모듈 | NestJS 앱 (npm) |
| Prometheus | 메트릭 수집·저장 서버 | Docker 컨테이너 |
| Grafana | 대시보드 시각화 | Docker 컨테이너 |
| node_exporter | 노드(OS) 메트릭 — CPU/RAM/디스크/네트워크 | Docker 컨테이너 (Swarm global mode, 모든 노드) |

---

## 📊 수집할 메트릭

### 1) prom-client (NestJS 앱 자동)

| 메트릭 | 타입 | 용도 |
|--------|------|------|
| `http_request_duration_seconds` | Histogram | API 응답 시간 분포 (p50/p95/p99) |
| `http_requests_total` | Counter | 총 요청 수 (method, status, route별) |
| `nodejs_heap_used_bytes` | Gauge | Node.js 힙 메모리 |
| `nodejs_eventloop_lag_seconds` | Gauge | 이벤트루프 지연 |
| `process_cpu_seconds_total` | Counter | 프로세스 CPU 사용 |

### 2) node_exporter (노드 OS 자동)

| 카테고리 | 대표 메트릭 | 용도 |
|---------|-----------|------|
| CPU | `node_cpu_seconds_total`, `node_load1/5/15` | 코어별 CPU, load average |
| 메모리 | `node_memory_MemAvailable_bytes`, `node_memory_MemTotal_bytes` | 가용/사용 메모리 |
| 디스크 | `node_filesystem_avail_bytes`, `node_disk_io_time_seconds_total` | 파티션 사용량, I/O |
| 네트워크 | `node_network_receive_bytes_total`, `node_network_transmit_bytes_total` | RX/TX |
| 파일시스템 | `node_filesystem_files_free` | inode 사용률 |

### 3) 커스텀 메트릭 (Socket.IO + Redis + 팀 비즈니스)

| 메트릭 | 타입 | 용도 | 구현 위치 |
|--------|------|------|----------|
| `ws_connections_active` | Gauge | WebSocket 접속자 수 | TeamGateway connect/disconnect |
| `ws_team_online_users` | Gauge (labels: `team_id`) | 팀별 현재 접속자 수 | OnlineUserService.getOnlineUsersCount() 주기적 갱신 |
| `ws_events_total` | Counter (labels: `event`) | WS 이벤트 발생 수 (taskCreated, commentCreated 등) | 각 gateway handler |
| `ws_event_duration_seconds` | Histogram (labels: `event`) | WS 이벤트 처리 시간 | gateway handler |
| `redis_connection_status` | Gauge | Redis 연결 상태 (0/1) | RedisIoAdapter |
| `redis_pubsub_messages_total` | Counter | Pub/Sub 메시지 수 | RedisIoAdapter (선택) |

---

## 💾 서버 부하

**메트릭 스택 단독**:

| 항목 | CPU | RAM | 디스크 |
|------|-----|-----|--------|
| prom-client (앱 내부) | ~0 | — | — |
| /metrics 엔드포인트 | ~5ms/호출 (15s 간격, 무시 가능) | — | — |
| Prometheus | ~0.5% | ~200MB | ~200MB/월 (7일) |
| Grafana | ~0.5% | ~150MB (아이들) / ~300MB (사용 시) | ~50MB |
| node_exporter (노드당) | ~0% | ~10MB | — |
| Alertmanager | ~0.1% | ~25MB | ~10MB |
| **메트릭 스택 소계** | **~1.1%** | **~385MB** | — |

**전체 스택 (Loki+Promtail 포함, `tasks-logging.md` 합계)**:

| 항목 | RAM | 디스크 |
|------|-----|--------|
| Loki | ~200MB | ~1~3GB/7일 |
| Promtail (노드당) | ~20MB | — |
| **전체 스택 합계** | **~605MB** | ~1~3GB/7일 + 200MB/월 |

| 옵션 | 상태 |
|------|------|
| 옵션 A (공존) | 24GB 서버에 전혀 문제 없음 |
| 옵션 B (1GB × 2 분리, 스왑 2GB) | fs-02 ~230MB, fs-03 ~370MB — 상세는 "배치 전략" 참조 |

---

## 🔒 보안 설계 (Caddy 2단 방어)

Caddy는 두 가지 역할 수행:
1. **앱 `/metrics` 경로 외부 차단** (404)
2. **Grafana를 외부 서브도메인으로 노출** + **IP 화이트리스트 1차 방화벽**

### 1차-a: `/metrics` 외부 차단

Caddyfile에 추가 (서버 `/home/ubuntu/desktop/deploy/infra/caddy/config/Caddyfile`):

```caddyfile
api.example.com {
    # /metrics 외부 접근 차단 (Prometheus는 overlay 내부 DNS로 직접 접근)
    @metrics path /api/v1/metrics /api/v1/metrics/*
    respond @metrics 404

    reverse_proxy prod_nest_app:3500
}
```

### 1차-b: Grafana 외부 노출 + IP 화이트리스트

```caddyfile
grafana.example.com {
    # 1차 방화벽: IP 화이트리스트 (운영자 IP만 허용)
    @allowed remote_ip {$GRAFANA_ALLOWED_IPS}
    handle @allowed {
        reverse_proxy tasks.prod_monitor_grafana:3000
    }

    # 차단 시 404 (403 대신 — 존재 자체를 숨김)
    handle {
        respond "Not Found" 404
    }

    # 접근 로그 (차단/허용 분석용)
    log {
        output file /data/grafana-access.log
        format json
    }
}
```

- `{$GRAFANA_ALLOWED_IPS}` — Caddy는 환경변수 치환 지원 (예: `GRAFANA_ALLOWED_IPS=203.0.113.5/32 203.0.113.6/32 10.0.0.0/8`)
- **공백 구분** 여러 IP/CIDR 지원
- **overlay DNS 사용** (`tasks.prod_monitor_grafana:3000`) — Grafana 컨테이너는 `ports: host` 제거, Caddy가 reverse_proxy로만 접근
- 차단 시 `404` 반환 (Grafana 존재 자체를 외부에 노출 안 함)

### Prometheus / Alertmanager — Caddy 경유 X

운영자 전용 도구이므로 **SSH 터널로만 접근** (외부 도메인 노출 안 함):
```bash
# Prometheus UI
ssh -L 9090:localhost:9090 ubuntu@<fs-02>
# Alertmanager UI
ssh -L 9093:localhost:9093 ubuntu@<fs-02>
```

### ⚠️ Caddy 컨테이너에 환경변수 전달 필수

`{$GRAFANA_ALLOWED_IPS}` 치환은 Caddy 프로세스의 env에서 읽어옴. 기존 `infra/docker-stack.yml`의 `caddy` 서비스에 environment 추가:

```yaml
# infra/docker-stack.yml (기존 파일 수정)
services:
  caddy:
    # ... 기존 설정 ...
    environment:
      GRAFANA_HOSTNAME: ${GRAFANA_HOSTNAME}
      GRAFANA_ALLOWED_IPS: ${GRAFANA_ALLOWED_IPS}
```

배포 시 `.env` → `--env-add` 주입 대상에 자동 포함 (기존 워크플로우 활용).

**주의**: Caddyfile 변경은 `--watch`로 자동 적용되지만 **env 변경은 Caddy 컨테이너 재시작** 필요:
```bash
docker service update --force infra_caddy
```

### 2차 방어 (Grafana) — admin 로그인

Grafana 자체 인증은 유지:
- `GF_SECURITY_ADMIN_USER` / `GF_SECURITY_ADMIN_PASSWORD` (.env 주입)
- `GF_USERS_ALLOW_SIGN_UP: "false"`, `GF_AUTH_ANONYMOUS_ENABLED: "false"`

### 2차 방어 (`/metrics`) — NestJS MetricsAccessMiddleware

`src/common/middleware/metrics-access.middleware.ts`:

```typescript
/**
 * /metrics 엔드포인트 접근 제한 미들웨어 (3중 방어의 2~3번째)
 *
 * 방어 계층:
 *  1차: Caddy — /api/v1/metrics 경로 외부 요청 404 응답 (Caddyfile)
 *  2차: XFF 헤더 존재 여부 — 외부 요청은 Caddy가 XFF를 반드시 주입하므로,
 *       overlay 내부 Prometheus 요청에는 XFF가 없음 → XFF 존재 시 즉시 차단
 *  3차: req.socket.remoteAddress — TCP 실제 연결 IP가 overlay 대역인지 검증
 *
 * 왜 2단계(XFF + IP) 모두 필요한가?
 *  - XFF 검사만으로는: overlay 내부에서 악의적 컨테이너가 XFF 없이 접근 가능
 *  - IP 검사만으로는: Caddy 우회 시 10.x 대역이 아닌 외부 IP만 차단 (XFF 탐지 누락)
 *  - 두 검사 조합 시: "XFF 없음 + overlay IP" 조건만 통과 → Prometheus만 허용
 *
 * 참고: mobisell-back 동일 패턴 (GCP LB → XFF 주입, Swarm overlay → XFF 없음)
 */
@Injectable()
export class MetricsAccessMiddleware implements NestMiddleware {
  // Docker Swarm overlay (10.0.0.0/8) + localhost (127.0.0.0/8) + IPv6 localhost (::1)
  private static readonly ALLOWED_IP_REGEX = /^(10\.|127\.|::1|::ffff:10\.|::ffff:127\.)/;

  private readonly logger = new Logger(MetricsAccessMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    // 2차 방어: XFF / X-Real-IP 헤더 존재 시 즉시 차단
    // Caddy가 외부 요청에 XFF를 주입하므로, overlay 내부 Prometheus는 XFF가 없음
    const xff = req.headers['x-forwarded-for'];
    const xRealIp = req.headers['x-real-ip'];

    if (xff || xRealIp) {
      this.logger.warn({
        msg: '/metrics 차단 (프록시 헤더 감지)',
        xff,
        xRealIp,
        remoteIp: req.socket.remoteAddress,
      });
      throw new ForbiddenException('Forbidden');
    }

    // 3차 방어: TCP 소스 IP가 overlay 대역인지 검증
    const remoteIp = req.socket.remoteAddress ?? '';

    if (!MetricsAccessMiddleware.ALLOWED_IP_REGEX.test(remoteIp)) {
      this.logger.warn({
        msg: '/metrics 차단 (비허용 IP)',
        remoteIp,
        userAgent: req.headers['user-agent'],
      });
      throw new ForbiddenException('Forbidden');
    }

    // 허용 요청은 로깅 안 함 (15초마다 호출되므로 노이즈 방지)
    next();
  }
}
```

**단위 테스트** (`metrics-access.middleware.spec.ts`): `it.each()` + `buildRequest()` 팩토리로 20+ 케이스.
- XFF/X-Real-IP 존재 시 차단 (overlay IP여도 XFF 있으면 차단)
- XFF 없음 + overlay IP → 허용
- XFF 없음 + 비허용 IP → 차단
- localhost (127.x, ::1) → 허용 (로컬 개발/테스트)
- IPv4-mapped IPv6 (`::ffff:10.x`, `::ffff:127.x`) → 허용

### 미들웨어 등록 — NestJS 정석 패턴

`src/app.module.ts`:

```typescript
@Module({
  imports: [
    PrometheusModule.register({
      path: 'metrics',  // globalPrefix 자동 적용 → /api/v1/metrics
      defaultMetrics: { enabled: true },
    }),
    // ...
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(MetricsAccessMiddleware)
      .forRoutes({ path: 'metrics', method: RequestMethod.GET });
  }
}
```

- `forRoutes({ path: 'metrics' })` — `api/v1` 프리픽스 없이 지정 (NestJS가 globalPrefix 자동 적용)
- `method: RequestMethod.GET`만 지정

---

## ⚠️ 주의 사항

- **Prometheus retention 7일**: `--storage.tsdb.retention.time=7d` (기본 15일 → 축소)
- **Grafana Provisioning (IaC)**: datasources/dashboards는 Swarm configs, 대시보드 JSON은 bind mount (`infra/grafana/provisioning/dashboards/json/`). UI 수정 후 export → Git 커밋 플로우
- **커스텀 메트릭**: ws_connections_active 등은 Gateway에서 직접 카운터 증감
- **Swarm DNS**: `tasks.prod_nest_app`로 레플리카 개별 scrape
- **node_exporter**: Swarm `global` mode 등록 (레플리카 수 무관, 노드마다 1개)
- **팀별 Gauge 갱신**: 매 요청 호출 금지 → **주기 갱신(30s~1m) 또는 joinTeam/leaveTeam 이벤트 시점 갱신**
- **configs immutable + sha256 버전 관리**: Swarm config는 수정 불가 → `name:` 필드에 파일 sha256 해시 12자 포함 (예: `prod_monitor_prometheus_yml_a1b2c3d4e5f6`). 파일 변경 시 새 해시로 새 config 자동 생성, 구 config는 서비스 업데이트까지 유지 → **무중단 rolling update**
- **configs 이름 규약**: compose 참조 키는 `prod_monitor_{service}_{file}`, 실제 Swarm config 이름은 `prod_monitor_{service}_{file}_{hash12}`. 전체 목록 (8개, 2개 스택 분산):
  - **shared 스택** (2개): `prod_monitor_promtail_yml`
  - **prod 스택** (6개): `prod_monitor_prometheus_yml`, `prod_monitor_recording_yml`, `prod_monitor_alerts_yml`, `prod_monitor_alertmanager_yml`, `prod_monitor_grafana_datasources_yml`, `prod_monitor_grafana_dashboards_yml`, `prod_monitor_loki_yml`
- **configs 갱신 절차**: sha256 해시가 변경된 파일만 새 config 생성 → 스택 재배포 시 서비스가 새 config 참조. **`docker config rm` 불필요** (미사용 config은 별도 정리 스크립트로 제거)
- **롤백 순서**: external 네트워크 의존성 방지 위해 **prod_monitor → monitor_shared → 앱 스택(prod_nest/prod_next) → infra** 순서로 내림
- **1GB 인스턴스 스왑**: **2GB 적용 완료** (fs-02, fs-03 각 2GB) — 스파이크 완충 충분
- **swap thrashing 주의**: `vm.swappiness=10` 설정 + 지속 스왑 사용률 모니터링 (`node_memory_SwapFree_bytes` 알림)
- **Prometheus scrape**: `scrape_interval: 15s`, `scrape_timeout: 10s` (타임아웃 < 인터벌)

---

## 🚀 구현 단계

> ⚠️ **스택은 2개 파일로 분리됩니다** (mobisell-back shared 패턴):
>
> | 스택 | 파일 | 서비스 | 배포 순서 |
> |------|------|--------|----------|
> | `monitor_shared` | `infra/docker-stack.monitoring.shared.yml` | node_exporter (global), promtail-prod (global) | **1번째** |
> | `prod_monitor` | `infra/docker-stack.monitoring.yml` | prometheus, grafana, alertmanager, loki | **2번째** |
>
> - **shared 스택**: 모든 노드에서 실행되는 에이전트 (환경 무관, QA 추가 시에도 1개)
> - **prod 스택**: 환경별 메트릭/로그 저장·시각화 (QA 추가 시 별도 `docker-stack.monitoring.qa.yml` 생성)
> - 두 스택 모두 `sys_default` (external overlay) 참여
> - **Config 이름에 sha256 해시 12자 포함** → rolling update 무중단 (CI/CD에서 자동 계산)
>
> Step별 발췌 예시에서 최상위 블록이 반복되는 것은 **문서 편의상 컨텍스트 제공**일 뿐입니다.



### Step 0 — 인프라 준비 (옵션 A 또는 B 공통)

#### 옵션 A — 기존 앱 노드에 공존
- 기존 앱 노드 중 1~2대 선정 (24GB RAM 여유 충분)
- 노드 라벨 부여 (공존 배치: 한 노드에 두 라벨 동시 부여 가능):
  ```bash
  docker node update --label-add prod_monitor_metrics=1 --label-add prod_monitor_view=1 <app-node-name>
  ```

#### 옵션 B — OCI Always Free 1GB × 2 분리 배치 (권장)
- OCI 콘솔에서 Always Free AMD VM 2대 프로비저닝 (1 OCPU / 1GB RAM 각) — **완료**
- 각 인스턴스 **스왑 2GB 적용 완료** + `vm.swappiness=10` 설정 권장
- VCN 내 private IP 통신 허용 (ingress rule)
- Swarm 관리 노드에서 `docker swarm join-token worker` 발급 → fs-02, fs-03 join
- 노드 라벨 부여:
  ```bash
  docker node update --label-add prod_monitor_metrics=1 fs-02
  docker node update --label-add prod_monitor_view=1 fs-03
  ```

### Step 1 — NestJS 앱에 prom-client + 보안 미들웨어

- `pnpm add prom-client @willsoto/nestjs-prometheus`
- `PrometheusModule.register()` in `src/app.module.ts`
- `src/common/middleware/metrics-access.middleware.ts` 작성 (ALLOWED_IP_REGEX 상수화 + JSDoc)
- `src/common/middleware/metrics-access.middleware.spec.ts` 단위 테스트 15+ 케이스 (`it.each()`)
- `AppModule implements NestModule` + `configure(consumer)` + `MiddlewareConsumer.apply().forRoutes()`
- `/api/v1/metrics` 로컬 접근 확인

### Step 2 — Caddy 차단 규칙 + Prometheus + node_exporter

**2-1. Caddyfile 수정**
- `/api/v1/metrics` 차단 규칙 추가 (`respond @metrics 404`)
- `caddy reload` (Caddy는 `--watch`로 자동 반영)

**2-2. `infra/prometheus/prometheus.yml` 작성**
```yaml
global:
  scrape_interval: 15s
  scrape_timeout: 10s
  external_labels:
    env: prod
    cluster: oci-swarm

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['tasks.prod_monitor_alertmanager:9093']

rule_files:
  - 'rules/*.yml'

scrape_configs:
  # 앱 서비스 (overlay 내부 DNS — 레플리카 개별 scrape)
  - job_name: 'prod_nest_app'
    metrics_path: /api/v1/metrics
    dns_sd_configs:
      - names: ['tasks.prod_nest_app']
        type: A
        port: 3500

  # node_exporter (shared 스택에서 global 배포 — overlay DNS로 각 task IP 접근)
  # ⚠️ 스택명이 monitor_shared이므로 DNS가 tasks.monitor_shared_node_exporter
  #    (OS 메트릭은 `/:/host:ro,rslave` 볼륨 마운트로 수집, 외부 호스트 포트 바인딩 불필요)
  - job_name: 'node_exporter'
    dns_sd_configs:
      - names: ['tasks.monitor_shared_node_exporter']
        type: A
        port: 9100

  - job_name: 'prometheus_self'
    static_configs:
      - targets: ['localhost:9090']
```

**2-3. `infra/docker-stack.monitoring.shared.yml` (node_exporter — shared 스택)**
> 🔖 node_exporter와 promtail은 **shared 스택**으로 분리 (모든 노드에서 global 실행)

```yaml
version: '3.9'

services:
  node_exporter:
    image: prom/node-exporter:v1.8.2
    command:
      - '--path.rootfs=/host'
    volumes:
      - '/:/host:ro,rslave'   # OS 메트릭 수집 (호스트 루트 read-only)
    networks:
      - sys_default
    deploy:
      mode: global   # 모든 노드에 1개씩 자동 배포
    # ports: 섹션 없음 → overlay 내부에서만 접근 (tasks.monitor_shared_node_exporter:9100)

networks:
  sys_default:
    external: true
```

**2-4. `infra/docker-stack.monitoring.yml` (Prometheus — prod 스택, 발췌)**
> 🔖 Step별 예시는 부분 발췌입니다. **실제 배포 파일은 문서 말미 "📦 최종 docker-stack" 섹션 기준**.

```yaml
version: '3.9'

services:
  prometheus:
    image: prom/prometheus:v3.4.1
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=7d'
      - '--web.enable-lifecycle'   # /-/reload 지원
    configs:
      - source: prod_monitor_prometheus_yml
        target: /etc/prometheus/prometheus.yml
      - source: prod_monitor_recording_yml
        target: /etc/prometheus/rules/recording.yml
      - source: prod_monitor_alerts_yml
        target: /etc/prometheus/rules/alerts.yml
    volumes:
      - prometheus-data:/prometheus
    networks:
      - sys_default
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.labels.prod_monitor_metrics == 1
    ports:
      - target: 9090
        published: 9090
        mode: host   # SSH 터널 접근, 외부 노출 X

configs:
  # sha256 해시 12자로 immutable config 버전 관리 (CI/CD에서 자동 계산)
  prod_monitor_prometheus_yml:
    name: prod_monitor_prometheus_yml_${PROM_CFG_HASH:-latest}
    file: ./infra/prometheus/prometheus.yml
  prod_monitor_recording_yml:
    name: prod_monitor_recording_yml_${RECORDING_CFG_HASH:-latest}
    file: ./infra/prometheus/rules/recording.yml
  prod_monitor_alerts_yml:
    name: prod_monitor_alerts_yml_${ALERTS_CFG_HASH:-latest}
    file: ./infra/prometheus/rules/alerts.yml

volumes:
  prometheus-data:

networks:
  sys_default:
    external: true   # 기존 앱 overlay에 참여
```

- **sha256 config naming**: `name:` 필드에 해시 포함 → 파일 변경 시 새 config 자동 생성, 무중단 rolling update
- 서버 `.env`에 `PROMETHEUS_RETENTION=7d` (선택, 현재는 command 인수로 고정)

### Step 3 — Grafana (.env 주입 + Provisioning IaC)

**3-1. 기본 컨테이너 설정**

- 서버 `.env`에 `GRAFANA_ADMIN_USER=admin`, `GRAFANA_ADMIN_PASSWORD=<강한 비밀번호>` 추가
- **Provisioning 하이브리드** (결정 사항 표 L22와 일관):
  - `datasources.yml`, `dashboards.yml` — 단일 YAML → Swarm **configs** 주입 (immutable)
  - `dashboards/json/*.json` — 다중 파일 디렉터리 → **bind mount** (Git 커밋 후 서버 sync)
- `docker-stack.monitoring.yml` (prod 스택)에 grafana 서비스 추가 (→ 최종 합본은 문서 말미 참조):

```yaml
grafana:
  image: grafana/grafana:12.1.0
  user: "472:472"   # Grafana 기본 uid/gid — 볼륨 권한 일관성
  environment:
    GF_SECURITY_ADMIN_USER: ${GRAFANA_ADMIN_USER}
    GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD}
    GF_PATHS_PROVISIONING: /etc/grafana/provisioning
    GF_USERS_ALLOW_SIGN_UP: "false"
    GF_AUTH_ANONYMOUS_ENABLED: "false"
    # Caddy 경유 도메인 접속 지원 (cookie secure/domain 등)
    GF_SERVER_ROOT_URL: "https://${GRAFANA_HOSTNAME}/"
    GF_SERVER_DOMAIN: "${GRAFANA_HOSTNAME}"
  configs:
    - source: prod_monitor_grafana_datasources_yml
      target: /etc/grafana/provisioning/datasources/datasources.yml
    - source: prod_monitor_grafana_dashboards_yml
      target: /etc/grafana/provisioning/dashboards/dashboards.yml
  volumes:
    - grafana-data:/var/lib/grafana
    # 대시보드 JSON은 디렉터리 단위 관리 → bind mount (read-only)
    - /home/ubuntu/desktop/deploy/infra/grafana/provisioning/dashboards/json:/etc/grafana/provisioning/dashboards/json:ro
  networks:
    - sys_default
  deploy:
    replicas: 1
    placement:
      constraints:
        - node.labels.prod_monitor_view == 1   # fs-03 (옵션 A/B 공통)
  # ports: 섹션 없음 → overlay 내부에서만 노출 (Caddy가 tasks.prod_monitor_grafana:3000으로 reverse_proxy)

configs:
  prod_monitor_grafana_datasources_yml:
    file: ./infra/grafana/provisioning/datasources/datasources.yml
  prod_monitor_grafana_dashboards_yml:
    file: ./infra/grafana/provisioning/dashboards/dashboards.yml

volumes:
  grafana-data:
```

- 배포 시 `.env` → `--env-add` 패턴으로 주입 (기존 앱 배포와 동일)
- **Caddy가 HTTPS terminate** 후 overlay 내부(`tasks.prod_monitor_grafana:3000`)로 reverse_proxy
- 추가 서버 `.env` 값:
  - `GRAFANA_HOSTNAME=grafana.example.com`
  - `GRAFANA_ALLOWED_IPS=203.0.113.5/32 203.0.113.6/32` (공백 구분, CIDR 지원)

**3-2. Grafana Provisioning (IaC)** ⭐
수동 UI 설정 대신 파일로 관리 — 서버 이전/재배포 시에도 동일 상태 재현.

```
infra/grafana/provisioning/
├── datasources/
│   └── datasources.yml     # Prometheus (+ 나중에 Loki) 자동 등록
└── dashboards/
    ├── dashboards.yml      # 디스커버리 설정
    └── json/
        ├── nodejs.json     # ID 11159 JSON 저장
        ├── node-exporter.json  # ID 1860 JSON 저장
        └── fivesouth-custom.json  # 커스텀 대시보드
```

`infra/grafana/provisioning/datasources/datasources.yml`:
```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus         # ← 고정 UID (Loki derivedFields가 이 UID 참조)
    type: prometheus
    access: proxy
    url: http://tasks.prod_monitor_prometheus:9090
    isDefault: true
    editable: false
    jsonData:
      timeInterval: "15s"
  # (Loki 도입 시 아래에 blocks append — 최종 모습은 `tasks-logging.md` Step 4 참조)
```

`infra/grafana/provisioning/dashboards/dashboards.yml`:
```yaml
apiVersion: 1
providers:
  - name: 'default'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: false
    editable: true
    updateIntervalSeconds: 30
    options:
      path: /etc/grafana/provisioning/dashboards/json
```

- **파일 주입 방식** (Step 3-1과 일관):
  - `datasources.yml`, `dashboards.yml` — Swarm `configs:` (단일 파일, immutable)
  - `dashboards/json/*.json` — **bind mount** (여러 파일 디렉터리 단위 관리)
- 대시보드 JSON은 Grafana UI에서 수동 import 후 **export → 파일 저장 → Git 커밋** 플로우로 관리
- 대시보드 import 대상: Node.js (Grafana.com ID `11159`), Node Exporter (ID `1860`), 커스텀 (팀별 접속자, WS 이벤트, Redis 상태)

### Step 4 — 커스텀 메트릭

- `ws_connections_active` (TeamGateway 연결/해제 시 증감)
- `ws_team_online_users{team_id}` (OnlineUserService 주기 갱신 30s~1m)
- `ws_events_total{event}` / `ws_event_duration_seconds{event}` (gateway handlers)
- `redis_connection_status` (RedisIoAdapter)
- (선택) 비즈니스 메트릭: 팀 생성 수, 태스크 완료율

### Step 4.5 — Recording Rules + Loki Drill-down 준비 ⭐

**Recording Rules** — 자주 쓰는 쿼리 사전 계산 (대시보드 응답 속도 향상 + 알림 안정성)

`infra/prometheus/rules/recording.yml`:
```yaml
groups:
  - name: http_recording
    interval: 30s
    rules:
      - record: job:http_request_duration_seconds:p95
        expr: histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))
      - record: job:http_requests:error_rate_5m
        expr: sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
  - name: ws_recording
    interval: 30s
    rules:
      - record: job:ws_team_active_teams
        expr: count(ws_team_online_users > 0)
```

- `prometheus.yml`에 `rule_files: ['rules/*.yml']` 추가
- rules도 Swarm `configs:`로 주입

**Loki Drill-down 준비** (Loki 도입 후 Data Links로 연결 — `tasks-logging.md` Step 6)

대시보드 패널의 **Data Links** 구성 템플릿 (메트릭 패널 → 해당 서비스의 에러 로그로 이동):
```
Title: "View error logs"
URL: /explore?left=%7B%22datasource%22:%22loki%22,%22queries%22:%5B%7B%22expr%22:%22%7Bservice%3D%5C%22prod_nest_app%5C%22%7D%20%7C%20json%20%7C%20level%3D%5C%22error%5C%22%22%7D%5D%7D
Open in new tab: true
```

- 메트릭 이상 발견 → 클릭 한 번에 동일 시간대 로그 조회
- Loki 도입 전까지는 Data Links는 비활성 (Loki 데이터소스가 없으면 에러)

### Step 5 — CI/CD 분리

**5-1. `.github/workflows/deploy-monitoring.yml` 신규**

```yaml
name: Deploy Monitoring Stack

on:
  push:
    branches: [main]
    paths:
      - 'infra/prometheus/**'
      - 'infra/alertmanager/**'
      - 'infra/grafana/**'
      - 'infra/loki/**'
      - 'infra/promtail/**'
      - 'infra/docker-stack.monitoring.yml'
      - 'infra/docker-stack.monitoring.shared.yml'
      - '.github/workflows/deploy-monitoring.yml'
  workflow_dispatch:   # 수동 배포 지원

jobs:
  # 1단계: shared 스택 (node_exporter + promtail-prod — 모든 노드)
  deploy-monitoring-shared:
    runs-on: ubuntu-latest
    environment: prod
    steps:
      - uses: actions/checkout@v4

      - name: Rsync infra files to server
        run: |
          echo "${{ secrets.SWARM_MANAGER_SSH_KEY }}" > /tmp/ssh_key
          chmod 600 /tmp/ssh_key
          rsync -avz --relative \
            -e "ssh -i /tmp/ssh_key -o StrictHostKeyChecking=no" \
            infra/ \
            ${{ secrets.DEPLOY_USER }}@${{ secrets.DEPLOY_SERVER }}:/home/ubuntu/desktop/deploy/
          rm /tmp/ssh_key

      - name: Deploy shared stack
        uses: appleboy/ssh-action@v1.0.0
        with:
          host: ${{ secrets.DEPLOY_SERVER }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.SWARM_MANAGER_SSH_KEY }}
          script: |
            cd /home/ubuntu/desktop/deploy

            # sha256 config 해시 계산 (shared 스택용)
            export PROMTAIL_CFG_HASH=$(sha256sum infra/promtail/promtail-config.yml | head -c 12)

            docker stack deploy -c infra/docker-stack.monitoring.shared.yml monitor_shared
            docker service ls | grep monitor_shared

  # 2단계: prod 스택 (prometheus + grafana + alertmanager + loki)
  deploy-monitoring-prod:
    needs: deploy-monitoring-shared   # shared가 먼저 떠야 scrape/push 가능
    runs-on: ubuntu-latest
    environment: prod
    steps:
      - uses: actions/checkout@v4

      - name: Deploy prod stack
        uses: appleboy/ssh-action@v1.0.0
        with:
          host: ${{ secrets.DEPLOY_SERVER }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.SWARM_MANAGER_SSH_KEY }}
          script: |
            cd /home/ubuntu/desktop/deploy
            ENV_PATH=/home/ubuntu/desktop/deploy/sys/config/env/.env
            set -a; source "$ENV_PATH"; set +a

            # sha256 config 해시 계산 (파일 변경 시 새 config 자동 생성, 무중단)
            export PROM_CFG_HASH=$(sha256sum infra/prometheus/prometheus.yml | head -c 12)
            export RECORDING_CFG_HASH=$(sha256sum infra/prometheus/rules/recording.yml | head -c 12)
            export ALERTS_CFG_HASH=$(sha256sum infra/prometheus/rules/alerts.yml | head -c 12)
            export ALERTMANAGER_CFG_HASH=$(sha256sum infra/alertmanager/alertmanager.yml | head -c 12)
            export GRAFANA_DS_CFG_HASH=$(sha256sum infra/grafana/provisioning/datasources/datasources.yml | head -c 12)
            export GRAFANA_DASH_CFG_HASH=$(sha256sum infra/grafana/provisioning/dashboards/dashboards.yml | head -c 12)
            export LOKI_CFG_HASH=$(sha256sum infra/loki/loki-config.yml | head -c 12)

            docker stack deploy -c infra/docker-stack.monitoring.yml prod_monitor
            docker service ls | grep prod_monitor

            # 미사용 config 정리 (현재 서비스가 참조하지 않는 구 버전 제거)
            echo "--- Cleaning up old configs ---"
            docker config ls --filter "name=prod_monitor_" --format "{{.Name}}" | while read cfg; do
              # 현재 사용 중인 config은 삭제 실패 (자동 스킵)
              docker config rm "$cfg" 2>/dev/null && echo "  removed: $cfg" || true
            done
```

**5-2. `.github/workflows/deploy-to-oci.yml`에 `paths-ignore` 추가**
```yaml
on:
  push:
    branches: [main]
    paths-ignore:
      - 'infra/prometheus/**'
      - 'infra/alertmanager/**'
      - 'infra/grafana/**'
      - 'infra/loki/**'
      - 'infra/promtail/**'
      - 'infra/docker-stack.monitoring.yml'
      - 'infra/docker-stack.monitoring.shared.yml'
      - 'docs/**'
```

**주의**: `infra/setup-redis.sh`, `infra/docker-stack.yml` 등 앱 관련 인프라 파일은 제외 안 함 (앱 배포 시 동반 갱신 필요). paths-ignore는 **모니터링 관련 경로만** 명시.

**5-3. sha256 config 버전 관리 원리**
```
파일 변경 전: prod_monitor_prometheus_yml_a1b2c3d4e5f6 (서비스가 참조 중)
파일 변경 후: prod_monitor_prometheus_yml_f6e5d4c3b2a1 (새로 생성)
                    ↓ stack deploy 시
서비스가 새 config 참조 → 구 config 미사용 → 정리 스크립트에서 제거
```
- `docker config rm`은 사용 중인 config 삭제 시 에러 → 안전하게 구 버전만 정리
- `docker-stack.yml`의 `configs:` 섹션에서 `name:` 필드에 `${HASH}` 환경변수 사용 (version 3.5+)

### Step 6 — 알림 (Alertmanager + Telegram)

**6-1. Alertmanager 서비스 추가** (Swarm secret 방식)

사전 준비 (서버 1회 실행):
```bash
# Swarm secret에 Telegram bot token 주입 (파일 방식으로 안전)
printf "%s" "$BOT_TOKEN_TELEGRAM" | docker secret create prod_monitor_bot_token -
```

`docker-stack.monitoring.yml` (prod 스택)에 추가 (→ 최종 합본은 문서 말미 "📦 최종 docker-stack" 섹션 참조):
```yaml
alertmanager:
  image: prom/alertmanager:v0.27.0
  command:
    - '--config.file=/etc/alertmanager/config.yml'
    - '--storage.path=/alertmanager'
  configs:
    - source: prod_monitor_alertmanager_yml
      target: /etc/alertmanager/config.yml
  secrets:
    - source: prod_monitor_bot_token
      target: /etc/alertmanager/secrets/bot_token
  volumes:
    - alertmanager-data:/alertmanager
  networks:
    - sys_default
  deploy:
    replicas: 1
    placement:
      constraints:
        - node.labels.prod_monitor_metrics == 1
  ports:
    - target: 9093
      published: 9093
      mode: host   # SSH 터널 접근, 외부 노출 X

configs:
  prod_monitor_alertmanager_yml:
    file: ./infra/alertmanager/alertmanager.yml

secrets:
  prod_monitor_bot_token:
    external: true   # 위 docker secret create 로 미리 생성

volumes:
  alertmanager-data:
```

**6-2. Alertmanager 설정 — Telegram 라우팅**

⚠️ **중요**: Alertmanager는 YAML에서 `${VAR}` 환경변수 치환을 **기본 지원하지 않음**. 아래 두 가지 방법 중 하나 사용:

**방법 A — `_file` suffix (권장)**: bot_token을 파일로 주입
```yaml
receivers:
  - name: 'telegram'
    telegram_configs:
      - bot_token_file: /etc/alertmanager/secrets/bot_token  # Swarm secret 파일
        chat_id: 123456789                                    # 리터럴 int
        parse_mode: 'HTML'
```
+ Swarm secret으로 파일 주입 (`docker-stack.monitoring.yml`):
```yaml
alertmanager:
  secrets:
    - source: prod_monitor_bot_token
      target: /etc/alertmanager/secrets/bot_token
secrets:
  prod_monitor_bot_token:
    external: true   # docker secret create prod_monitor_bot_token - <<< "$BOT_TOKEN"
```

**방법 B — 배포 시 `envsubst` 치환**: `alertmanager.tmpl.yml` → `alertmanager.yml`

배포 스크립트에서:
```bash
export BOT_TOKEN_TELEGRAM TELEGRAM_ALERT_CHAT_ID   # .env에서 로드
envsubst < infra/alertmanager/alertmanager.tmpl.yml > /tmp/alertmanager.yml
docker config create prod_monitor_alertmanager_yml /tmp/alertmanager.yml
```

`infra/alertmanager/alertmanager.tmpl.yml`:
```yaml
global:
  resolve_timeout: 5m

route:
  receiver: 'telegram'
  group_by: ['alertname', 'service']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
  - name: 'telegram'
    telegram_configs:
      - bot_token: '${BOT_TOKEN_TELEGRAM}'
        chat_id: ${TELEGRAM_ALERT_CHAT_ID}
        parse_mode: 'HTML'
        message: |
          🚨 <b>{{ `{{ .Status | toUpper }}` }}</b> [{{ `{{ .CommonLabels.severity }}` }}]
          <b>{{ `{{ .CommonLabels.alertname }}` }}</b>
          {{ `{{ range .Alerts }}`}}• {{ `{{ .Annotations.summary }}{{ end }}` }}
```
> 주의: Alertmanager 고유 템플릿(`{{ .Status }}` 등)은 envsubst가 건드리면 안 되므로 `{{ `` }}` 이스케이프 필수

**결정**: **방법 A (`_file`)** 권장 — 더 간단하고 Swarm secrets 표준 패턴. 방법 B는 CI/CD 복잡도 증가.

**6-3. 알림 규칙**

`infra/prometheus/rules/alerts.yml`:
```yaml
groups:
  - name: availability
    rules:
      - alert: AppDown
        expr: up{job="prod_nest_app"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "prod_nest_app 인스턴스 {{ $labels.instance }} 다운"

      - alert: HighErrorRate
        expr: job:http_requests:error_rate_5m > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "5xx 에러율 5% 초과 ({{ $value | humanizePercentage }})"

      - alert: HighHeapUsage
        expr: nodejs_heap_used_bytes / nodejs_heap_total_bytes > 0.9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Node.js 힙 사용률 90% 초과"

      - alert: RedisDown
        expr: redis_connection_status == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Redis 연결 끊김"

      - alert: DiskSpaceLow
        expr: node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"} < 0.15
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "디스크 여유 공간 15% 미만 ({{ $labels.instance }})"

      - alert: SwapHighUsage
        expr: (node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes) / node_memory_SwapTotal_bytes > 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "스왑 사용률 50% 초과 ({{ $labels.instance }}) — 지속 시 swap thrashing 위험"
```

**6-4. Prometheus → Alertmanager 연결**

`prometheus.yml`에 추가:
```yaml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['tasks.prod_monitor_alertmanager:9093']

rule_files:
  - 'rules/*.yml'
```

**6-5. 서버 `.env` 추가**
- `TELEGRAM_ALERT_CHAT_ID=<알림 전용 채팅방 ID>` — 기존 `BOT_TOKEN_TELEGRAM` 재사용, 채팅방만 신규

---

## ✅ 실행 체크리스트

```
Step 0 — 인프라 준비:
  [ ] 옵션 A (앱 노드 공존) — Step 0-A 수행
    [ ] 기존 앱 노드 중 1~2대 선정
    [ ] docker node update --label-add prod_monitor_metrics=1 --label-add prod_monitor_view=1 <node>
        (한 노드에 공존 배치하는 경우)
  [ ] 옵션 B (fs-02/fs-03 분리) — Step 0-B 수행
    [x] OCI Always Free AMD VM 2대 프로비저닝 (1 OCPU / 1GB) — 완료
    [x] 각 인스턴스 스왑 2GB 적용 — 완료 (fs-02, fs-03)
    [ ] vm.swappiness=10 설정 (RAM 우선 사용, swap thrashing 방지)
    [ ] VCN ingress rule: private IP 통신 허용
    [ ] Swarm worker로 join (fs-02, fs-03)
    [ ] docker node update --label-add prod_monitor_metrics=1 fs-02
    [ ] docker node update --label-add prod_monitor_view=1 fs-03

Step 1 — NestJS 앱:
  [ ] pnpm add prom-client @willsoto/nestjs-prometheus
  [ ] PrometheusModule.register() in app.module.ts (path: 'metrics')
  [ ] MetricsAccessMiddleware 작성 (XFF 1차 차단 + IP 2차 검증, ALLOWED_IP_REGEX 상수 + JSDoc)
  [ ] MetricsAccessMiddleware 단위 테스트 20+ 케이스 (it.each + buildRequest)
      - XFF/X-Real-IP 존재 시 차단 (overlay IP여도)
      - XFF 없음 + overlay IP (10.x) → 허용
      - XFF 없음 + localhost (127.x, ::1) → 허용
      - XFF 없음 + 비허용 IP → 차단
      - IPv4-mapped IPv6 (::ffff:10.x, ::ffff:127.x) → 허용
  [ ] AppModule implements NestModule + configure() + MiddlewareConsumer.apply().forRoutes()
  [ ] /api/v1/metrics 로컬 접근 확인
  [ ] pnpm test (단위 테스트 PASS)

Step 2 — Caddy 차단 + Prometheus + node_exporter:
  [ ] Caddyfile에 /api/v1/metrics 차단 규칙 추가 (respond 404)
  [ ] Caddy 자동 reload 확인 (--watch)
  [ ] infra/prometheus/prometheus.yml 작성 (external_labels, shared 스택 DNS 참조)
  [ ] infra/docker-stack.monitoring.shared.yml 작성 (node_exporter global)
  [ ] infra/docker-stack.monitoring.yml 작성 (Prometheus, sha256 config naming)
  [ ] placement.constraints 확인 (옵션 A/B 공통 — node.labels 라벨이 스택 재배포 전 반드시 부여되어 있어야 함)
  [ ] docker stack deploy -c docker-stack.monitoring.shared.yml monitor_shared (1번째)
  [ ] docker stack deploy -c docker-stack.monitoring.yml prod_monitor (2번째)
  [ ] Prometheus UI 접근 (SSH 터널 9090) → Targets 모두 UP
  [ ] NestJS 레플리카 개별 scrape 확인 (tasks.prod_nest_app DNS)
  [ ] node_exporter 각 노드 확인 (tasks.monitor_shared_node_exporter DNS)

Step 3 — Grafana (.env + Provisioning + Caddy 노출):
  [ ] 서버 .env에 GRAFANA_ADMIN_USER / GRAFANA_ADMIN_PASSWORD 추가
  [ ] 서버 .env에 GRAFANA_HOSTNAME (예: grafana.example.com) 추가
  [ ] 서버 .env에 GRAFANA_ALLOWED_IPS (운영자 IP/CIDR, 공백 구분) 추가
  [ ] DNS A 레코드 등록: grafana.example.com → 서버 공인 IP
  [ ] Caddyfile에 grafana.example.com 블록 추가 (remote_ip 화이트리스트 + reverse_proxy tasks.prod_monitor_grafana:3000)
  [ ] Caddy 자동 reload 확인 (--watch)
  [ ] docker-stack.monitoring.yml에 grafana 서비스 추가 (ports: 섹션 없음, overlay 노출만)
  [ ] 배포 워크플로우에서 .env → --env-add 주입 확인
  [ ] infra/grafana/provisioning/datasources/datasources.yml 작성 (Prometheus uid: prometheus 고정)
  [ ] infra/grafana/provisioning/dashboards/dashboards.yml 작성 (discovery 설정)
  [ ] datasources.yml/dashboards.yml → Swarm configs 주입 (sha256 해시 name)
  [ ] 대시보드 JSON 커밋: nodejs.json (11159), node-exporter.json (1860), fivesouth-custom.json
  [ ] dashboards/json/ 디렉터리 → bind mount (read-only) 설정 확인
  [ ] Grafana 재배포 후 https://grafana.example.com 접근 확인 (허용 IP만)
  [ ] 화이트리스트 미포함 IP에서 404 반환 확인 (보안 검증)

Step 4 — 커스텀 메트릭:
  [ ] ws_connections_active (TeamGateway 연결/해제 시 증감)
  [ ] ws_team_online_users (OnlineUserService 주기 갱신 30s~1m, 팀별 labels)
  [ ] ws_events_total / ws_event_duration_seconds (gateway handlers)
  [ ] redis_connection_status (RedisIoAdapter)
  [ ] (선택) 비즈니스 메트릭

Step 4.5 — Recording Rules + Drill-down 준비:
  [ ] infra/prometheus/rules/recording.yml 작성 (p95, error_rate, active_teams 등)
  [ ] prometheus.yml에 rule_files: ['rules/*.yml'] 추가
  [ ] configs:로 rules 주입 (sha256 해시 name)
  [ ] 대시보드 패널에 Data Links 템플릿 준비 (Loki 도입 후 활성화)

Step 5 — CI/CD 분리:
  [ ] .github/workflows/deploy-monitoring.yml 신규 (2 job: shared → prod)
  [ ] sha256sum config 해시 계산 로직 포함
  [ ] deploy-to-oci.yml에 paths-ignore 추가 (shared.yml 포함)
  [ ] develop/main push 시 각 워크플로우만 트리거 확인
  [ ] workflow_dispatch 수동 배포 테스트
  [ ] 미사용 config 정리 스크립트 동작 확인

Step 6 — 알림 (Alertmanager + Telegram):
  [ ] docker-stack.monitoring.yml에 alertmanager 서비스 추가
  [ ] Swarm secret 생성: docker secret create prod_monitor_bot_token - <<< "$BOT_TOKEN_TELEGRAM"
  [ ] infra/alertmanager/alertmanager.yml 작성 (bot_token_file + chat_id 리터럴)
  [ ] infra/prometheus/rules/alerts.yml 작성 (AppDown, HighErrorRate, HighHeapUsage, RedisDown, DiskSpaceLow, SwapHighUsage)
  [ ] prometheus.yml에 alerting.alertmanagers 설정 + rule_files 추가
  [ ] 서버 .env에 TELEGRAM_ALERT_CHAT_ID 추가 (정수값)
  [ ] 안전 테스트: amtool alert add test_alert severity=warning --annotation=summary="test"
  [ ] Telegram 알림 수신 확인 (resolve 포함)
  [ ] (선택) PROD 영향 없는 테스트용 알림 룰 1개로 실사용 검증

Step 7 — QA 환경 준비 (비활성 파일):
  [x] QA 설정 파일 .disabled 접미사로 생성 (PROD 파일 기반)
  [ ] QA 도입 시: .disabled 제거 + docker-stack.monitoring.qa.yml 활성화 + CI/CD job 추가
```

---

## 🔄 롤백 절차

```bash
# 1) 모니터링 스택만 제거 (역순: prod → shared)
docker stack rm prod_monitor          # 먼저 prod (prometheus/grafana/alertmanager/loki)
docker stack rm monitor_shared   # 그 다음 shared (node_exporter/promtail-prod)

# 2) 앱 이상 복구 (스택 per 서비스)
#    모니터링 먼저 제거한 후 앱 스택 롤백
docker stack rm prod_monitor
docker stack rm monitor_shared
# 이전 이미지 SHA 태그로 재배포
export IMAGE_TAG=prev_sha
docker stack deploy -c infra/docker-stack.app.yml prod_nest

# 3) config 재배포 (sha256 버전 관리 — docker config rm 불필요)
#    해시 계산 후 스택 재배포하면 새 config 자동 생성
export PROM_CFG_HASH=$(sha256sum infra/prometheus/prometheus.yml | head -c 12)
# ... (나머지 해시 계산)
docker stack deploy -c infra/docker-stack.monitoring.shared.yml monitor_shared
docker stack deploy -c infra/docker-stack.monitoring.yml prod_monitor

# 4) 미사용 config 정리 (선택)
docker config ls --filter "name=prod_monitor_" --format "{{.Name}}" | while read cfg; do
  docker config rm "$cfg" 2>/dev/null || true  # 사용 중인 config은 삭제 실패 (안전)
done
```

---

## 📝 트러블슈팅 히스토리 (작성 예약)

OCI 환경 특유 이슈 발생 시 commit hash와 함께 기록.

| 일자 | 이슈 | 원인 | 해결 | commit |
|------|------|------|------|--------|
| - | - | - | - | - |

---

## ⚠️ 위험도 요약

| 작업 | 위험도 | 핵심 이유 |
|------|:---:|----------|
| Step 0 (인프라 - 옵션 B) | 🟢 낮음 | OCI VM 2대 프로비저닝 완료. Swarm join + 라벨 설정만 남음 |
| Step 1 (앱) | 🟢 낮음 | 미들웨어 추가 + 단위 테스트 커버 |
| Step 2 (Caddy + Prometheus) | 🟢 낮음 | Caddy 변경은 `--watch` 자동 적용, 스택 분리로 앱 무영향 |
| Step 3 (Grafana + Provisioning) | 🟢 낮음 | 외부 미노출, .env 주입 기존 패턴 재사용. Provisioning IaC로 재현성 확보 |
| Step 4 (커스텀 메트릭) | 🟢 낮음 | Gateway/Service에 카운터 증감 추가. 팀별 Gauge 주기 갱신 부하만 주의 |
| Step 4.5 (Recording Rules) | 🟢 낮음 | 쿼리 사전 계산, 런타임 영향 없음 |
| Step 5 (CI/CD) | 🟡 중간 | paths-ignore 실수 시 의도치 않은 재배포 가능 + sha256 해시 계산/주입 실수 시 config 미갱신 → 충분한 테스트 필요 |
| Step 6 (Alertmanager) | 🟡 중간 | **bot_token 주입 방식 실패 시 알림 무력화**. 방법 A(`bot_token_file` + Swarm secret) 권장. 테스트는 `amtool alert add`로 안전하게 |
| 옵션 B (1GB 분리) | 🟢 낮음 | **스왑 2GB 적용 완료** — 스파이크 완충 충분. `vm.swappiness=10` 설정 + 스왑 사용률 모니터링 필수. Grafana 대시보드 동시 접근 자제 권장 |

---

## 📦 최종 docker-stack 파일 (2개 스택 — 단일 진실 원천)

> 아래는 **shared + prod 2개 스택**의 최종 파일입니다. Step별 본문의 YAML 예시는 이 합본에서 해당 서비스만 발췌한 것이므로, 실제 배포 파일은 **이 섹션을 기준**으로 삼으세요.

### 📦-1. `infra/docker-stack.monitoring.shared.yml` (shared 스택)

> node_exporter + promtail-prod — 모든 노드에서 global 실행. QA 추가 시 promtail-qa 서비스만 추가.

```yaml
version: '3.9'

services:
  node_exporter:
    image: prom/node-exporter:v1.8.2
    command:
      - '--path.rootfs=/host'
    volumes:
      - '/:/host:ro,rslave'
    networks:
      - sys_default
    deploy:
      mode: global
      resources:
        limits:
          memory: 50M
    # ports 없음 → overlay 내부에서만 노출 (Prometheus tasks.monitor_shared_node_exporter:9100)

  promtail-prod:
    image: grafana/promtail:3.1.0
    command: -config.file=/etc/promtail/config.yml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - promtail-prod-positions:/tmp
    configs:
      - source: prod_monitor_promtail_yml
        target: /etc/promtail/config.yml
    networks:
      - sys_default
    deploy:
      mode: global
      resources:
        limits:
          memory: 100M
      restart_policy:
        condition: on-failure

configs:
  prod_monitor_promtail_yml:
    name: prod_monitor_promtail_yml_${PROMTAIL_CFG_HASH:-latest}
    file: ./infra/promtail/promtail-config.yml

volumes:
  promtail-prod-positions:

networks:
  sys_default:
    external: true
```

### 📦-2. `infra/docker-stack.monitoring.yml` (prod 스택)

> prometheus + grafana + alertmanager + loki — 환경별 메트릭/로그 저장·시각화.

```yaml
version: '3.9'

services:
  prometheus:
    image: prom/prometheus:v3.4.1
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=7d'
      - '--web.enable-lifecycle'
    configs:
      - source: prod_monitor_prometheus_yml
        target: /etc/prometheus/prometheus.yml
      - source: prod_monitor_recording_yml
        target: /etc/prometheus/rules/recording.yml
      - source: prod_monitor_alerts_yml
        target: /etc/prometheus/rules/alerts.yml
    volumes:
      - prometheus-data:/prometheus
    networks:
      - sys_default
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.labels.prod_monitor_metrics == 1
      resources:
        limits:
          memory: 400M
    ports:
      - target: 9090
        published: 9090
        mode: host   # SSH 터널만 접근

  grafana:
    image: grafana/grafana:12.1.0
    user: "472:472"
    environment:
      GF_SECURITY_ADMIN_USER: ${GRAFANA_ADMIN_USER}
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD}
      GF_PATHS_PROVISIONING: /etc/grafana/provisioning
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_AUTH_ANONYMOUS_ENABLED: "false"
      GF_SERVER_ROOT_URL: "https://${GRAFANA_HOSTNAME}/"
      GF_SERVER_DOMAIN: "${GRAFANA_HOSTNAME}"
      # 리소스 보호 설정 (1GB 노드 — 쿼리 부하 완화)
      GF_DATAPROXY_TIMEOUT: "30"                   # 프록시 쿼리 타임아웃 (초)
      GF_DASHBOARDS_MIN_REFRESH_INTERVAL: "30s"    # 자동 새로고침 최소 간격
    configs:
      - source: prod_monitor_grafana_datasources_yml
        target: /etc/grafana/provisioning/datasources/datasources.yml
      - source: prod_monitor_grafana_dashboards_yml
        target: /etc/grafana/provisioning/dashboards/dashboards.yml
    volumes:
      - grafana-data:/var/lib/grafana
      - /home/ubuntu/desktop/deploy/infra/grafana/provisioning/dashboards/json:/etc/grafana/provisioning/dashboards/json:ro
    networks:
      - sys_default
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.labels.prod_monitor_view == 1
      resources:
        limits:
          memory: 350M
    # ports 없음 → Caddy가 overlay로 reverse_proxy

  alertmanager:
    image: prom/alertmanager:v0.27.0
    command:
      - '--config.file=/etc/alertmanager/config.yml'
      - '--storage.path=/alertmanager'
    configs:
      - source: prod_monitor_alertmanager_yml
        target: /etc/alertmanager/config.yml
    secrets:
      - source: prod_monitor_bot_token
        target: /etc/alertmanager/secrets/bot_token
    volumes:
      - alertmanager-data:/alertmanager
    networks:
      - sys_default
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.labels.prod_monitor_metrics == 1
      resources:
        limits:
          memory: 100M
    ports:
      - target: 9093
        published: 9093
        mode: host   # SSH 터널만 접근

  loki:
    image: grafana/loki:3.1.0
    user: "10001:10001"
    command: -config.file=/etc/loki/config.yml
    configs:
      - source: prod_monitor_loki_yml
        target: /etc/loki/config.yml
    volumes:
      - loki-data:/loki
    networks:
      - sys_default
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.labels.prod_monitor_view == 1
      resources:
        limits:
          memory: 400M
      restart_policy:
        condition: on-failure
    # ports 없음 → overlay 내부만 (Grafana와 Promtail이 tasks.prod_monitor_loki:3100 접근)

configs:
  # sha256 해시 12자 → config name에 포함 (CI/CD에서 자동 계산)
  prod_monitor_prometheus_yml:
    name: prod_monitor_prometheus_yml_${PROM_CFG_HASH:-latest}
    file: ./infra/prometheus/prometheus.yml
  prod_monitor_recording_yml:
    name: prod_monitor_recording_yml_${RECORDING_CFG_HASH:-latest}
    file: ./infra/prometheus/rules/recording.yml
  prod_monitor_alerts_yml:
    name: prod_monitor_alerts_yml_${ALERTS_CFG_HASH:-latest}
    file: ./infra/prometheus/rules/alerts.yml
  prod_monitor_alertmanager_yml:
    name: prod_monitor_alertmanager_yml_${ALERTMANAGER_CFG_HASH:-latest}
    file: ./infra/alertmanager/alertmanager.yml
  prod_monitor_grafana_datasources_yml:
    name: prod_monitor_grafana_datasources_yml_${GRAFANA_DS_CFG_HASH:-latest}
    file: ./infra/grafana/provisioning/datasources/datasources.yml
  prod_monitor_grafana_dashboards_yml:
    name: prod_monitor_grafana_dashboards_yml_${GRAFANA_DASH_CFG_HASH:-latest}
    file: ./infra/grafana/provisioning/dashboards/dashboards.yml
  prod_monitor_loki_yml:
    name: prod_monitor_loki_yml_${LOKI_CFG_HASH:-latest}
    file: ./infra/loki/loki-config.yml

secrets:
  prod_monitor_bot_token:
    external: true   # 서버에서 docker secret create로 미리 생성

volumes:
  prometheus-data:
  grafana-data:
  alertmanager-data:
  loki-data:

networks:
  sys_default:
    external: true
```

---

## 📚 참고

- 원본 문서(분리 전): [`tasks-nestjs-improvements.md`](./tasks-nestjs-improvements.md) D10
- 연관 작업: [`tasks-logging.md`](./tasks-logging.md) (Loki + Promtail — 같은 모니터링 스택에 확장)
- 아키텍처: [`architecture.md`](./architecture.md)
- 배포 환경: [`deploy.md`](./deploy.md)
- Redis Pub/Sub: [`tasks-redis-pubsub.md`](./tasks-redis-pubsub.md)
- 참고 프로젝트: `../mobisell/mobisell-back/docs/tasks-monitoring.md` (GCP/QA 환경, 패턴만 참조)

**구현 시 수정 대상 파일**:

**NestJS 앱**:
- `src/app.module.ts` (PrometheusModule import + MiddlewareConsumer 등록)
- `src/common/middleware/metrics-access.middleware.ts` (신규 — XFF 1차 + IP 2차 검증)
- `src/common/middleware/metrics-access.middleware.spec.ts` (신규 — 20+ 케이스)
- `src/modules/team/team.gateway.ts` (ws_connections_active, ws_events_total, ws_event_duration_seconds)
- `src/modules/team/online-user.service.ts` (ws_team_online_users 주기 갱신)
- `src/common/adapters/redis-io.adapter.ts` (redis_connection_status)

**인프라 설정 (신규)**:
- `infra/docker-stack.monitoring.shared.yml` (**shared 스택** — node_exporter + promtail-prod)
- `infra/docker-stack.monitoring.yml` (**prod 스택** — prometheus + grafana + alertmanager + loki)
- `infra/prometheus/prometheus.yml` (shared 스택 DNS 참조: `tasks.monitor_shared_node_exporter`)
- `infra/prometheus/rules/recording.yml` (Recording Rules)
- `infra/prometheus/rules/alerts.yml` (Alert Rules)
- `infra/alertmanager/alertmanager.yml`
- `infra/grafana/provisioning/datasources/datasources.yml`
- `infra/grafana/provisioning/dashboards/dashboards.yml`
- `infra/grafana/provisioning/dashboards/json/*.json` (nodejs, node-exporter, fivesouth-custom)

**QA 준비 파일 (비활성)**:
- `infra/prometheus/prometheus.qa.yml.disabled` (QA scrape targets + external_labels env:qa)
- `infra/loki/loki-config.qa.yml.disabled` (QA retention + 경로)
- `infra/promtail/promtail-config.qa.yml.disabled` (QA Loki push 대상)
- `infra/docker-stack.monitoring.qa.yml.disabled` (QA 스택 정의)

**기존 파일 수정**:
- Caddyfile (서버: `/home/ubuntu/desktop/deploy/infra/caddy/config/Caddyfile`):
  - `/api/v1/metrics` 404 차단 규칙 (앱 도메인 블록)
  - `grafana.example.com` 신규 블록 (IP 화이트리스트 + reverse_proxy `tasks.prod_monitor_grafana:3000`)
- 서버 `.env` 추가 항목:
  - `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`
  - `GRAFANA_HOSTNAME`, `GRAFANA_ALLOWED_IPS`
  - `TELEGRAM_ALERT_CHAT_ID`
- DNS: `grafana.example.com` A 레코드 등록
- `.github/workflows/deploy-monitoring.yml` (신규 — 2 job: shared → prod, sha256 config)
- `.github/workflows/deploy-to-oci.yml` (paths-ignore 추가)

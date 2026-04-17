# Task Tracker: 로그 중앙 수집 (Loki + Promtail)

> 작성일: 2026-04-15
> 브랜치: `feat-onam`
> 상태: **도입 확정** (배포 미진행)
> 선행: [`tasks-swarm-stack-migration.md`](./tasks-swarm-stack-migration.md) → [`tasks-monitoring.md`](./tasks-monitoring.md) Grafana 배포 → 본 문서
> 본 문서는 마이그레이션 완료 후 상태 기준 (서비스 DNS: `prod_nest_app`)

---

## 📌 결정 사항 요약

| 항목 | 결정 | 근거 |
|------|------|------|
| 수집 방식 | **Promtail + Docker discovery** (docker socket 마운트) | 앱 수정 0, 재시작 시 로그 손실 없음 (docker logging driver 대비 안정적) |
| 로그 소스 | **NestJS Pino stdout JSON** | Pino 이미 도입 완료 (Phase 1~4 `[✓] C1`) |
| 저장소 | Loki (단일 바이너리 모드) | 간단한 구성, 수평 확장 불필요 |
| Retention | **7일** (Prometheus와 맞춤) | 디스크 예상 ~1~3GB |
| 레이블 전략 | **저카디널리티 4종**: `service`, `env`, `cluster`, `level` | 고카디널리티(userId, container_name 등) 금지 — 인덱스 폭증 방지 |
| 네트워크 | `sys_default` overlay (`external: true`) | 모니터링 스택과 동일 |
| 외부 노출 | **없음** (Grafana가 overlay 내부에서 접근) | Loki 포트 3100 외부 차단 |
| 배치 (옵션 B) | Loki → `fs-03`, Promtail → Swarm `global` | 모니터링 스택과 공존 (스왑 2GB 적용 완료, `vm.swappiness=10` 권장) |
| 쿼리 도구 | **Grafana Explore + LogQL** | Prometheus와 동일 UI에서 조회 |
| Pino 보안 | **redact** 설정 (password, token, authorization) | 로그 중앙 수집 시 민감 정보 유출 방지 |
| Pino 직렬화 | **serializers** (req, res, err 구조 통일) | LogQL 필터링 안정성 |
| 메트릭-로그 연동 | **Grafana Data Links** (`${__from}`/`${__to}` 변수) | 메트릭 이상 발견 → 원클릭 로그 drill-down |
| 쿼리 카탈로그 | **LogQL 샘플 쿼리** 문서화 | 운영 시 자주 쓰는 쿼리 레퍼런스 |

---

## 개요

- **난이도**: 보통 | **효과**: 높음 | **위험도**: 🟢 낮음
- **선행**: 모니터링 스택 배포 완료 (`tasks-monitoring.md` Step 3 완료)
- **프론트 영향**: 없음
- **참고 프로젝트**: `../mobisell/mobisell-back` — Loki 미적용 (gcplogs 대체). 우리는 OCI라 gcplogs 불가 → Loki가 더 필요

---

## 🎯 왜 Loki인가

| 문제 | 현재 상태 (bun) | Loki 도입 후 |
|------|-----------------|-------------|
| 로그 중앙 수집 | ❌ 없음 (`docker service logs`만) | ✅ 전 노드/전 컨테이너 통합 조회 |
| 로그 검색 | ❌ SSH + grep | ✅ LogQL (정규식/레이블 필터) |
| 메트릭↔로그 연계 | ❌ 분리 | ✅ Grafana에서 메트릭 대시보드에서 로그로 drill-down |
| Retention | Docker 기본 (무제한 / 크기 제한 수동) | ✅ 7일 자동 정리 |
| 앱 코드 영향 | - | **0** (Pino stdout 그대로 수집) |

---

## 🏗️ 아키텍처

```
[NestJS prod_nest_app: Pino stdout JSON]
         ↓ (docker logs)
[Promtail] ─── Swarm global mode (모든 노드에 1개)
         │     • docker socket 마운트 → 컨테이너 자동 발견
         │     • 저카디널리티 레이블만 승격 (service, env, cluster, level)
         ↓ HTTP push
[Loki] ─── 단일 인스턴스 (sys_default overlay)
         • BoltDB shipper (로컬 + 선택: S3 호환 백업)
         • Retention 7일
         ↓ 쿼리
[Grafana] ─── 동일 Grafana 재사용 (데이터소스 추가)
         • Explore 탭에서 LogQL 쿼리
         • Prometheus 대시보드에서 로그 drill-down (데이터 링크)
```

---

## 📦 패키지 및 도구

| 도구 | 버전 (추천) | 역할 |
|------|-----------|------|
| Loki | `grafana/loki:3.1.0` | 로그 저장·쿼리 서버 |
| Promtail | `grafana/promtail:3.1.0` | 로그 수집 에이전트 (docker discovery) |

**앱 레벨 추가 설치 없음** — Pino 이미 도입되어 stdout JSON 출력 중.

---

## 💾 서버 부하

| 항목 | 수치 |
|------|------|
| Loki 컨테이너 | CPU ~0.5%, RAM ~200MB, 디스크 ~1~3GB/7일 |
| Promtail (노드당) | CPU ~0.2%, RAM ~20MB |
| **Loki 스택 합계 (기준)** | **RAM ~220MB, CPU ~0.7%** |
| 옵션 B — fs-03 (Grafana+Loki) | ~370MB (1GB 인스턴스 여유 충분) |

---

## 🏷️ 레이블 설계 (핵심)

Loki는 레이블만 인덱싱. 고카디널리티 레이블은 금지.

### ✅ 허용 레이블 (저카디널리티)

| 레이블 | 값 예시 | 카디널리티 |
|--------|---------|-----------|
| `service` | `prod_nest_app`, `sys_redis`, `sys_caddy` | ~5 |
| `env` | `prod` | 1 |
| `cluster` | `oci-swarm` | 1 |
| `level` | `info`, `warn`, `error`, `debug` | 4 |

> **제외**: `container_name`은 Swarm 컨테이너 재시작마다 ID 변경 → 1주일 운영 시 수백 개 고유값 (고카디널리티). 인덱스에 넣지 않고 필요 시 LogQL line 필터로 검색.

### ❌ 금지 레이블 (고카디널리티)

- `user_id`, `team_id`, `request_id`, `trace_id`, `ip`, `url`, `task_id`
- 이런 필드는 **로그 본문(line)** 에 포함하고 LogQL로 필터:
  ```logql
  {service="prod_nest_app"} | json | user_id="123"
  ```

### ✔️ 고카디널리티 방지 체크리스트

- [ ] Promtail `relabel_configs`에 고카디널리티 source_labels 사용하지 않음
- [ ] `pipeline_stages.labels`에 `level` 외 다른 필드 승격 금지
- [ ] Pino 로그 본문에 `userId`, `teamId` 등 포함 OK (JSON 필드만)
- [ ] Loki `limits_config.max_label_name_length`, `max_label_value_length` 기본값 유지
- [ ] 운영 중 `loki_ingester_memory_streams` 메트릭 관찰 (스트림 수 = 레이블 조합 수, 수만 건 초과 시 레이블 설계 재검토)

---

## 🔒 보안

- **Loki 3100 포트 외부 노출 금지**: `docker-stack.monitoring.yml` (prod 스택)에서 `ports:` 명시하지 않음
- Grafana가 overlay 내부 DNS(`tasks.prod_monitor_loki:3100`)로 접근
- Promtail → Loki push도 overlay 내부 통신
- 외부 접근이 필요하면 Grafana에서 LogQL로만 조회 (Grafana 자체는 이미 SSH 터널 접근으로 보호)

---

## 🚀 구현 단계

### Step 1 — Promtail 설정 파일

`infra/promtail/promtail-config.yml`:

```yaml
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://tasks.prod_monitor_loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 5s
    relabel_configs:
      # ⚠️ container_name은 레이블로 승격하지 않음 (Swarm 재시작마다 ID 변경 → 고카디널리티)
      # 필요 시 LogQL로 __meta_docker_container_name 검색 (line 필터)

      # Swarm 서비스 이름 (prod_nest_app, sys_redis, sys_caddy 등 — 저카디널리티)
      - source_labels: ['__meta_docker_container_label_com_docker_swarm_service_name']
        target_label: 'service'

      # 환경 고정 (카디널리티 1)
      - replacement: 'prod'
        target_label: 'env'
      - replacement: 'oci-swarm'
        target_label: 'cluster'

      # 참고: container_name을 레이블로 쓰지 않음 (재시작마다 ID 변경 → 고카디널리티)
      # 필요 시 아래 pipeline_stages.structured_metadata에서 보존 (인덱스 영향 없음)

    pipeline_stages:
      # Pino JSON 파싱 (실패 시 해당 stage만 스킵, 로그는 정상 raw line으로 수집됨)
      - json:
          expressions:
            level: level
            time: time
            msg: msg

      # level만 저카디널리티 레이블로 승격 (info/warn/error/debug — 4개)
      - labels:
          level:

      # 타임스탬프 교정 (Pino는 ms epoch)
      - timestamp:
          source: time
          format: UnixMs

      # container_name은 structured_metadata로 저장 — 인덱스 미영향, LogQL에서 필터 가능
      # Loki 3.0+ + limits_config.allow_structured_metadata: true 필요 (loki-config.yml에 활성화됨)
      - structured_metadata:
          container_name: container_name

      # non-JSON 로그(Redis, Caddy 등)는 json stage가 실패해도 raw line으로 정상 수집
```

### Step 2 — Loki 설정 파일

`infra/loki/loki-config.yml`:

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2026-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 168h  # 7일
  allow_structured_metadata: true

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  retention_delete_delay: 2h
  delete_request_store: filesystem
```

### Step 3 — docker-stack 확장 (Loki → prod 스택, Promtail → shared 스택)

Loki는 `docker-stack.monitoring.yml` (prod 스택)에, Promtail은 `docker-stack.monitoring.shared.yml` (shared 스택)에 추가.
> 🔖 **실제 배포 파일은 `tasks-monitoring.md` 말미 "📦 최종 docker-stack" 합본 섹션 기준**. 아래 YAML은 Loki/Promtail 부분만 발췌.

```yaml
services:
  loki:
    image: grafana/loki:3.1.0
    user: "10001:10001"   # Loki 기본 uid/gid — 볼륨 권한 일관성
    command: -config.file=/etc/loki/config.yml
    volumes:
      - loki-data:/loki
    configs:
      - source: prod_monitor_loki_yml
        target: /etc/loki/config.yml
    networks:
      - sys_default
    deploy:
      replicas: 1
      placement:
        constraints:
          # fs-03 배치 (옵션 A/B 공통 — 옵션 A는 앱 노드에 prod_monitor_view=1 라벨 부여)
          - node.labels.prod_monitor_view == 1
      restart_policy:
        condition: on-failure

  promtail:
    image: grafana/promtail:3.1.0
    # Promtail은 docker.sock 접근이 필요하므로 기본 root 유지 (user 지시어 명시 안 함)
    command: -config.file=/etc/promtail/config.yml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro   # read-only 마운트
      - promtail-positions:/tmp
    configs:
      - source: prod_monitor_promtail_yml
        target: /etc/promtail/config.yml
    networks:
      - sys_default
    deploy:
      mode: global  # 모든 노드에 자동 배포 (fs-02, fs-03, 앱 노드 전부 포함)
      restart_policy:
        condition: on-failure

configs:
  prod_monitor_loki_yml:
    file: ./infra/loki/loki-config.yml
  prod_monitor_promtail_yml:
    file: ./infra/promtail/promtail-config.yml

volumes:
  loki-data:
  promtail-positions:

networks:
  sys_default:
    external: true   # 기존 앱 overlay에 참여
```

### Step 4 — Grafana 데이터소스 추가 (Provisioning으로 일원화)

Provisioning 방식으로 통일 (UI 추가 ❌). `tasks-monitoring.md` Step 3-2의 datasources.yml에 Loki append:

`infra/grafana/provisioning/datasources/datasources.yml` (최종 모습):
```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus           # ← 고정 UID (derivedFields.datasourceUid가 참조)
    type: prometheus
    access: proxy
    url: http://tasks.prod_monitor_prometheus:9090
    isDefault: true
    editable: false
    jsonData:
      timeInterval: "15s"
  - name: Loki
    uid: loki                 # ← 고정 UID
    type: loki
    access: proxy
    url: http://tasks.prod_monitor_loki:3100
    editable: false
    jsonData:
      maxLines: 1000
      # Loki → Prometheus 상관관계 (trace_id 필드로 메트릭 연결 가능 — 선택)
      # datasourceUid: prometheus → Prometheus 블록의 uid 값과 일치해야 작동
      derivedFields:
        - datasourceUid: prometheus
          matcherRegex: "trace_id=(\\w+)"
          name: TraceID
          url: ""              # 내부 datasource 연결이므로 URL 비움 (datasourceUid로 점프)
```

**배포 흐름**:
1. 파일 수정 → Git 커밋
2. CI/CD `deploy-monitoring.yml` 트리거 → Grafana 재시작 (configs 변경 감지)
3. Grafana 재기동 시 provisioning 파일이 데이터소스 자동 등록

**검증** (Grafana Explore):
```logql
{service="prod_nest_app"}
```
→ 로그 출력되면 성공

### Step 5 — Pino 로그 포맷 + 보안 확인 ⭐

**5-1. 기본 포맷 확인**
- `level`, `time`, `msg` 필드가 JSON stdout으로 나오는지 확인 (`src/common/logger/` 또는 `main.ts`)
- LOCAL 환경의 pino-pretty는 유지 (Promtail은 PROD stdout JSON만 수집)
- PROD에서는 반드시 JSON 형식

**5-2. Pino redaction (비밀번호/토큰 유출 방지)** ⭐

로그가 중앙 수집되면 민감 정보 유출 위험 증가. Pino 설정에 `redact` 추가:
```typescript
// src/common/logger/logger.module.ts 또는 pino 설정 위치
{
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.accessToken',
      '*.password',
      '*.token',
      '*.access_token',
      '*.refresh_token',
    ],
    censor: '[REDACTED]',
  },
}
```

**5-3. Pino serializers**

요청/응답/에러를 **일관된 구조**로 직렬화 — LogQL 필터링 안정성 확보:
```typescript
{
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      userId: req.user?.id,  // JSON 필드로만 (레이블 금지)
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
    err: pino.stdSerializers.err,
  },
}
```

**5-4. Pino 로그 샘플링 (고트래픽 대비)**

정상 요청이 초당 수백건이면 INFO 로그가 Loki 저장 비용을 폭증시킴. 필요 시 샘플링:
- nestjs-pino `customLogLevel` 또는 `customSuccessMessage`에서 200/304 응답은 DEBUG로 낮추기
- 프로덕션 기본 level: `info` (DEBUG 제외)

### Step 6 — Grafana Data Links (메트릭 → 로그 Drill-down) ⭐

기존 Prometheus 대시보드 패널에 **Data links**를 추가하여 메트릭 이상 발견 시 해당 서비스/시간대 로그로 원클릭 이동.

**6-1. 글로벌 Data Link 예시** (HTTP 에러율 패널):
```
Title: View error logs
URL: /explore?orgId=1&left=%7B%22datasource%22:%22Loki%22,%22queries%22:%5B%7B%22refId%22:%22A%22,%22expr%22:%22%7Bservice%3D%5C%22prod_nest_app%5C%22%7D%20%7C%20json%20%7C%20level%3D%5C%22error%5C%22%22%7D%5D,%22range%22:%7B%22from%22:%22${__from}%22,%22to%22:%22${__to}%22%7D%7D
Open in new tab: true
```
- `${__from}` / `${__to}` 변수로 **패널 시간 범위 자동 전달**

**6-2. 레이블 기반 Data Link** (팀별 접속자 패널 → 해당 팀 관련 로그):
```
URL: /explore?left={"datasource":"Loki","queries":[{"expr":"{service=\"prod_nest_app\"} | json | team_id=\"${__field.labels.team_id}\""}]}
```

**6-3. Grafana Provisioning에 통합**
- 대시보드 JSON 파일(`infra/grafana/provisioning/dashboards/json/fivesouth-custom.json`) 안의 각 panel `links` 배열에 Data Link 추가
- Git에 커밋하여 서버 재배포 시에도 재현

**6-4. Grafana datasources.yml — Step 4에서 이미 등록 완료** (중복 작업 아님)

Step 4에서 Prometheus + Loki 모두 provisioning으로 등록했으므로 추가 작업 없음.

### Step 7 — LogQL 샘플 쿼리 카탈로그 ⭐

운영 시 자주 쓰는 쿼리 레퍼런스 (Grafana Explore 저장 또는 대시보드 패널용):

⚠️ LogQL 주의:
- 숫자 비교 연산자 앞뒤 **공백 필수**: `field > 3000` (O), `field>3000` (X)
- Pino `serializers` 중첩 객체는 `| json`으로 flatten 시 언더스코어 변환: `res.statusCode` → `res_statusCode`
- 필드명이 Pino 로그 실제 키와 정확히 일치해야 함 (배포 후 Grafana Explore에서 실측 키 확인)

```logql
# 최근 에러 로그 (전 서비스)
{service=~"sys_.*"} | json | level="error"

# level 레이블이 승격되어 있으므로 이 쿼리가 더 빠름
{service=~"sys_.*", level="error"}

# 특정 팀 관련 로그 (고카디널리티는 레이블이 아닌 line 필터)
{service="prod_nest_app"} | json | team_id="42"

# 5xx 응답 로그 (Pino serializers: res.statusCode → res_statusCode)
{service="prod_nest_app"} | json | res_statusCode >= 500

# slow request (3초 이상) — 필드명은 실제 Pino 로그 키에 맞춰 조정
{service="prod_nest_app"} | json | responseTime > 3000

# 로그인 실패 집계 (5분 창)
sum(count_over_time({service="prod_nest_app"} |~ "login.*fail" [5m]))

# 에러율 추이 (레벨별 로그 entry 수)
sum by (level) (count_over_time({service="prod_nest_app"} [1m]))

# Redis 연결 이슈 추적 (레이블 필터 → line 필터 순서가 효율적)
{service="prod_nest_app", level=~"error|warn"} |~ "[Rr]edis"
```

### Step 8 — 알림 (Loki 기반)

- Grafana Alert Rules 또는 Prometheus Alertmanager와 통합
- Loki Ruler (옵션): Prometheus alert rule과 동일 문법으로 Loki 쿼리 알림
- 예시:
  ```logql
  # 5분간 에러 로그 10건 초과
  sum(count_over_time({service="prod_nest_app"} | json | level="error" [5m])) > 10
  ```
- 수신처: 기존 Alertmanager → Telegram (tasks-monitoring.md Step 6과 통합)

---

## ✅ 실행 체크리스트

```
Step 1 — Promtail 설정:
  [ ] infra/promtail/promtail-config.yml 작성
  [ ] docker_sd_configs + relabel_configs (저카디널리티 레이블만: service, env, cluster)
  [ ] pipeline_stages: Pino JSON 파싱 (level, time, msg) → level 레이블 승격
  [ ] structured_metadata stage로 container_name 보존 (인덱스 미영향)

Step 2 — Loki 설정:
  [ ] infra/loki/loki-config.yml 작성
  [ ] retention_period: 168h (7일)
  [ ] filesystem storage (BoltDB shipper)

Step 3 — Swarm 스택:
  [ ] docker-stack.monitoring.yml (prod)에 loki 서비스 추가 (volume, configs)
  [ ] docker-stack.monitoring.shared.yml에 promtail 서비스 추가 (mode: global)
  [ ] 옵션 B: loki placement.constraints (prod_monitor_view)
  [ ] docker stack deploy -c docker-stack.monitoring.shared.yml monitor_shared
  [ ] docker stack deploy -c docker-stack.monitoring.yml prod_monitor
  [ ] docker service logs prod_monitor_loki → Ready
  [ ] docker service logs monitor_shared_promtail-prod → 컨테이너 발견 로그 확인

Step 4 — Grafana 데이터소스 (Provisioning):
  [ ] datasources.yml에 Loki 블록 append (Prometheus와 병행)
  [ ] (선택) derivedFields로 trace_id → Prometheus 연결 설정
  [ ] Grafana 재배포 → Connections 화면에 Prometheus + Loki 자동 등록 확인
  [ ] Explore 탭에서 {service="prod_nest_app"} 쿼리 → 로그 출력 확인

Step 5 — Pino 포맷 + 보안:
  [ ] PROD stdout JSON 형식 재확인 (level, time, msg)
  [ ] Pino redact 설정 (password, token, cookie, authorization)
  [ ] Pino serializers 설정 (req, res, err 구조 통일)
  [ ] 프로덕션 로그 레벨 확인 (info 기본, DEBUG 제외)
  [ ] LogQL로 파싱 확인: `{service="prod_nest_app"} | json | level="error"`

Step 6 — Grafana Data Links (Drill-down):
  [ ] 대시보드 JSON의 panel `links`에 Data Link 추가 ($__from/$__to 변수 활용)
  [ ] HTTP 에러율 패널 → Loki 에러 로그 드릴다운 동작 확인
  [ ] 팀별 접속자 패널 → team_id 필터 드릴다운 동작 확인
  [ ] Grafana Provisioning JSON export → Git 커밋 (Step 4에서 이미 datasources 등록됨)

Step 7 — LogQL 샘플 쿼리 저장:
  [ ] Grafana Explore에 "Starred queries"로 주요 쿼리 저장
  [ ] 또는 docs/에 LogQL 치트시트 간단히 기록

Step 8 — 알림 (Loki 기반):
  [ ] Loki Ruler 설정 또는 Grafana Alert Rule 생성
  [ ] 에러 로그 임계치 규칙 (5분 10건 등)
  [ ] 기존 Alertmanager → Telegram 통합 (tasks-monitoring.md Step 6)
  [ ] 테스트: 의도적 에러 로그 발생 → Telegram 알림 수신
```

---

## ⚠️ 주의 사항

- **고카디널리티 레이블 금지**: `user_id`, `team_id`, `url` 등은 **로그 본문에 포함**, 레이블에 넣지 말 것
- **Promtail positions 파일**: 재시작 후 중복 수집 방지 위해 `/tmp/positions.yaml` 볼륨 영속화 필요
- **docker.sock 마운트**: Promtail은 read-only 권장 (`:/var/run/docker.sock:ro`)
- **LOCAL pino-pretty와 충돌 방지**: Promtail은 PROD에서만 동작 (LOCAL은 수집 대상 아님)
- **디스크 공간 감시**: node_exporter `node_filesystem_avail_bytes` 알림 규칙 필수 (Loki 청크 증가 대비)
- **옵션 B 1GB 인스턴스 (fs-03)**: 스왑 2GB 적용 완료로 OOM 위험 해소. 추가 안전장치로 `limits_config.ingestion_rate_mb: 4` (초당 4MB) 제한 권장 — 앱 로그 폭증 시 Loki 메모리 보호

---

## 🔄 롤백 절차

```bash
# Loki만 제거 (prod 스택에서)
docker service rm prod_monitor_loki

# Promtail 제거 (shared 스택에서 — 주의: node_exporter도 같은 스택)
docker service rm monitor_shared_promtail-prod

# 데이터 초기화 (필요 시)
docker volume rm prod_monitor_loki-data monitor_shared_promtail-prod-positions

# 재배포
docker stack deploy -c docker-stack.monitoring.shared.yml monitor_shared
docker stack deploy -c docker-stack.monitoring.yml prod_monitor
```

---

## 📝 트러블슈팅 히스토리 (작성 예약)

| 일자 | 이슈 | 원인 | 해결 | commit |
|------|------|------|------|--------|
| - | - | - | - | - |

---

## ⚠️ 위험도 요약

| 작업 | 위험도 | 핵심 이유 |
|------|:---:|----------|
| Promtail 배포 | 🟢 낮음 | docker.sock 읽기만, 앱 영향 0 |
| Loki 배포 | 🟢 낮음 | 단일 인스턴스, 외부 미노출 |
| Grafana 데이터소스 추가 | 🟢 낮음 | 설정 추가만 |
| Pino 포맷 변경 필요 시 | 🟡 중간 | 프로덕션 로그 구조 변경 → 기존 알림·쿼리 영향 가능 |
| 레이블 설계 실수 | 🟡 중간 | 고카디널리티 레이블 추가 시 Loki 인덱스 폭증 → 쿼리 성능 저하 |

---

## 📚 참고

- 모니터링 스택: [`tasks-monitoring.md`](./tasks-monitoring.md) — Prometheus + Grafana 선행
- 아키텍처: [`architecture.md`](./architecture.md)
- 배포 환경: [`deploy.md`](./deploy.md)
- Pino 도입 이력: `tasks-nestjs-improvements.md` Phase 1~4 `[✓] C1 Pino 도입`

**구현 시 수정 대상 파일**:

**인프라 설정 (신규)**:
- `infra/promtail/promtail-config.yml`
- `infra/loki/loki-config.yml`

**기존 파일 수정**:
- `infra/docker-stack.monitoring.yml` (Loki 서비스 + volume + configs 추가 — prod 스택)
- `infra/docker-stack.monitoring.shared.yml` (Promtail 서비스 추가 — shared 스택)
- `infra/grafana/provisioning/datasources/datasources.yml` (Loki 데이터소스 append)
- `infra/grafana/provisioning/dashboards/json/*.json` (Data Links 추가 — Grafana UI export 후 Git 커밋)
- `.github/workflows/deploy-monitoring.yml` (트리거 paths에 `infra/loki/**`, `infra/promtail/**` 추가)

**NestJS 앱 (Pino 보안/품질)**:
- `src/common/logger/logger.module.ts` (redact + serializers 설정 — 이미 Pino 도입되어 있으므로 옵션 추가만)
- PROD stdout JSON 포맷 재확인 (nestjs-pino 기본값으로 OK 예상)

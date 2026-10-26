# CI/CD 배포 속도 개선 (2026-10) — STATUS

계기: 백엔드 배포가 프론트보다 느림. 사용자 승인(2026-10-26): 메인 추천안을 백·프 모두 진행, 프론트 리뷰 결과도 추천대로 진행 후 보고.

## 세션·브랜치

| 역할 | 세션 | 레포 | 브랜치 · worktree |
|---|---|---|---|
| 메인(백엔드) | bun 메인 세션 | bun | `ci-onam-deploy-speed` · `.claude/worktrees/deploy-speed` (origin/main 5b88320 기준) |
| 프론트 | next-bun-0c | next-bun | `ci-onam-deploy-speed` (PR next-bun#386) |

## 기준선 (gh, 2026-10-26 main 배포)

| 단계 | 백엔드 run 40266281017 | 프론트 run 40266285869 |
|---|---|---|
| 검증 | 65s | 101s (Test 67s) |
| 이미지 build·push | **201s** (amd64+arm64 QEMU, 캐시 없음) | 86s (ARM 네이티브, gha 캐시) |
| converge 대기 | 93s | 87s |
| 총 | 약 6.5분 | 약 5분 |

### 적용 후 (2026-10-26 첫 main 배포)

| 단계 | 백엔드 run 40276022978 (bun#302) | 프론트 run 40276837488 (next-bun#388) |
|---|---|---|
| 검증 | 106s (build와 병렬) | verify 82s (Test 48s) · verify-sim 44s (병렬) |
| 이미지 build·push | **50s** (ARM 네이티브, 캐시 없는 첫 빌드) | 92s (병렬, 크리티컬 패스) |
| converge 대기 | 122s (monitor +30s) | 108s (monitor +20s) |
| 총 | **244s (−153s, −38%)** | **233s (−72s, −24%)** |

- 두 배포 모두 success(배포 스크립트가 서비스별 업데이트 상태를 확인), Actions artifact 0건
- 백엔드 크리티컬 패스는 이제 검증(106s). 기준선 65s보다 길어진 원인은 미확정(러너 편차·테스트 증가 1673→1787 추정)

원인(적용 전): `prod_nest`는 fs-01(ARM64)에만 배치되는데 amd64까지 빌드했고, arm64는 QEMU로 에뮬레이션했으며, 캐시가 없었다.

## 범위

### 백엔드 (이 브랜치)
- [x] 배포 빌드를 `ubuntu-24.04-arm`에서 arm64만 빌드하고 gha 캐시(`scope=arm64`) 사용, QEMU 제거
- [x] `build` 잡을 `ci`와 병렬로 실행하고 `deploy`는 `needs: [ci, build]` — 이미지 push만 먼저 하고 스택 반영은 ci 통과 뒤에
- [x] PR용 Docker 빌드(`ci-docker.yml`)를 arm64 네이티브로 바꾸고 같은 캐시 scope 사용(운영 아키텍처로 검증)
- [x] `.dockerignore` 확장(.git·docs·test·infra 등) · 배포 트리거 paths에 `.dockerignore`·`tsconfig*.json` 추가(backend-audit-2026-10 지적 사항)
- [x] `docs/deploy.md` 낡은 정보 정정: prod_next 레플리카 10 → 4(스택 YAML 기준), Next 이미지 `oven/bun:1` → `node:24`, NestJS 멀티아치 → arm64
- [x] healthcheck `interval` 30s→10s · `timeout` 10s→5s(헬스 엔드포인트의 terminus `pingCheck`가 기본 1s 타임아웃이고 `@SkipThrottle`) · `start_period` 40s·`retries` 3 유지 · `update_config.monitor` 60s→90s(unhealthy 판정 최악 시간 85s보다 길게). 사용자 결정(2026-10-26): 롤백이 작동하는 쪽을 택함, DB 순단 위험은 감수
- 배경(이전 상태): 프론트 리뷰 지적: 지금 값이면 unhealthy 판정까지 걸리는 시간(start_period + interval×retries, 백엔드 40+30×3 = 130s)이 `monitor: 60s`보다 길어, `failure_action: rollback`이 healthcheck 실패를 잡지 못하고 기동 직후 크래시만 잡는다. interval을 줄이면 롤백도 작동하고 converge도 빨라지지만, 백엔드 healthcheck는 DB ping이라 DB가 잠깐 끊겨도 태스크 재시작이 빨라진다(지금은 약 90s, 10s 간격이면 약 30s)
- [x] 커밋·PR·배포 — bun#301 → release bun#302 (사용자 지시 2026-10-26)

### 프론트 (next-bun-0c)
- [x] build·장기 테스트(verify-sim)를 verify와 병렬 · PR verify concurrency · healthcheck 10s/5s, start_period 30s, monitor 80s · `.dockerignore`에 infra — next-bun#386 → release #388
- 보류: cache-dance(서드파티 액션) · monitor 50s 축소(운영에서 실패 이미지로 롤백 시점 실측 뒤)

## 검증

- `actionlint` 통과. 남은 SC2086 info는 기존 `Set short SHA` 줄로, 원래부터 있던 것
- 미검증: 실제 실행. PR에서는 `ci-docker.yml`(arm64 빌드)만 돈다. 배포 경로는 **main 머지 후 첫 배포에서 단계별 시간과 성공 여부를 확인**한다

## 위험·롤백

- 이미지가 단일 arm64가 된다 — `prod_nest`를 AMD64 노드(fs-02·fs-03)에 배치하면 실행 불가. 배치를 바꿀 때 멀티아치를 다시 켠다
- 검증에 실패한 커밋의 이미지가 레지스트리에 남을 수 있음(배포는 안 됨)
- 롤백: 이 브랜치 커밋을 revert하면 이전 workflow로 돌아간다

## 다음 할 일

- 후속: 백엔드 검증 시간(106s) 단축 검토 · `deploy-to-oci.yml` workflow concurrency · monitor 축소 실측(운영 작업, 사용자 결정)

## 리뷰 (백엔드, node-runtime 브랜치와 함께)

| 라운드 | 리뷰어 | 확정 | 조치 |
|---|---|---|---|
| 1 | review-flow | 0 | — |
| 1 | Opus 서브에이전트 | 0 (PLAUSIBLE 2 · 문서 1) | build-push-action v6의 빌드 기록 artifact에 레지스트리 주소가 남을 수 있음(공개 레포) → `DOCKER_BUILD_SUMMARY`·`DOCKER_BUILD_RECORD_UPLOAD` false · healthcheck 주석의 판정 시간 수식 정정 · DB 순단 재시작은 사용자가 택한 트레이드오프라 유지 |
| 2 | review-flow | 0 | — |
| 2 | Opus 서브에이전트 | 0 | 두 env가 v6에서 유효함을 액션 소스(`src/main.ts:267-283`)로 확인 |

- 후속(기존 문제, 이번 회귀 아님): `deploy-to-oci.yml`에 workflow 단위 concurrency가 없어 main에 연속 push하면 배포가 겹칠 수 있음

# CI/CD 성능·안정성 개선 2차 (2026-11) — STATUS

계기: 사용자 요청(2026-11-05) — 다른 레포의 CI/CD 패턴 조사 후, 가져올 수 있는 것을 정리해 사용자가 선택. 1차 개선은 [`ci-deploy-speed-2026-10`](../ci-deploy-speed-2026-10/STATUS.md).
원칙(사용자 지시): **기능상 문제가 없어야 하고, 위험하면 하지 않는다. 사용자가 고른 항목만 한다.**

## 세션·브랜치

| 역할 | 세션 | 레포 | 브랜치 · worktree |
|---|---|---|---|
| 메인(백엔드) | bun 메인 세션 | bun | `ci-onam-cicd-perf` · `.claude/worktrees/cicd-perf` (origin/main 2301e65 기준) |
| 프론트 | `next-bun-f0` | next-bun | `ci-onam-cicd-perf` · `.claude/worktrees/cicd-perf` (origin/main c229eb7 기준) |

## 기준선 (gh, origin/main 최근 배포)

| | 크리티컬 패스 | 총 |
|---|---|---|
| 백엔드 run 41012527911 | verify 94s(∥ build 85s) → deploy 106s | 약 3m30s |
| 프론트 run 41012522786 | build 121s → deploy 100s | 약 3m53s |

## 조사 요약 (참고 레포 3곳)

- Nx·Turbo 모노레포 2곳 모두 **CI에서 모노레포 캐시를 실제로 쓰지 않음** — 하나는 캐시 키 결함으로 `--skip-nx-cache`, 다른 하나는 Docker에서 `next build` 직접 호출. 모노레포 전환의 CI 속도 이득은 근거 없음 → 제안하지 않음
- 영속 self-hosted 러너의 BuildKit cache mount 보존(빌드 17→9분)은 GitHub 호스티드 러너엔 그대로 적용 불가
- 가져올 것: main에서 빌드한 이미지를 재빌드 없이 태그로 재배포/롤백하는 수동 워크플로

## 후보와 결정 (사용자 결정 2026-11-05)

| # | 내용 | 결정 | 사유 |
|---|---|---|---|
| 1 | 프론트 `next build` 내 lint·typecheck 끄기 (−14s) | **안 함** | Next 빌드 타입검사는 `.next/types`(페이지 export·props 검증)를 포함해 `tsc`와 범위가 다름 — 빠지면 운영 유입 위험 |
| 2 | 프론트 빌드 캐시 export 방식 변경 (−15~25s 추정) | **보류** | 이미지 결과는 동일하나 registry 캐시는 1 OCPU/1GB 레지스트리 노드 부하, `mode=min`은 캐시 미스로 오히려 느려질 수 있음. 이득 미확정 |
| 3 | 백엔드 검증 잡 병렬화 + buildx cleanup 생략 (−10~20s 추정) | **진행** | 검사 항목·게이트 동일, 순서만 병렬 |
| 4 | cache-dance(서드파티)로 cache mount 보존 | **보류** | 1차 때부터 보류, 서드파티 의존 |
| 5 | 이미지 태그 지정 수동 롤백 워크플로 (백·프) | **진행** | 롤백을 재빌드 없이 배포 단계만으로(약 100s) |

## 범위

### 백엔드 (이 브랜치)
- [x] `ci.yml`: `verify`(ci:core 직렬) → `lint` ∥ `check`(typecheck → test → build) ∥ `e2e`. 검사 항목은 `ci:core`와 동일. 로컬 실측 lint 43s · typecheck 7s · test 26s · build 3s
- [x] `deploy-to-oci.yml`·`ci-docker.yml`: `setup-buildx-action` `cleanup: false` — 잡 종료 시 builder 제거(실측 Post 14s) 생략. 입력은 v3 `action.yml`에서 확인
- [x] 배포 단계를 재사용 워크플로 `deploy-prod-nest.yml`로 분리 — 기존 step 그대로, 태그 참조 1줄만 `inputs.image_tag`로. 앞에 태그 형식 검사 step 추가(셸 주입 방지). concurrency는 호출 쪽에만(같은 그룹이면 교착)
- [x] `rollback-prod-nest.yml`: `workflow_dispatch(image_tag)` → guard(main 여부 · 태그 형식 · `docker manifest inspect`) → 재사용 워크플로. concurrency `deploy-prod-nest`(배포와 공유)
- [x] `docs/deploy.md` "수동 롤백" 절 · README CI 게이트 설명 갱신

### 프론트 (`next-bun-f0`)
- [x] `deploy-prod-next.yml`(재사용) 분리 · `rollback-prod-next.yml` 추가 — 구조 동일. 롤백 가능한 `prod_next` 태그는 모두 arm64 단일(git 이력 근거)
- [x] 재사용 워크플로에 태그 형식 검사 step 추가(백엔드와 동일) · README "수동 롤백" 절 — actionlint 0, `main` 브랜치 보호·rulesets 없음

## 검증

- `actionlint`: 신규 지적 0 — 남은 SC2086 info 1건은 base에도 있는 `Set short SHA` 줄
- 배포 step 기계 diff: 기존 deploy job steps vs `deploy-prod-nest.yml` — 차이는 태그 참조 1줄 + 검사 step 추가뿐
- 브랜치 보호: bun `main`·`develop` 모두 보호 없음(`gh api …/protection` 404) → 잡 이름 변경(`verify` → `lint`·`check`)이 필수 체크에 영향 없음
- **미검증(남음)**: ① 롤백 성공 경로 — 현재 배포 중인 태그로 1회 실행(같은 이미지 롤링 재시작 가능, 사용자 승인 후). 결과가 "업데이트 없음"인지 재시작인지에 맞춰 문서 문구를 고친다 ② 코드 변경이 있는 배포(빌드 캐시 미스)에서의 크리티컬 패스 시간

## 결과 (2026-11-06 실측)

머지: bun #323 → develop, #324 → main · next-bun #403 → develop, #404 → main (모두 PR CI 통과 후)

| | run | 결과 | 비고 |
|---|---|---|---|
| 백엔드 main 배포 | 42166541640 | success, 총 2m43s (기준선 약 3m30s) | lint 25s · e2e 34s · **check 62s**(기존 verify 94s) ∥ build 17s → `deploy / deploy`(재사용) 94s, `prod_nest_app: completed` |
| 프론트 main 배포 | 42167723078 (next-bun) | success, 총 210s (기준선 233s) | build 90s → `deploy / deploy`(재사용) 101s(기준선 100s) |
| 백엔드 롤백 `zzz` | 42167715487 | guard 실패(태그 형식) · deploy skipped | 의도대로 |
| 백엔드 롤백 `0000000` | 42167727105 | guard 실패(레지스트리 확인) · deploy skipped | 로그인 성공 후 manifest 확인에서 차단 |
| 프론트 롤백 `zzz` / `0000000` | 42171678372 / 42173836319 (next-bun) | guard 실패 · deploy skipped | `no such manifest`로 없는 태그 구분 — 사설 레지스트리 `manifest inspect` 동작 확인 |

- 재사용 워크플로의 prod environment 시크릿 해석: 두 레포 모두 정상(rsync·ssh·레지스트리 통과)
- 검증 단계는 94s → 62s로 줄었다. 단 이번 두 배포는 빌드 캐시 적중(백엔드 build 17s, 프론트 의존성 레이어 CACHED)이라 총 시간 단축 대부분은 캐시 덕이다. 코드가 바뀌면 백엔드 build(약 85s)가 다시 크리티컬 패스가 되어 실효 단축은 추정치(−10~20s) 수준으로 본다

## 위험·롤백

- 재사용 워크플로 시크릿 해석이 실패하면 rsync/ssh 단계에서 멈춘다 — 서비스는 바뀌지 않는다. 되돌리기: 이 브랜치 커밋 revert
- 롤백 워크플로는 실행 시점 main의 스택 YAML을 쓴다 — 고른 이미지와 YAML(헬스체크 등)이 맞는지 확인한다
- 대기열: 같은 concurrency 그룹은 대기 1개만 유지 — 배포 진행 중 롤백·배포가 둘 다 대기하면 먼저 대기한 쪽이 취소된다. 롤백이 대기 중인 배포를 대체하는 상호작용은 이번에 새로 생김 → `docs/deploy.md`에 확인 절차 명시
- 롤백의 main 가드는 실수 방지일 뿐 강제력은 없다 — 두 레포 모두 prod environment에 배포 브랜치 제한이 없다(`deployment_branch_policy: null`). 기존 배포 워크플로도 같은 노출이라 이번 변경이 만든 구멍은 아님. 강제하려면 prod → Deployment branches를 main만 허용(사용자 결정)

## 게이트

- 머지 전 차단: 없음. 단 `docs/deploy.md`가 프론트 파일을 가리키므로 백·프 PR을 같이 머지한다
- 배포 직후 조치: 첫 main 배포 성공 확인(완료) → 롤백 워크플로 성공 경로 실행(사용자 승인 대기)
- 후속: 후보 2·4(보류) · 프론트 배포 순서 미보장(옛 SHA가 나중에 배포될 수 있음, 성능 외 결함 — 별건)

## 리뷰

| 레포 | 라운드 | 리뷰어 | 확정 | 조치 |
|---|---|---|---|---|
| 백엔드 | 1 | Opus 서브에이전트(결론 미제공) | 0 (PLAUSIBLE 4) | 대기 슬롯 상호작용·main 가드 강제력 없음·manifest 실패 메시지를 문서·주석에 반영. 레지스트리 HTTPS 전제는 build-push가 별도 설정 없이 push하므로 유지 |
| 백엔드 | 2 | review-flow(메인) · Opus 서브에이전트 | 0 · 0 (PLAUSIBLE 3) | no-op 주장 미검증 표기 · deploy-to-oci concurrency 주석에 롤백 상호작용 추가 · guard·deploy가 각각 prod 환경이라 승인 규칙 추가 시 2회 승인(기존 build 잡도 같은 패턴, 기록만). `ci:core` exit 0(경고 6 기준선, 1922/1922). 범위 밖 후속: CLAUDE.md:100 `ci:core` 서술에 typecheck 누락(기존) |
| 프론트 | 1 | review-front · Opus | 동작 0 · 문서 1(대기 1개 서술) | README·롤백 주석 수정 |
| 프론트 | 2 | review-front · Opus | 0 | — |

## 다음 할 일

1. ~~커밋·PR·머지~~ · ~~첫 main 배포 확인~~ · ~~롤백 실패 경로 시험~~ — 완료(위 결과)
2. 롤백 성공 경로 1회: 현재 배포 중인 태그로 실행(사용자 승인 후) → 결과에 맞춰 no-op 문구 정정
3. 다음 코드 변경 배포에서 크리티컬 패스 시간 확인
4. 사용자 결정: prod environment 배포 브랜치를 main만 허용할지

# Node 런타임 보안·고정 (2026-10) — STATUS

계기: Node 2026-10-21 보안 릴리스(High 4 · Medium 3 · Low 3, 패치 22.23.4 / 24.22.1 / 26.12.1). 판정 근거는 [DECISIONS.md](DECISIONS.md).

## 세션·브랜치

| 역할 | 세션 | 레포 | 브랜치 · worktree |
|---|---|---|---|
| 메인(백엔드) | bun 메인 세션 | bun | `chore-onam-node-runtime` · `.claude/worktrees/node-runtime` (origin/main 5b88320 기준) |
| 프론트 | next-bun-0c | next-bun | `chore-onam-node-runtime` · next-bun `.claude/worktrees/node-runtime` (origin/main 54265df 기준) |

## 결론

- 백·프 모두 **영향 API 직접 사용 0건** — 간접 경로(fetch의 br 자동 해제·next-auth 기본 Agent)는 고정 신뢰 호스트뿐 (D-001)
- 운영 백엔드 런타임 **v24.22.1 확인**(사용자 실행 `docker exec … node -v`). 프론트 운영 런타임은 고정 이미지(`node:24.22.1-bookworm-slim`) 배포로 해소(next-bun#388, 2026-10-26)
- Node 24 LTS 유지, 26 전환 안 함 · Next 16·Nest 12 메이저 업그레이드 안 함 (D-002·D-003)

## 범위

### 백엔드 (이 브랜치)
- [x] Dockerfile 두 스테이지 `node:24.22.1-bookworm-slim` 고정 + 사유 주석 (D-004)
- [x] dependabot에 `docker` ecosystem 추가(주 1회, 메이저 제외)
- [x] `@types/node` `^22` → `^24` (런타임 일치)
- [x] 미사용 `express`(^4, 직접 의존) · `swagger-ui-express` 제거 (D-005)
- [x] `docs/deploy.md` 베이스 이미지 표기 갱신
- [x] 커밋·PR·배포 — bun#300 → release bun#302

### 프론트 (next-bun-0c)
- [x] Dockerfile 두 FROM `node:24.22.1-bookworm-slim` · dependabot docker · `@types/node` `^20` → `^24` (타입 에러 0) · CI gha 캐시는 수정 불필요(buildx가 FROM 태그를 매번 다시 확인)
- 검증(next-bun-0c): lint 0 · typecheck 0 · test 1699 통과/12 skip · build 61/61 · 신규 경고 0
- [x] 커밋·PR·배포 — next-bun#385 → release #388

## 검증 (백엔드)

- `pnpm ci:core`: lint 0 errors / 경고 6(기준선 동일) · 단위 1787/1787(74 스위트) · build 통과
- `pnpm test:e2e`(sandbox 밖): 277 통과 · 58 skip · 실패 0
- `docker manifest inspect node:24.22.1-bookworm-slim`: amd64·arm64 존재
- 미검증: 로컬 `docker build`(실행 확인 대상이라 미실행) — CI `ci-docker.yml`이 PR에서 빌드한다

## 게이트

- 머지 전 차단: 없음
- 배포 직후 조치: 없음 (런타임은 이미 24.22.1 → 고정 태그와 동일)
- 후속 완료: `DockerfileBun` 삭제 · README 테스트 기준선 재측정 (`chore-onam-ci-followups`)

## 다음 할 일

- 완료

## 리뷰

- 1라운드 review-flow·Opus 모두 확정 0(`docs/tasks/ci-deploy-speed-2026-10/STATUS.md` 리뷰 표에 함께 기록). Opus가 레포 밖 격리 설치(`--frozen-lockfile --prod --offline`)에서 dist의 모든 require가 해석되는 것을 확인 — worktree 안 실행은 부모 레포 `node_modules`로 해석돼 의존성 누락을 못 잡는다

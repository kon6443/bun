# 백엔드 전수조사 후속 — 보안 '상' 등급 · CI/CD 개선

- **상태**: 🟢 커밋 지시 대기 — 구현·리뷰 루프(A·B 상·중 0)·로컬 API/Playwright 실측 완료(미커밋). S3·S8 보류 (2026-10-15)
- **최종수정**: 2026-10-15
- **관련 문서**: DECISIONS.md(결정·근거) · WORKLOG.md(전수조사 원표·리뷰 기록) · 짝 프론트 `../next-bun/docs/tasks/front-audit-fixes/STATUS.md` · 기등재 `../tasks-nestjs-improvements.md` D36(이 폴더의 S5가 처리)

## 세션·브랜치
| 역할 | 세션 | 브랜치 (base) |
|---|---|---|
| 메인·백엔드·문서 관리 | `bun-4a` | `feat-onam-audit` (`origin/develop` `371e578`) |
| 프론트 | `next-bun-86` | `feat-onam-audit` (`origin/develop` `b60ee60`) |
- 이 폴더는 메인만 수정한다. 프론트 세션의 질문·보고는 메인을 거쳐 사용자에게 간다.
- 작업트리의 기존 미커밋 변경은 다른 작업의 WIP다. 이 작업의 커밋에 섞지 않는다: `src/modules/auth/auth.service.ts`(카카오 지연 계측), `docs/tasks/tasks-error-dto-refactor.md`, `docs/tasks/tasks-nestjs-improvements.md`. 커밋할 때는 경로를 지정해 `git add`한다.

## 목표 & 수용 기준
- 무엇을: 전수조사의 심각도 '상' 항목(B1·B2·C1·C2)과, 이후 추가로 확정된 S6·S7을 기획 의도를 바꾸지 않고 수정한다. B3은 보류한다(D-007)
- 끝났다는 기준:
  - S1 — `GET /teams`, `GET /teams/:teamId/tasks`, `GET /teams/:teamId/tasks/:taskId` 응답 JSON에 `discordWebhookUrl`·`telegramChatId` 키가 없다 (응답 키 고정 단위 테스트)
  - S2 — `GET :teamId/telegram/status`·`GET :teamId/discord/status`가 MEMBER에게는 연동 여부만, MASTER·MANAGER에게는 지금과 같은 전체 정보를 준다. 상태코드는 200을 유지한다 (역할별 단위 테스트)
  - S4 — 모니터링 배포 스크립트에서 `.env`를 읽는 구간에는 xtrace가 꺼져 있다
  - S5 — PR과 main push에서 `ci:core`와 E2E가 돈다. 앱 배포 job은 이 검증이 성공해야만 실행된다
  - S6 — status=0 댓글의 `commentContent`는 `""`로 내려가고, 정상 댓글은 원문 그대로 내려간다 (단위 테스트)
  - S7 — 앱·infra 배포 job은 Swarm이 수렴에 실패하거나 롤백하면 실패로 끝난다. 스택 설정은 D-008·D-009의 값을 따른다
  - 공통 — `pnpm ci:core`가 통과한다: 에러 0, lint 경고 7 이하(기준선), 테스트 743개 이상 전부 통과
- 비목표: '중'·'하' 등급 항목(WORKLOG 2026-10-15 원표), 쿠키 전환(D-007), 의도된 정책 항목(D-002), GitHub 저장소 설정(Q3 보류)

## 지금 어디까지 (다음 세션이 여기서 이어간다)
- 완료: 전수조사, 상위 항목의 원본 코드 재확인, 사용자 결정 수령(D-002~D-010), 문서 리뷰 반영, 구현, 리뷰 루프 2라운드 수렴(A·B 상·중 0건)
- **다음 할 일**:
  1. 사용자 커밋 지시를 받으면 WORKLOG 구현 절의 커밋 초안대로 단계별로 커밋한다
  2. PR을 올리면 `CI`·`CI Docker build`의 첫 실행 결과를 확인하고 Q3(필수 체크 지정)를 다시 묻는다
  3. 배포 후 S7 판정 로그와 수렴 시간을 WORKLOG에 기록한다

## 실행계획 — 실행 순서대로, 1단계 = 1커밋
| 단계 | 내용 | 수정 방식 | 검증 | 커밋 |
|---|---|---|---|---|
| S1 (B1) | 팀·태스크 조회 응답에서 알림 채널 정보를 제거한다 | 컨트롤러가 `{...tm}`·`...task`를 그대로 내보내는 3곳을 공개 필드 화이트리스트로 매핑한다. 알림 경로가 쓰는 서비스 반환값은 그대로 둔다 | 응답 키 고정 테스트 | `fix(team)` — 본문에 "프론트 사용처 0건, 대응 불필요" |
| S2 (B2) | 연동 상태 조회를 역할별로 축소한다 (D-003) | 컨트롤러에서 역할을 판정해 MEMBER에게는 축소 응답으로 매핑한다. 서비스는 그대로 둔다 | MEMBER·MANAGER·MASTER별 테스트 | `fix(team)` — 본문에 계약 변경과 프론트 S7(지연 조회)을 명시. 배포 순서는 무관 |
| S4 (C1) | 모니터링 배포의 `.env` 로드 구간에서 xtrace를 끈다 | `source` 앞뒤를 `set +x`/`set -x`로 감싼다 | `bash -n` + diff 검토 | `fix(ci)` |
| S5 (C2) | CI 검증 게이트를 만든다 (D-005·D-010) | `ci.yml` 신설: 트리거는 `pull_request`·`push(main)`·`workflow_call`. pnpm 캐시, `concurrency`, `permissions: contents: read` 포함. `deploy-to-oci.yml`은 `uses: ./.github/workflows/ci.yml` job을 두고 deploy에 `needs: ci`를 건다 | `actionlint`가 있으면 실행, 없으면 YAML 파싱. 첫 PR 실행 결과로 최종 확인 | `feat(ci)` |
| S6 | 삭제 댓글 본문을 내보내지 않는다 (D-004) | `getCommentsByTaskId` 매핑에서 status=0이면 `commentContent: ""` | 삭제·정상 댓글 테스트 | `fix(team)` |
| S7a | 배포 성공·실패를 정확히 판정한다 (D-006·D-008) | 앱·infra 배포 스크립트에 `set -euo pipefail`과 `--detach=false`를 넣는다. 서비스별 `UpdateStatus.State`로 판정한다: `completed` 또는 상태 없음은 성공, `rollback_*`·`paused`는 실패이며 `docker service ps`를 출력한다. 전체 대기 상한은 15분 | `bash -n` + 다음 배포 로그 | `fix(ci)` |
| S7b | Swarm 스택 설정을 바꾼다 (D-008·D-009) | `infra/docker-stack.app.yml`: `update_config.monitor: 60s`, `restart_policy.delay: 10s`(재시작 횟수 상한은 두지 않는다). Dockerfile `HEALTHCHECK`를 제거해 스택 한 곳으로 모은다. `README.md:196`의 `prod_next` 레플리카 수를 4로 고친다 | `docker stack config -c`(로컬 docker가 있을 때) + 다음 배포의 수렴 시간 실측 | `chore(infra)` |
| S3 (보류 D-007) | Telegram webhook 출처 검증 | — | — | — |
| S8 (보류 D-007) | JWT 추출 Bearer 우선 | — | — | — |

## 진행 체크리스트
- [x] S1 · [x] S2 · [x] S4 · [x] S5 · [x] S6 · [x] S7a · [x] S7b (미커밋)
- [x] 최종 `pnpm ci:core` · sandbox 밖에서 `pnpm test:e2e` (9 suites / 97 tests)
- [x] 리뷰 루프(A·B 2라운드) · 로컬 API·Playwright 실측 (WORKLOG 2026-10-15 절)
- [ ] 사용자 지시 후 커밋 — 단계별 분리(같은 파일을 여러 단계가 고친 곳은 hunk 단위), WORKLOG 커밋 초안 8개
- [ ] 배포 후 확인: 첫 PR의 `CI`·`CI Docker build`, S7 이후 첫 배포 로그(판정 출력·수렴 시간)

## 미해결 질문 · 차단
| # | 질문 | 누구에게 | 상태 |
|---|---|---|---|
| Q1 | Telegram 시크릿 롤아웃 | 사용자 | 보류 (D-007) |
| Q2 | CI 게이트 범위 | 사용자 | 해결 (D-005) |
| Q3 | GitHub 저장소 설정(필수 체크·`prod` 환경 보호) | 사용자 | 보류 — S5 머지 후 다시 묻는다 |
| Q4 | 삭제 댓글 본문 비노출 | 프론트 조사 | 해결 (D-004) |
| Q5 | 쿠키 → Bearer 일원화 | 사용자 | 보류 (D-007) |
| Q6 | E2E 간헐 실패(기존 결함, WORKLOG 리뷰 루프 절)를 배포 게이트에 그대로 둘까 | 사용자 | 해결 — 유지(사용자 확인 2026-10-15). 첫 PR들의 CI 실패율을 보고, 재현되면 원인 수정을 후속 1순위로 |

## 결정 요약 (본문은 DECISIONS.md)
- D-001 '상' 항목만 이번 범위로 하고, 1단계 1커밋
- D-002 초대 링크 재가입과 팀원 간 이메일·생일 열람은 의도된 정책
- D-003 B2는 200을 유지하고 역할별로 응답을 축소한다
- D-004 삭제 댓글 본문은 `""`로 내려준다
- D-005 CI 게이트 = `ci:core` + E2E. Docker 빌드 검증은 관련 파일이 바뀐 PR에서만
- D-006 배포 실패가 전파되지 않는 문제 → S7
- D-007 S3·S8 보류
- D-008 배포 판정과 Swarm 설정을 바꾸고, 프론트 레플리카는 4로
- D-009 `restart_policy.max_attempts`는 두지 않는다 (D-008 일부를 대체)
- D-010 CI 게이트 연결 방식 = reusable workflow(`workflow_call`) + `needs`

## 검증 명령 (DoD)
- `pnpm ci:core` (lint → test → build) · 일부만 돌릴 때 `pnpm test -- --testPathPatterns <pattern>`
- 변경 심볼 grep 전수: `getMyTeams`·`getTasks`·`getTaskDetail`·`getLinkStatus`·`getCommentsByTaskId`
- E2E는 sandbox 밖에서 `pnpm test:e2e` (sandbox 안에서는 `listen EPERM`으로 실패한다)

## 위험 & 롤백
- **S1·S2 (API 계약)**: 응답 필드가 빠지거나 줄어든다. S1은 프론트 사용처가 0건이다. S2는 필드가 빠져도 프론트가 깨지지 않음을 확인했고(D-003), 동시 배포는 필요 없다. 롤백은 revert
- **S5**: CI가 실패하면 배포가 막힌다(의도된 동작). 롤백은 revert
- **S7**: 배포 job이 실제 수렴 시간만큼 길어진다. 롤백이 일어나면 job이 실패로 표시된다(의도된 동작). 판정 스크립트가 정상 배포를 실패로 잘못 보고하면 revert한다
- **게이트**: 머지 전 차단 — 없음 · 배포 직후 조치 — S7 이후 첫 배포 로그로 수렴 시간과 판정이 맞는지 확인 · 후속 — '중' 등급 항목, Q3 저장소 설정, 헬스체크의 DB 의존 분리(WORKLOG 리뷰 절 R-6)

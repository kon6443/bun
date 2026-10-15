# 백엔드 전수조사 후속 — 작업 기록

> append-only. 새 절은 맨 아래에 `## YYYY-MM-DD — <주제>`로 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 목차를 본 뒤 필요한 절만 읽는다.

## 2026-10-15 — 전수조사 원표 (src · CI/CD)

### 기준선 (develop `371e578`, sandbox)
- `pnpm lint`: 에러 0, 경고 7(전부 미사용 변수 — `custom-throttler.guard.ts:1`, `telegram.service.ts:354·449`, `scheduler.service.ts` 2건, `team.gateway.ts:160`, `team.service.ts:1116`)
- `pnpm test`: 33 suites, 743 tests 전부 통과. 테스트 종료 후 "worker process has failed to exit gracefully" 경고(열린 핸들)
- 타입 억제: 프로덕션 코드에는 `app.module.ts:7`의 `as any` 1건뿐(eslint-disable와 사유 주석 있음)
- build·E2E는 실행하지 않음

### 심각도 '상' → 이번 범위 (D-001)
B1 · B2 · B3 · C1 · C2 — 근거는 D-001

### 심각도 '중' (후속 후보, 이번 범위 아님)
| ID | 내용 | 위치 |
|---|---|---|
| M1 | `leaveTeam` 요청의 teamId와 소켓이 실제 등록된 팀이 같은지 검증하지 않음 → 비소속 팀 room에 `userLeft` 주입 가능 | `team.gateway.ts:243`, `fishing.gateway.ts:169` |
| M2 | 비활성화·강퇴 후에도 소켓이 room에 남아 팀 이벤트를 수신함. 두 번째 팀에 join해도 첫 팀 room을 leave하지 않음 | `team.gateway.ts` joinTeam, `team.service.ts` `updateMemberStatus` |
| M3 | 온라인 Redis 키의 TTL이 갱신되지 않음(소켓 1h, 해시 2h). 소켓 매핑 키가 하나뿐임 | `online-user.service.ts:5-10`, `fishing-online.service.ts` |
| M4 | 스로틀러: APP_GUARD가 인증보다 먼저 실행돼 user 분기가 무의미함. XFF 헤더는 조작 가능함. 카운트 저장소가 인메모리라 레플리카마다 따로 셈 | `custom-throttler.guard.ts:15-30`, `app.module.ts:94` |
| M5 | 쿼리스트링 `apiKey`가 요청 로그 URL에 마스킹 없이 남음 | `logger.module.ts`, `file-share.controller.ts` |
| M6 | `TASK_SLOT` 값이 없으면 1로 간주해 단일 실행 작업이 중복 실행될 수 있음 | `scheduler.service.ts:31` |
| M7 | 30초마다 500만 회 동기 루프가 이벤트 루프를 블로킹함 | `scheduler.service.ts:75` |
| M8 | DTO 길이·enum 검증 누락(`teamName`·`taskName`·`taskStatus`·`usageMaxCnt`·댓글) → ORA-12899 500 | `team.dto.ts` |
| M9 | fishing DTO의 `mapId` 등에 형식·상한 검증 없음 | `fishing.gateway.dto.ts` |
| M10 | Telegram 토큰 발급·연동이 트랜잭션·락 없이 처리됨. catch에서 오류를 삼킴. 업데이트 전체를 debug 로그로 남김 (락은 D22 기등재) | `telegram.service.ts:183·232·299` |
| M11 | 외부 fetch(카카오·Discord·Telegram)에 타임아웃 없음 | `auth.service.ts` `getKakaoId`, `discord.service.ts`, `telegram.service.ts` |
| M12 | 카카오 토큰 정보 응답의 `app_id`를 대조하지 않음 (정책 확인 필요) | `auth.service.ts` `getKakaoId` |
| M13 | 삭제 댓글의 `commentContent` 원문을 응답함 → 계획 S6 (프론트 조사 대기) | `team.service.ts:797-838` |
| M14 | 단위 테스트가 없는 영역: team/team-chat/telegram/file-share/auth 컨트롤러, throttler guard, redis adapter, env.validation, logger redact | — |
| CM1 | 앱·infra 배포에 `concurrency`가 없음. 앱 배포 SSH 스크립트에 `set -e`가 없음 | `deploy-to-oci.yml`, `deploy-infra.yml` |
| CM2 | Docker 레이어 캐시 없음. QEMU로 amd64·arm64를 동시에 빌드함(앱 배치는 ARM 노드뿐) | `deploy-to-oci.yml:40-48` |
| CM3 | `permissions` 블록 없음. 액션을 SHA가 아닌 태그로 고정함 | 워크플로 3개 |
| CM4 | SSH `StrictHostKeyChecking=no`. 시크릿을 `run`에 직접 보간함 | `deploy-to-oci.yml:52-53` 외 |
| CM5 | 컨테이너가 root로 실행됨. `caddy:latest` 등 부유 태그 사용 | `Dockerfile`, `infra/docker-stack.yml:5` |
| CM6 | Node/pnpm 버전의 단일 기준 없음(`engines`·`.nvmrc` 없음, `pnpm@8` EOL) | `Dockerfile:9,48`, `package.json` |

### 하 (요약)
`acceptTeamInvite` 동시 수락 시 ORA-00001(락 밖 조회) · file-share 동기 I/O와 스트림 정리 · 예외 객체 없이 메시지만 로깅(online-user 등) · 데드코드·주석 블록 · uncaught 예외 후 계속 실행 · 쿼리 enum 범위 미검증 · 페이지네이션 없음(D18 기등재) · `.dockerignore` 범위 좁음 · deploy 트리거 paths에 `tsconfig.build.json`·`tsconfig.runtime.json` 누락 · `DockerfileBun` 낡음 · `docs/deploy.md` 링크 깨짐

### 정책 확인 결과 → D-002
- 초대 링크 재가입: 의도됨
- 이메일·생일 열람: 허용 (프론트 UI 표시처 0건 — `next-bun/src`에서 grep `kakaoEmail|birth` 결과 없음)

## 2026-10-15 — 태스크 문서 리뷰 (1차: 백엔드 자체)
| ID | 지적 | 조치 |
|---|---|---|
| R-1 | "다음 할 일"이 이미 끝난 Q1~Q3 답변 수령에 머물러 있었다 | 착수 대기로 갱신 |
| R-2 | 목표·수용 기준이 처음 5건 기준이었다. 보류된 B3이 남아 있고, 추가된 S6·S7은 빠져 있었다 | S단계별 수용 기준으로 재작성 |
| R-3 | 실행계획 표 순서(S7→S8→S6)가 실행 순서와 달랐다 | 실행 순서로 재정렬하고 보류 단계는 맨 아래로 |
| R-4 | S5 게이트 연결 방식이 미정이었고, 위험 절에 존재하지 않는 `workflow_dispatch`를 근거로 들고 있었다 | D-010 |
| R-5 | B2 위험 절이 "프론트와 같은 날 배포"로 적혀 있어 D-003(동시 배포 불필요)과 모순됐다 | 동시 배포 불필요로 수정 |
| R-6 | D-008의 `max_attempts: 3`은 DB ping 헬스체크와 결합하면 DB 장애가 서비스 영구 중단으로 번진다 | D-009로 정정. 헬스체크 DB 의존 분리는 후속 |
| R-7 | S7 판정에서 infra 스택은 바뀌지 않은 서비스의 `UpdateStatus`가 비어 있을 수 있다 | 판정 규칙에 "없음=성공" 명시 |
| R-8 | DoD grep 목록에 보류된 `handleWebhook`은 있고 S6의 `getCommentsByTaskId`는 없었다 | 교체 |
| R-9 | 다른 세션 WIP와 섞일 위험이 있다 | 커밋 시 경로 지정 `git add` 명시 |
| R-10 | Dockerfile `HEALTHCHECK`를 제거해도 되는지 | `docker-compose.yml`은 DEPRECATED 주석뿐이고 스택이 값을 덮어쓴다 → 제거해도 영향 없음 |

## 2026-10-15 — 태스크 문서 리뷰 (2차: 프론트 문서 + 최종 교차)
- 프론트 `front-audit-fixes`에 지적 R-F1~R-F6을 보냈고 모두 반영됐다(프론트 DECISIONS 6차 절). 핵심은 R-F1이다: S24의 `max_attempts`를 제거하고 `delay: 10s`로 바꾼다(백엔드 D-009와 같은 정정).
- 최종 교차 대조 결과:

| 대조 항목 | 백엔드 | 프론트 | 판정 |
|---|---|---|---|
| Swarm 설정 | S7b: monitor 60s, delay 10s, 재시작 상한 없음 | S24: 같음, replicas 4 | 일치 |
| 배포 판정 | S7a: `set -euo pipefail` + `--detach=false` + UpdateStatus, 15분 | S12: 같음 | 일치 |
| 판정 → 설정 순서 | S7a → S7b | S12 → S24 | 일치 |
| 연동 상태 계약 | S2: 200 + MEMBER 축소 | S7: 관리 탭 진입 시 관리자만 조회, 필드 optional | 짝 맞음, 동시 배포 불필요 |
| 삭제 댓글 | S6: `""` | 변경 없음(타입 `string` 유지) | 일치 |
| CI 게이트 | S5: PR·main `ci:core`+E2E, `needs` | S12 C13: PR verify | 방향 일치 |
| 보류 | S3·S8, Q3 | F-1(쿠키)·Q7·Q8·C4·user-event | 일치 |
| 레플리카 수 문서 | S7b에서 `README.md:196` 수정 | 해당 없음 | 반영 예정 |

- R-F7: 프론트 DECISIONS의 "열린 질문" 표가 해소 전 권장안 그대로 남아 있어 오해 소지가 있다. 해소 안내 한 줄을 추가하도록 지시했다.
- 남은 사용자 확인: 착수 승인, 프론트 착수 순서(S13 → S12 → S24 → S1 → 나머지).

## 2026-10-15 — 구현 (S1·S2·S4·S5·S6·S7a·S7b)

### 단계별 변경과 검증
| 단계 | 변경 파일 | 검증 |
|---|---|---|
| S1 | `src/modules/team/team.mapper.ts`(신규: `toPublicTask`·`toMyTeamItem`), `team.controller.ts` `getMyTeams`, `team.service.ts` `getTasksByTeamId`·`getTaskWithComments`, `team.mapper.spec.ts`(신규), `team.service.task.spec.ts` | 응답 키 화이트리스트 테스트. 매핑을 되돌리면 2건 실패함(뮤테이션 확인) |
| S2 | `team.mapper.ts` `toLinkStatusForRole`, `team.controller.ts` 두 status 핸들러, `team.dto.ts` Swagger 설명(관리자 전용 필드는 optional), `test/team-access-control.e2e-spec.ts` | 단위 3건 + E2E 5건(MEMBER 2, MASTER·MANAGER, 비멤버 403). 축소를 되돌리면 E2E 2건 실패함 |
| S4 | `.github/workflows/deploy-monitoring.yml` | 로컬 재현: 수정 전에는 가짜 비밀값이 xtrace에 1회 출력, 수정 후 0회. YAML 파싱 통과 |
| S5 | `.github/workflows/ci.yml`(신규), `ci-docker.yml`(신규), `deploy-to-oci.yml`(`permissions`, `ci` job, `needs: ci`) | actionlint 신규 지적 0건(기존 SC2086 info 1건은 base에도 있음). 실제 동작은 첫 PR에서 확인 |
| S6 | `team.service.ts` `getCommentsByTaskId`, `team.service.comment.spec.ts` | 삭제·정상 2건. 되돌리면 1건 실패함 |
| S7a | `deploy-to-oci.yml`·`deploy-infra.yml` SSH 스크립트 | 가짜 docker로 7개 시나리오 판정 확인: completed→0, rollback_completed→1, paused→1, 이전 배포의 롤백 기록→0(업데이트 없음), 상태 없음→0, deploy 명령 실패→1, 시간 초과 중 updating→1 |
| S7b | `infra/docker-stack.app.yml`(monitor 60s, restart delay 10s), `Dockerfile`(HEALTHCHECK 제거), `README.md:196`(4 replicas) | `docker stack config` 통과(env_file 줄만 뺀 사본으로 검증) |

### 최종 게이트
- `pnpm ci:core`: lint 에러 0·경고 7(기준선과 같음), 단위 테스트 34 suites / 753 tests 통과(+10), build exit 0
- `pnpm test:e2e`(sandbox 밖): 18 suites / 187 tests 통과
- 변경 심볼 grep 전수: `getLinkStatus` 호출 2곳, `getTasksByTeamId`·`getTaskWithComments`·`getCommentsByTaskId` 각 1곳, 매퍼 3종의 사용처가 모두 위 변경 범위 안에 있음. 알림 채널 필드의 남은 사용처는 알림 포트 경로뿐임

### 구현 중 판단
- S1: 태스크 응답에서 팀 필드(`teamName`·`teamDescription`·`leaderId`)도 함께 빠진다. 선언 타입·Swagger DTO·프론트 타입(`app/types/task.ts`)에 없는 필드이고, 프론트 사용처를 grep한 결과도 0건이다.
- S1: `getMyTeams`의 `userActStatus`는 DTO에 없지만 지금도 내려가고 있어 그대로 유지했다. 이번 변경은 노출 차단만 한다.
- S7a: appleboy `script_stop`은 쓰지 않았다. 줄마다 종료코드 검사를 끼워 넣어 여러 줄 구문과 충돌할 수 있어서다. 실패 전파는 `set -euo pipefail`과 마지막 `exit "$FAILED"`가 맡는다.
- S7a 미검증: `{{.UpdateStatus.StartedAt.Unix}}` 템플릿과 롤백 시 `--detach=false`의 실제 종료코드는 첫 배포 로그로 확인한다.

### 커밋 초안 (사용자 지시 후)
1. `fix(team): 팀·태스크 조회 응답에서 알림 채널 정보 제거` — 본문: 원인(조회 헬퍼 결과를 펼쳐서 응답), API 계약(웹훅 URL·chatId·태스크의 팀 필드 제거, 프론트 사용처 0건이라 대응 불필요)
2. `fix(team): 알림 연동 상태 조회를 일반 멤버에게는 연동 여부만 반환` — 본문: 원인(변경 API는 관리자 전용인데 조회만 멤버 전체에 열림), API 계약(MEMBER 응답 축소, 200 유지, 프론트 S7과 배포 순서 무관)
3. `fix(ci): 모니터링 배포에서 .env 로드 구간 xtrace 끄기`
4. `feat(ci): PR·배포 전 검증 게이트 추가` — 본문: D36 실사고, 배포는 같은 SHA의 검증 통과 후에만 실행
5. `fix(team): 삭제된 댓글 본문을 응답에서 비움`
6. `fix(ci): 배포 job이 Swarm 수렴 실패·롤백을 실패로 보고하도록`
7. `chore(infra): swarm monitor 60s·재시작 간격 10s, 헬스체크를 스택으로 일원화`

## 2026-10-15 — 리뷰 루프 (A: 메인 /review + review-flow, B: 독립 Opus 서브에이전트)
- 기준: `origin/develop` `371e578` (13:19 fetch, HEAD와 같다). 다른 세션 WIP 3파일은 제외.

### 1라운드
| 출처 | 심각도 | 지적 | 교차 판정 | 조치 |
|---|---|---|---|---|
| A | 중 | 판정 템플릿 `StartedAt.Unix`가 nil이면 템플릿 오류 → set -e로 오판 실패 | CONFIRMED | `{{if .UpdateStatus.StartedAt}}…{{else}}0{{end}}` |
| B | 중 | ssh-action v1.0.0 `command_timeout` 기본 10m < 스크립트 상한 15m → 판정·진단 출력이 잘림 | CONFIRMED | 두 step에 `command_timeout: 20m` |
| B | 하 | `GET /teams` 응답 노출을 고정하는 테스트 없음 | CONFIRMED | `test/team-chat.e2e-spec.ts` 케이스 추가, 뮤테이션 시 1건 실패 확인 |
| B | 하 | `INFO=$(inspect)` 실패 시 set -e로 진단 없이 종료 | CONFIRMED | `|| { …; FAILED=1; break; }` |
| B | 하 | script_stop 주석 근거가 레포 사례(deploy-monitoring)와 상충 | CONFIRMED | 주석 정정 |
| B(미확인) | 중 | CLI 반환 직후 swarm이 아직 `updating`이면 정상 배포를 실패로 오판 | 위험 인정 | 진행 중 상태는 DEADLINE 안에서 5초 간격 재조회 |
- review-flow: 프론트 소비자 대조(타입 정의 `TeamMemberResponse`·`Task`·`TaskDetail` + 사용처 grep), Swagger, 소켓 payload(명시 필드 10종) — 지적 없음

### 2라운드 (수정분만)
- B: "상·중 미해결 0건". 5건 모두 해소, 신규 결함 없음(break 흐름·`|| {}`와 errexit·상한 계산 확인, 두 파일 판정 구간 identical)
- A: 가짜 docker 9개 시나리오 × 2 워크플로 재실행 기대대로, `pnpm ci:core` 통과(경고 7·753 tests·build 0) → 종료 조건 충족

### 리뷰 중 추가 발견
- **E2E가 `.claude/worktrees/` 사본까지 수집**하고 있었다(9 suites 중복 → 이전에 보고한 "18 suites / 187 tests"는 사본 포함 값). `test/jest-e2e.json`에 `testPathIgnorePatterns`(`<rootDir>/.claude/`)를 추가했다 → 9 suites / 97 tests. CI는 git checkout이라 영향이 없지만 로컬 판정이 부풀려지고 있었다.
- **E2E 간헐 실패(기존 결함)**: 로컬 반복 실행에서 매번 다른 스위트(WS 낚시·main·file-share·team-chat)가 가끔 실패했다. 작업트리 기준 2/8(병렬)·2/10(`--runInBand`), 변경 전 코드(`git archive HEAD` 사본) 1/8. 변경 전에도 재현되므로 이번 변경이 원인이 아니다. 다만 S5가 E2E를 배포 게이트에 넣었으므로 CI에서도 같은 빈도라면 배포가 가끔 막힌다 → 사용자 확인 필요(STATUS Q6).
- 커밋 초안 추가: 8. `test(e2e): E2E 수집에서 .claude/worktrees 사본 제외` (`test/jest-e2e.json`). 리뷰 반영분은 해당 단계 커밋에 합친다: command_timeout·판정 루프 → 6번, GET /teams E2E → 1번.

## 2026-10-15 — 로컬 API·Playwright 실측 (/teams/1, 사용자 로그인 MASTER 계정, 조회·화면 동작만)
- 환경: 이번 브랜치의 로컬 dev(백엔드 3500, `REDIS_PORT=6380` — 6379는 다른 프로젝트 Redis라 덮어씀 / 프론트 3000). 기존 chat-persistence worktree 서버 3개는 사용자 지시로 종료. Playwright는 캐시된 1.63 모듈 + chromium-1228 실행 파일을 직접 지정(레포 의존성 추가 없음). 측정 후 서버 종료, 로그인 상태 파일 삭제.
- API(GET만) 16/16: `/teams`·tasks(활성 16·보관 1)·상세 15건에 알림 채널 키 없음, 팀 목록 키 = 프론트 사용 필드 + `userActStatus`, status 2종 MASTER 전체 응답, users 200. **미검증**: MEMBER 축소 응답(계정이 MASTER — E2E로 보장), 삭제 댓글 `""`(표본에 삭제 댓글 0건 — 단위 테스트로 보장).
- 화면(390·768·1280 + 375×667): 콘솔·HTTP 에러 0, 4개 뷰 가로 넘침 0px, 모바일 토글 44px, `?view=`·`?tab=archive`·뒤로가기·새로고침 유지, 빠른 탭 전환·첫 로딩 중 탭 전환 후 스켈레톤 0, 상세 왕복 후 뷰·스크롤 복원, 연동 상태는 관리 탭 진입 시 1회만 조회.
- 프론트 결함 2건 발견 → 프론트 세션 수정 2회 → 재측정 전부 PASS: 캘린더 팝오버가 고정 하단 내비·FAB와 겹침(48·56px), 위로 띄울 때 달력 헤더(다음 달 버튼) 덮음. "+N개" 줄바꿈도 수정.
- 사고 1건: 측정 중 프론트 세션의 `bun run build`가 공유 `.next`를 덮어써 dev 서버 500 → 재기동. 이후 dev 서버 가동 중 build 금지로 합의.

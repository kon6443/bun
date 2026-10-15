# 백엔드 전수조사 후속 — 결정 로그

> 새 결정은 맨 아래에 추가한다. 기존 항목은 고치지 않는다. 결정이 뒤집힐 때는 새 항목에 `supersedes D-00N`을 쓴다.

## D-001 — 이번 범위는 심각도 '상' 5건, 1단계 1커밋 (2026-10-15)
- **맥락**: 전수조사 결과 백엔드 26건, CI/CD 30건이 나왔다. 사용자 지시는 "백엔드 '상'을 우선 처리하되, 기존 기획 의도와 차이가 없는 개발 수정이면 진행"이다.
- **결정**: B1(응답에 알림 채널 정보가 노출됨), B2(연동 상태 조회에 토큰·URL이 노출됨), B3(Telegram webhook 출처 미검증), C1(모니터링 배포 xtrace로 시크릿 노출), C2(CI 검증 게이트 없음 — 기등재 D36)를 다룬다. 단계마다 커밋을 하나씩 만든다.
- **근거 (원본에서 직접 재확인)**:
  - B1: `team.controller.ts:133` `teamMembers.map((tm) => ({ ...tm, ... }))`. 이 데이터의 출처인 `team.service.ts:173-174`가 `t.telegramChatId`·`t.discordWebhookUrl`을 SELECT한다. 프론트 `src`에서 두 필드의 사용처는 0건이다.
  - B2: `team.controller.ts:690`·`:763`은 `verifyTeamMemberAccess`만 확인한다. 응답은 `telegram.service.ts:404` `token: pendingLink.token`, `discord.service.ts:167` `webhookUrl: team.discordWebhookUrl`이다. 같은 리소스의 변경 엔드포인트(`:654`, `:701`, `:722`, `:774`)는 전부 `requireManagerAccess`를 쓴다.
  - B3: `telegram.controller.ts:30`에 인증이 없다. `src`에서 `secret_token`·`Secret-Token`을 grep하면 0건이다. webhook 등록(`setWebhook`)은 레포 밖에서 수동으로 한다.
  - C1: `deploy-monitoring.yml:115`의 `set -euxo pipefail` 다음 `:121`에서 `source .../.env`를 실행한다.
  - C2: `deploy-to-oci.yml:18-23`에는 `deploy` job 하나뿐이고 lint/test 단계가 없다.
- **버린 대안**: '상'·'중'을 일괄 처리하는 안. diff가 커져 리뷰하기 어렵고, 의도 확인이 필요한 항목이 섞인다.
- **영향**: 프론트 짝 변경은 B2 하나(상태 조회 경로)이고 B1은 없다.

## D-002 — 의도된 정책으로 확인된 항목은 수정하지 않는다 (2026-10-15)
- **맥락**: 전수조사의 '메인 검증 요청' 항목 중 정책 판단이 필요한 것이 있었다.
- **결정**: (1) 강퇴(비활성화)된 멤버가 유효한 초대 링크로 스스로 재가입하는 것(`team.service.ts` `acceptTeamInvite` 재활성화 분기)은 의도된 동작이다. (2) 팀원끼리 서로의 `kakaoEmail`·`birth`를 열람하는 것(`GET /teams/:teamId/users`, `team.service.ts:941-942`)도 허용된 동작이다.
- **근거**: 사용자 답변 (2026-10-15)
- **영향**: 이 두 동작을 바꾸지 않는다. 다만 (2)는 프론트 UI에 표시처가 없고 API 응답에만 들어 있다(사용처 확인은 프론트 세션 조사 중).

## D-003 — B2는 403이 아니라 200 + 역할별 축소 응답 (2026-10-15)
- **맥락**: 프론트는 UI 탭을 `canManageInvites`로 관리자에게만 보여준다(`TeamManagementSection.tsx:217-229`). 그런데 `TeamBoard.tsx:133/147`·`useTeamData.ts:101`이 모든 사용자에 대해 상태를 조회한다.
- **결정**: MEMBER에게는 연동 여부만 담은 200 응답을 준다. MASTER·MANAGER에게는 현행 응답을 그대로 준다.
- **근거**: 403으로 바꾸면 일반 멤버가 팀 화면에 들어갈 때마다 에러 응답과 프론트 에러 처리가 생긴다. 축소 응답은 기존 호출을 깨지 않으면서 노출만 없앤다.
- **버린 대안**: 403 + 프론트 조회 차단. 두 레포를 동시에 배포해야 하는 결합이 생긴다.
- **영향**: 프론트는 축소 응답에서 빠지는 필드를 optional로 다뤄야 한다. 비관리자 조회를 건너뛰는 것은 선택(최적화) 사항이다.

## D-004 — 삭제 댓글 본문은 빈 문자열로 내려준다 (2026-10-15)
- **맥락**: `getCommentsByTaskId`(`team.service.ts:797-838`)는 status 필터 없이 원문을 반환한다. 프론트는 화면에서만 가린다(`TaskDetailPage.tsx:773`).
- **결정**: status=0 댓글의 `commentContent`를 `""`로 매핑한다. 목록에서 제외하지 않는다 — "삭제된 댓글입니다" 자리 표시는 유지한다.
- **근거**: 프론트 세션 조사 — `commentContent` 사용처는 `TaskDetailPage.tsx` 4곳(:168·:196·:391·:777)이다. 삭제 댓글은 렌더(:773)와 편집 진입(:751)에서 모두 걸러진다. 소켓 `CommentDeletedPayload`(`types/socket.ts:121-126`)에는 본문이 없다. 타입은 `string` non-null이다(`app/types/task.ts:22` 등).
- **버린 대안**: `null`은 프론트 타입 계약과 어긋나 짝 커밋이 필요하다. 목록에서 제외하면 자리 표시 UX가 바뀐다(의도 변경).
- **영향**: 프론트 변경 없음. 응답 값만 바뀌고 필드 구조는 그대로라 API 계약은 유지된다.

## D-005 — CI 게이트 범위 (2026-10-15)
- **맥락**: STATUS Q2, 기등재 `../tasks-nestjs-improvements.md` D36에 "결정 필요: 러너 사용량·E2E·멀티아키"가 남아 있었다.
- **결정**: PR과 main push에서 `pnpm ci:core`와 `pnpm test:e2e`를 돌린다. Docker 빌드 검증은 `Dockerfile`·`package.json`·`pnpm-lock.yaml`·`tsconfig*.json`이 바뀐 PR에서만 단일 아키텍처로 하고 push는 하지 않는다. 앱 배포는 이 검증이 성공해야만 실행된다.
- **근거**: 사용자 답변 "권장대로" (2026-10-15). E2E는 `createE2eApp()` 기반이라 DB에 접속하지 않는다(CLAUDE.md Never 표).
- **영향**: `.github/workflows/ci.yml` 신규, `deploy-to-oci.yml` 게이트 연결. 저장소 필수 체크 설정은 Q3로 보류한다.

## D-006 — 배포 실패가 성공으로 보이는 경로를 막는다 (2026-10-15)
- **맥락**: 사용자가 "`--detach=false`를 지정하지 않으면 백그라운드로 진행된다"는 설정이 백엔드와 프론트에 제대로 돼 있는지 확인을 요청했다. 이 문제는 bun-37 세션이 프론트 로그에서 먼저 찾았다.
- **근거**:
  - `deploy-to-oci.yml:69`에는 `--detach=false`가 있다. 하지만 스크립트에 `set -e`·`script_stop`이 없고, 마지막 명령이 `docker stack services`(:73)다. ssh-action은 마지막 명령의 종료코드로 성패를 판정하므로, 수렴에 실패해도 job은 성공으로 끝날 수 있다.
  - `deploy-infra.yml:38`에는 `--detach=false`도 `set -e`도 없다. 이 경우 업데이트를 예약만 하고 바로 성공으로 끝난다.
  - `deploy-monitoring.yml:66·:144`에는 `--detach=false`와 `script_stop: true`, `set -euxo pipefail`이 모두 있다(정상).
  - 프론트 `oci_build_and_deploy_next.yml:99`에는 `--detach=false`가 없다. 이후 Replicas 폴링은 기존 태스크 10/10을 보고 0초 만에 통과한다. 근거는 bun-37이 확인한 run 38530773208 로그의 `Converged at 0s: 10/10`이다.
- **결정**: 백엔드는 S7을 추가한다(앱 배포에 `set -euo pipefail`, infra 배포에 `--detach=false`와 `set -euo pipefail`). 프론트는 짝 레포 S12에 `--detach=false`를 넣는다.
- **영향**: 배포 job이 실제 수렴 시간만큼 길어진다. 롤백이 일어나면 job이 실패로 표시된다(의도된 동작).

## D-007 — S3(Telegram webhook 시크릿)·S8(Bearer 우선)은 보류한다 (2026-10-15)
- **맥락**: STATUS Q1과 Q5(짝 프론트 F-Q3)에 대한 사용자 답변이다.
- **결정**: 두 단계 모두 착수하지 않는다. 근거 조사는 D-001과 WORKLOG에 남겨 두고, 재개할 때 그대로 쓴다.
- **참고 (Q1 설명용 사실)**:
  - 봇은 서버 전체에서 하나다(`telegram.service.ts:89` `BOT_TOKEN_TELEGRAM`). 시크릿은 봇의 webhook 1개에 묶인 값이고, 운영자(개발자)가 서버 env와 `setWebhook`에 같은 값을 넣어 관리한다. 팀 단위 값이 아니며, 팀의 연동 절차(`/start <토큰>`)는 바뀌지 않는다.

## D-008 — 배포 판정은 스크립트와 Swarm 설정을 함께 바꾼다. 프론트 레플리카는 4로 (2026-10-15)
- **맥락**: D-006의 후속이다. 사용자에게 (가) 스크립트만 바꾸는 안과 (나) Swarm 설정도 함께 바꾸는 안을 제시했다.
- **결정**:
  - 사용자 답변 "프론트 레플리카 4개로", "스웜 설정 나머지는 추천대로"를 따른다.
  - 앱·infra 배포 스크립트: `set -euo pipefail`을 넣고, `docker stack deploy --detach=false`로 바꾼다. 성공 판정은 `UpdateStatus.State`가 `completed`일 때만 한다. 실패하면 `docker service ps`를 출력하고 exit 1로 끝낸다. 전체 대기에 15분 상한을 둔다.
  - 백엔드 스택: `update_config.monitor`를 10s에서 60s로 늘린다. `restart_policy`에 `max_attempts: 3`·`window: 120s`를 추가한다. `order: start-first`·`failure_action: rollback`·`parallelism: 1`은 그대로 둔다.
  - 헬스체크: Dockerfile `HEALTHCHECK`(10s/5s/3/60s)가 스택 값(30s/10s/3/40s)에 덮어써지고 있으므로, 스택 쪽 하나로 일원화한다.
  - 프론트(짝 레포): 레플리카를 10에서 4로 줄인다. parallelism은 1로 유지한다(4개라 순차 교체여도 시간이 짧다). monitor와 restart_policy는 백엔드와 같은 값으로 맞춘다.
- **근거**:
  - 헬스체크 간격이 30s인데 monitor가 10s라서, 뜬 직후 곧 죽는 태스크가 롤백 판정에 잡히지 않는다(`infra/docker-stack.app.yml` healthcheck와 update_config 값).
  - `restart_policy: on-failure`에 상한이 없어 크래시 루프가 무제한으로 반복된다.
- **버린 대안**: 프론트 parallelism 2. 레플리카를 4로 줄였으므로 필요가 없어졌다.
- **영향**:
  - 배포 job 시간이 실제 수렴 시간만큼 늘어난다. 태스크당 헬스 통과와 monitor 60s가 더해지므로, 백엔드 3개는 수 분이 걸린다. 다음 배포 로그로 실측한다.
  - `README.md:196` `prod_next (10 replicas)`를 4로 고쳐야 한다(배포 사실 SSOT).
  - 프론트 처리량은 10개에서 4개로 줄어든다. 사용자가 결정한 사항이다.

## D-009 — `restart_policy.max_attempts`는 두지 않는다 (2026-10-15, supersedes D-008의 restart_policy 부분)
- **맥락**: 문서를 리뷰하다가 D-008에서 추천한 `max_attempts: 3`·`window: 120s`의 부작용을 발견했다.
- **근거**: 백엔드 헬스체크는 DB ping이다(`src/modules/main/health.controller.ts:23-25` `this.db.pingCheck('database')`). DB가 몇 분만 장애를 일으켜도 모든 레플리카가 unhealthy가 된다. 그러면 재시작 시도가 상한에 닿고, Swarm은 그 태스크를 포기한다. 결과적으로 DB가 복구된 뒤에도 서비스가 다시 뜨지 않고, 다음 배포 때까지 내려간 채로 남을 수 있다. 무상태 서비스가 스스로 복구되는 능력을 잃는 셈이다.
- **결정**: `max_attempts`와 `window`는 넣지 않는다. 대신 `restart_policy.delay: 10s`를 둬서 크래시 루프의 재시작 간격만 벌린다. 프론트도 같은 값으로 맞춘다(사용자 지시 "나머지는 추천대로"의 범위 안에서 추천을 정정한 것이다. 사용자에게 보고한다).
- **버린 대안**: `max_attempts` 유지. DB 장애가 서비스 영구 중단으로 번질 위험이 있다.
- **후속**: 헬스체크가 DB에 의존하는 구조 자체(liveness와 readiness 미분리)는 WORKLOG 리뷰 절 R-6에 남긴다.

## D-010 — CI 게이트는 reusable workflow + `needs`로 연결한다 (2026-10-15)
- **맥락**: STATUS S5에는 `workflow_run`과 job `needs` 두 안이 열려 있었다.
- **결정**: `ci.yml`에 `workflow_call` 트리거를 둔다. `deploy-to-oci.yml`이 이를 `uses:`로 호출하고, deploy job은 `needs: ci`로 그 결과를 기다린다.
- **근거**: `workflow_run`은 기본 브랜치의 워크플로 정의로 실행된다. 또 트리거 커밋과 배포 커밋이 같은지 직접 보장하지 않는다. `needs`는 같은 실행 안에서 같은 SHA를 검증하고 배포한다.
- **버린 대안**: `workflow_run`.
- **참고**: 앞서 STATUS 위험 절에 있던 "긴급 시 `workflow_dispatch` 수동 배포"는 삭제한다. 현재 앱 배포 워크플로에는 이 트리거가 없다. dispatch 관련 결정은 프론트 Q8과 함께 보류돼 있다.

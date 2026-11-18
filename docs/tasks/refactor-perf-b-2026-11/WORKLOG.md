# 리팩터링·성능 B 등급 — 작업 기록

> append-only. 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## \|^### "`로 목차를 본다.

## 2026-11-16 — 착수 조사 (원표는 `../refactor-perf-survey-2026-11/WORKLOG.md` 2026-11-16 절)
- B1 대상(액세스 토큰 서명 검증): `jwt-auth.guard.ts`(HTTP, Optional·Viewer가 상속), `ws-jwt-auth.guard.ts`(/teams), `fishing-ws.guard.ts`(게스트 폴백), `game-room/game-room-socket.ts`(게임 대전, 게스트 폴백), `custom-throttler.guard.ts`(스로틀 키, `typeof sub === 'number'`). 소켓 토큰 추출 3곳 동일 규칙(auth.token → Bearer). 페이로드 타입 4중. `team.service.ts`의 `verify`는 **초대 링크 토큰**(teamId·userId 페이로드)이라 제외
- B1 보존할 메시지: HTTP `AuthInvalidTokenErrorResponseDto` "JWT_SECRET이 설정되지 않았습니다." / "유효하지 않은 토큰입니다."(sub 없음) / "토큰 검증에 실패했습니다."(verify 실패) · WS `AUTH_INVALID_TOKEN` 같은 3갈래 · fishing·game-room은 실패 = 게스트
- B9: 백엔드 변경 불필요 — 댓글 PATCH 응답 `data: comment`, DELETE `data: null`, POST `data: comment`
- `TASK_SLOT` 판정 5곳: `scheduler.service.ts:31`(`|| 1`), `fortress-result.service.ts:93`(`|| 1`), `tetris-battle-result.service.ts:112`(`|| 1`), `fortress-match.service.ts:136`(`!== '1'`), `online-user.service.ts:50`(`?? 0`) → D-002

## 2026-11-17 — 백엔드 B1~B4 구현
| ID | 파일 | 내용 |
|---|---|---|
| B1 | `common/utils/access-token.utils.ts`(+spec 신규) · `jwt-auth.guard.ts` · `ws-jwt-auth.guard.ts` · `fishing-ws.guard.ts` · `game-room/game-room-socket.ts` · `custom-throttler.guard.ts` | `AccessTokenPayload` 단일 정의, `verifyAccessToken`(실패 사유 NO_SECRET·INVALID·NO_SUBJECT만 반환, 에러 모양은 가드가), `extractSocketAccessToken`. `jsonwebtoken` import는 helper·발급(auth)·초대 토큰(team)만 남음. 가드 메시지 3종을 HTTP·WS spec에 고정(이전엔 클래스·코드만 단정) — 변이 검출 2/2 |
| B3 | `team-integration.controller.ts`·`team-integration.dto.ts`(신규) · `team.controller.ts` · `team.dto.ts` · `team.module.ts` · e2e 2개 | 텔레그램·디스코드 6개 라우트 + `requireManagerAccess` 이동(경로·가드·Swagger 데코레이터 그대로), TeamController에서 Telegram·Discord 주입 제거 |
| B2 | `game-room/game-room-ports.ts`(신규) · `game-room.rules.ts` · `game-room-presence.ts` · 두 방 서비스 · `fortress-room.rules.ts` | `GameSocketIdentity`(게임별 스킨은 확장)·`ClientTraits`·`LiveSocketProbe`·`SocketEvictor`·`GameRoomChangeListener<T>` 공용, `findUserSeat`·`isSeatTakeOverBlocked` 순수 함수(거부는 각 게임 에러로), `recordHeartbeatSafely`. 각 게임은 같은 이름으로 재export해 import 경로 불변 |
| B4 | `team.gateway.ts`·`online-user.service.ts` | `joinTeam`이 온라인 목록 한 번으로 내 접속 정보까지 얻음(목록 상한 100에 잘리면만 따로 조회) — Redis 왕복 5→3 |
| B4 | `game-room-presence.ts`(`LocalAttemptThrottle`) · 두 방 서비스 | 하트비트 판정 게이트(SET NX) 시도를 레플리카에서 방당 간격 1번으로 — 하트비트마다 붙던 왕복 제거 |
| B4 | `common/utils/replica.utils.ts`(+spec) · scheduler·결과 서비스 2·포트리스 스위퍼·온라인 지표 · `.claude/rules/data-access.md` | `isLeaderReplica()` 단일 판정(D-002·D-004), 규칙 문서 예시 갱신 |
| B4 | — | 로비 목록 공유 캐시는 하지 않음(D-003) |
- 검증: `pnpm ci:core` lint 0 errors/경고 6(기준선), 단위 2321/2321(108 스위트), build 통과 · 팀 E2E(invitation·access-control·chat·tag) 64/64

## 2026-11-17 — 프론트 B5~B9 보고 (next-bun-fe) · 백 ci:all
- 위치: `next-bun/.claude/worktrees/team-nickname`, 브랜치 `refactor-onam-perf-b`(base origin/develop `3179c49`), 46파일 +819 −877, 미커밋
- B5 팀 보드 리렌더(채팅 열림·안읽음 분리, 카드·행 memo, 검색 useDeferredValue) — 남의 채팅 2+읽음 1에 보드 렌더 2→0 · B6 서비스 6개 에러 처리 `apiError.ts` 공통화(문구·코드 불변) · B7 포트리스 충전 1.6s 렌더 100→≤2, 턴 타이머 56→2, 낚시 게이지·타 유저 이동 프레임 렌더→0(StrictMode 타이머 2배속 해소) · B8a 연동 훅 `useIntegrationLink` · B8b 리플레이 키·DPR 공용화 · B9 댓글 작성·수정·삭제를 재조회 없이 응답 반영
- 프 리뷰 루프 3라운드(review-front + Opus): 수정 4건(댓글 성공 시 오류 배너 해제, 늦게 온 옛 상세 조회 무시, 테트리스 리플레이 숫자패드 판정 복원, 언마운트 시 순번 정리) 각 회귀 테스트, 3차 양쪽 확정 0 · `ci:core` 통과(2587 통과·15 skip)
- 계약 질의 답(메인): POST·PATCH 댓글 응답 data는 엔티티 그대로라 **userName 없음**(`team.controller.ts:471·513`), POST crtdAt은 DB 기본값이라 비어 있을 수 있음(:468 폴백), PATCH mdfdAt은 non-null(`team.service.ts:734`). 상세 comments는 status 0 포함·본문 ''(`team.service.ts:909~937`) → B9 이름 처리 보완을 프론트에 요청, 백 응답은 불변 유지
- 백 `pnpm ci:all`(sandbox 밖) 통과: E2E 19 스위트 350 통과·68 skip, build OK

## 2026-11-17 — 백엔드 리뷰 루프 (review-flow + 독립 Opus)
| 라운드 | review-flow | 독립 | 반영 |
|---|---|---|---|
| R1 | 확정 0 · 하트비트 판정 지연 상한 ~2배(PLAUSIBLE) | 확정 0 · 같은 지점 | 실패한 게이트 시도도 기억하던 `LocalAttemptThrottle` → **잡은 게이트만 기억하는 `LocalGateHold`** — 판정 지연 0(B-R1) |
| R2 | 확정 0 · `now`가 기록 왕복 전 값이라 경계 수 ms 어긋남 · 테트리스 연결 테스트 공백 | 확정 0 · 시계 역행·테트리스 공백 | 여유 500ms·테트리스 미러 테스트(B-R2) |
| R3 | 확정 0 · 벽시계 스텝 보정·간격 경계 테스트 공백 | 확정 0 · 기록 지연 >500ms면 한 핑 늦음 | **단조 시계(`performance.now()`)를 SET NX 직전에 재서** 기억(B-R3·R4) — 시각 배관 제거, 간격−여유 경계 테스트(양 게임) |
- 그 밖 지적(전원 비결함): 스로틀 키 sub=0 → IP(발급되지 않는 값, 다른 가드와 규칙 통일) · joinTeam 목록 조회 실패 시 0명 알림을 안 보냄(개선 쪽) · Swagger operationId가 `TeamIntegrationController_*`로 바뀜 — 프론트는 코드젠·operationId 미사용(프론트 세션 grep 0건) · `TASK_SLOT` 미주입 환경(QA가 스택 밖이라면) 크론·스윕 정지는 D-002 의도, 배포 전제로 남김
- 변이 검증: isHeld 제거·기억 시점 앞당김·간격 상수 변경·여유 제거·벽시계 사용 — 양 게임 11/11 검출
- 백 `ci:core` 2328/2328, lint 경고 6(기준선) · 실 Redis opt-in E2E 6스위트 68/68 · `ci:all` 통과(R1 전 시점)
| R4 | 확정 0 · "SET 직전 시각" 미고정(변이 생존)·prune 테스트에 살아 있는 항목 없음·쓰지 않는 옵션 | 확정 0 · joinTeam 빈 줄 | 시계 점프 테스트(SET 응답 뒤 400ms)·prune에 살아 있는 항목·옵션 제거(상수 `GATE_HOLD_SAFETY_MARGIN_MS`) |
| R5 | **확정 0** (변이 전부 검출, `>=`→`>` 1건은 동작 동일) | **확정 0** | 주석 위치·"반드시 실패" 표현만 다듬음 → 루프 종료 |

## 2026-11-17 — 실 API·Playwright (백 3510 + Redis 6380, 프 3000 dev)
- 실 API: 연동 라우트 무토큰 401 `AUTH_UNAUTHORIZED`, 잘못된 토큰 `AUTH_INVALID_TOKEN` "토큰 검증에 실패했습니다.", Swagger 6경로 유지
- 로그인 불필요: 포트리스 AI 대전 충전 HUD·버튼 수치 상승·발사·Q/E(데스크톱), 모바일 길게 눌러 충전(버튼 19→52·조작 바 슬라이더 따라감) · 데스크톱 aria-label·덱 슬라이더 고정은 base 동일(프 확인) · 리플레이 테트리스·디펜스 Space·←/→·버튼 포커스 — 테트리스 Ctrl+→ 이동·디펜스 버튼 포커스 중 → 무시는 base 동일
- 로그인(팀 121, 연동 미연결 팀에서만 쓰기): B9 14/14(작성 GET +1·팀 닉네임, POST 응답 crtdAt 실제로 옴, 수정 재조회 0·(수정됨)·500 배너→재시도 해제, 삭제 재조회 0·새로고침 동일) · B5 칸반 즉시 이동·500 원복+오류·검색 즉시/지연 필터·리스트 클릭·Enter·캘린더 렌더(날짜 없는 태스크라 막대 미확인) — 상세 이탈 중 콘솔 "Failed to fetch task detail"은 base 동일(문서 이동 시 cleanup 미실행) · B8a 상태 표시(121 미연결, 1 텔레그램 연동 완료), 연결·해제는 운영 DB·외부 발송이라 미실행
- dev watch 재시작 때 ioredis "Connection is closed" Unhandled Rejection 로그(앱 프레임 없음, 재시작 순간만) — 판정 보류, 후속
- B7 낚시(로그인, 실패 경로만 — 성공 시 잡은 물고기 저장을 피함): 포인트 접근 버튼·캐스팅→대기 820ms(StrictMode 2배속 해소)·입질 막대 92→74% 감소·챌린지 게이지 3→70% 이동·구간 밖 클릭 실패 판정 6/6, 비GET API 0건
- 리뷰 수정 뒤 재검증: 백 `ci:all` 통과(단위 2327, E2E 350 통과·68 skip) · 실 Redis opt-in E2E 68/68
- 미확인: 2계정 항목(채팅 배지·상대 댓글 실시간), 캘린더 막대(날짜 있는 태스크 없음), 연동 연결·해제(운영 DB·외부 발송)
- 2계정(팀 121, userId 43·1) 8/8: 상대 채팅 2건 → 내 배지 "2", 패널 열면 사라짐 · 상대 댓글 작성(팀 닉네임 "개발자")·수정((수정됨))·삭제가 상세에 실시간 반영 · 콘솔 오류 0. 테스트 흔적: 팀 121 채팅 2건, 태스크 226 삭제된 댓글 2건(운영 DB)
- 추가 확인(2026-11-18): 낚시 성공 경로 6/6 — 구간 안 클릭 → 결과 카드(피라미 12.3cm·48g), 보낸 것은 소켓 `catchResult` 1건뿐(백엔드는 같은 맵 다른 접속자에게 `catchNotification` 방송만, DB 저장 코드 없음 `fishing.gateway.ts:300`), 비GET API 0·localStorage 변화 없음·콘솔 오류 0 · 캘린더 3/3 — 팀 121에 날짜 있는 태스크 1401("B5 캘린더 검증", 11/17~11/20, 사용자 허가)을 만들어 막대가 4칸 폭으로 그려지고 클릭 시 상세로 이동. 테스트 흔적 추가: 태스크 1401(운영 DB)

## 2026-11-18 — 커밋·배포 (사용자 지시 "main < develop < ft 배포까지 백프 모두 진행")
- 백 커밋(의도별, 섞인 파일은 최종본 백업 → 중간본 커밋 → 복원으로 분리, 최종본과 cmp 일치): af840cf refactor(auth) B1 · cf088c9 refactor(team) B3 · e598ce6 refactor(game-room) B2 · 682b5e6 perf(game-room) B4 게이트 · a75b397 perf(team) B4 joinTeam · 7e2621a fix(infra) B4 TASK_SLOT · 문서
- 백 PR #338 ft→develop(CI check·lint·e2e 통과, 머지 `c6dde33`) → #339 develop→main(check·lint·e2e·docker-build 통과, 머지 `aecaca8`, dependabot node 이미지 갱신 #332 동반) → Deploy NestJS run 44211177900 success
  - 운영 확인: `GET /teams` 401 · `GET /games/tetris/rankings` 200 · 연동 라우트(`/teams/121/telegram/status`) 무토큰 401 · 잘못된 토큰 `AUTH_INVALID_TOKEN` "토큰 검증에 실패했습니다."
- 프론트(next-bun-fe): 6커밋(3bf791b perf(teams) B5 · 9ad53f2 refactor(services) B6 · 17cecef perf(games) B7 · 54038b3 refactor(hooks) B8a · aa3973a refactor(games) B8b · 833b003 perf(teams) B9), 커밋 전 ci:core 통과(2588 tests) → #415 develop(`a7b9126`) → #416 main(`41fd452`), CI verify·verify-sim 통과, Deploy Next run 44211104902 success
  - 운영 확인: `/`·`/games`·`/fishing`·`/teams` 200 · 게스트 Playwright로 4경로 콘솔 오류 0, 낚시 포인트 접근·캐스팅→입질 대기 정상
- 미검증: 로그인이 필요한 운영 화면, 텔레그램·디스코드 연결·해제
- 운영 DB 테스트 흔적(로컬=운영 DB): 팀 121 채팅 2건, 태스크 226 삭제된 댓글 2건, 태스크 1401 "B5 캘린더 검증"
- 롤백: 백 `aecaca8`·프 `41fd452` revert(DB 변경 없음). 커밋이 의도별이라 개별 revert도 가능

## 2026-11-18 — 후속: 종료 순서(ioredis 로그)·팀 소속 변경 경합 (브랜치 `fix-onam-team-membership-shutdown`)
- 정리: 백 dev(3510) 종료, Redis 테스트 컨테이너는 이미 없음(--rm), 원격 브랜치 백 51→main·develop / 프 44개 삭제(머지됨·열린 PR 없음 확인, 미머지 dependabot 1개는 PR #333 CLOSED라 사용자 지시 범위로 삭제)
- ioredis 원인 → D-005. 오프라인 재현(quit 뒤 punsubscribe·unsubscribe → UNHANDLED "Connection is closed" 2건)
- 팀 경합 → D-006. 프론트 사용 방식은 프론트 세션 답(leaveTeam 미사용·팀마다 새 연결)
- 검증: `ci:core` 통과(단위 2337 → 리뷰 반영 후 팀 395/395), lint 경고 6(기준선, team.gateway의 기존 1건 그대로), build · E2E team-gateway·fishing-gateway·main 29/29 · 변이 7/7 검출(disconnect 직렬화·끊긴 소켓 가드·이전 팀 정리·지금 팀 판정·join 직렬화·Redis 미준비 건너뜀 2)
- 리뷰 R1: review-flow 확정 0 · Opus 확정 0, PLAUSIBLE "Redis 끊긴 동안 다른 팀 입장이 오프라인 큐에서 멈춤"(양쪽 공통) → `isReady()`로 건너뜀 + 테스트. 나머지(시간 기반 대기·스웜 유예·SIGHUP·퇴장자 본인 USER_LEFT·전환 중 실패 상태)는 D-005·D-006에 수용 기록
- 미실행: 실 Redis opt-in `test/graceful-shutdown.redis.e2e-spec.ts`(예전 순서 거부 발생·키 잔존 / 새 순서 거부 0·정리 완료) — Redis 컨테이너 기동이 권한 분류기에 막힘
- 리뷰 R2: review-flow 확정 0 · Opus 확정 0. PLAUSIBLE(낮음) "Redis 미준비로 이전 팀 정리를 건너뛴 뒤 재연결되면 새 팀 등록이 매핑을 덮어 이전 팀 죽은 id가 남음" → 건너뛴 입장은 온라인 등록도 하지 않음 + 테스트(변이 검출). "검사 직후 Redis 끊김으로 정리가 재연결까지 대기"는 창이 µs·재연결로 끝나 수용. nit: 가짜 타이머 afterEach 복원 → 루프 종료
- 리뷰 R3(사용자 지시로 루프 재개): 메인 자체 검토 — Redis 미준비 팀 전환에서 등록하지 않았는데 다른 탭이 목록에 있으면 입장 알림이 나가던 것 → 알림 생략 + 테스트. Opus — CONFIRMED(테스트) opt-in E2E가 `process.on('unhandledRejection')`에 기대는데 Jest가 그 이벤트를 테스트 리스너에 넘기지 않음(메인 탐침으로 재확인: SEEN 0, 테스트 실패로 잡힘) → sub 연결의 `punsubscribe` 호출 시점 status를 기록해 단정(새 순서 ready, 예전 순서 ready 아님)으로 교체. PLAUSIBLE leaveTeam의 USER_LEFT가 인자 teamId로 감 → 지운 등록의 팀(`result.teamId`)으로 + 테스트. nit: 대기는 Redis만(DB는 shutdown 훅에서 닫힘) 주석
- 리뷰 R4: Opus CONFIRMED(테스트) socket.io가 루트 '/' 네임스페이스도 만들어 구독 해제가 2번 → 프로브 채널만 기록(메인이 `socket.io/dist/index.js:117` `this.sockets = this.of("/")`로 재확인), 클라이언트 finally 정리
- 리뷰 R5: Opus — 어댑터 close의 `unsubscribe` 거부도 Jest가 테스트 실패로 잡음 → 같이 삼킴(어댑터 소스 690-696으로 재확인). 운영 코드 확정 0
- 리뷰 R6: Opus CONFIRMED(테스트) quit()은 +OK에서 끝나고 status는 소켓 close 때 바뀌어 직후 punsubscribe에도 'ready' → status 대신 punsubscribe 결과(resolved / rejected:Connection is closed.)로 단정. Opus가 만든 루프백 가짜 RESP Redis(스크래치패드 `fake-redis.js`, 127.0.0.1 전용)로 메인이 실제 실행: 3/3 통과, closeAppThenRedis 순서를 뒤집으면 실패(변이 검출). 운영 코드 확정 0
- 리뷰 R7: Opus 확정 0·PLAUSIBLE 0, 메인 확정 0 → **루프 종료**. nit 수용: joinTeam 소요 시간 지표에 큐 대기가 포함됨(겹칠 때만) · 끊긴 소켓 입장의 ack는 버려짐(주석 추가)
- 브라우저 수준(백 dev 3510 — Redis 없이(6399 미기동), 프 dev 3000 프론트 세션): 2계정 8/8(팀 입장·실시간 채팅 배지·댓글 작성·수정·삭제 실시간, 콘솔 오류 0). 온라인 프레즌스는 Redis가 없어 브라우저로는 미확인(단위·E2E로만)
- 브라우저 수준에서 새로 발견: Redis가 끊긴 상태에서 SIGTERM → `quit()`이 오프라인 큐에서 재연결을 기다려 강제 종료 타이머(30초)까지 멈추고 exit 1(예전 순서도 같음, 스웜은 10초에 SIGKILL) → `RedisIoAdapter.disconnect()`가 ready가 아니면 바로 `disconnect()`(+ warn 로그). 실측: SIGTERM 뒤 약 1.1초에 "Redis 연결 정리 완료"·"Graceful shutdown 완료", Unhandled Rejection 없음. 단위 spec 2 + 변이 검출
- 리뷰 R8(어댑터 변경): Opus 확정 0 — 구독 모드에서도 status는 ready(ioredis `Redis.js:261-269`, quit은 구독 모드 허용 명령), 메인도 status 전이 목록으로 재확인. PLAUSIBLE 수용: 종료 순간 Redis가 잠깐 끊기면 대기 중 정리 명령이 버려짐(예전엔 30초 멈춤) · nit 반영: 바로 끊을 때 warn → **루프 종료**. 실 Redis 대체로 가짜 RESP Redis E2E 재실행 2/2
- 배포: 3커밋(64caf3e fix(realtime) · f97e98e fix(team) · 5b5b446 docs) → #341 develop(check·lint·e2e 통과, 머지 `14dc73a`) → #342 main(통과, 머지 `857f79c`) → Deploy NestJS run 44260450564 success
  - 운영 확인: `GET /teams` 401 · 랭킹 200 · 연동 라우트 무토큰 401 · 게스트 Playwright 4경로 콘솔 오류 0, 낚시 소켓 맵 입장·캐스팅 정상
  - 효과 확인 시점: 새 종료 순서는 **다음 배포에서 이번 레플리카가 내려갈 때** 처음 적용된다(이번 배포에서 내려간 레플리카는 옛 코드). 그때 Loki에서 "Connection is closed" Unhandled Rejection이 사라졌는지 본다
- 롤백: `857f79c` revert(DB 변경 없음), 커밋별 revert 가능
- 정리: 백 dev 종료, 프 dev 종료 요청, 원격 브랜치 `fix-onam-team-membership-shutdown`·이 문서 브랜치는 머지 뒤 삭제

## 2026-11-18 — 실제 Redis 검증 (사용자 로컬 docker 허가) · 로컬 정리
- 로컬 Redis 컨테이너(127.0.0.1:6380)로 opt-in 실 Redis E2E 7스위트 70/70 통과(`graceful-shutdown` 포함 — 가짜 Redis 대신 실제 Redis로 재확인)
- 브라우저 프레즌스(빌드본 `node dist/main` 3510 + Redis 6380, 프 dev 3000, 2계정): 입장 시 Redis 온라인 등록·A 화면 2명 → B 탭 닫으면 1명(USER_LEFT)·Redis에서 제거·소켓 키 정리 → A도 닫으면 비어 있음 **8/8**
- 배포 상황 재현(두 계정 접속 중 SIGTERM) — 같은 절차로 옛 코드(`d3f8250`)와 대조:

| | 종료 시간 | 종료 뒤 팀 온라인 | 소켓 키·유저 집합 | 로그 |
|---|---|---|---|---|
| 옛 코드 | 31초(강제 종료 타이머, exit 1) | **[43, 1] 남음(유령)** | 2 · 2 남음 | Unhandled Rejection ×2, `removeSocket 실패: Connection is closed.` ×2 |
| 새 코드 | 2초 | 비어 있음 | 0 · 0 | `Redis 연결 정리 완료` → `Graceful shutdown 완료` |

  - 옛 코드는 Redis가 살아 있어도 종료가 30초 타임아웃까지 멈췄다(스웜에선 10초 SIGKILL) — 이번 변경으로 함께 해소
- 로컬 정리: 백 worktree 15개 제거(로컬 브랜치는 유지). 보존 — 각 worktree의 `docs/handoff` 22개와 미커밋 문서 변경 4개(chat-persistence·claude-sessions·fortress·tetris-audit, develop보다 옛 진행 메모)를 패치로 메인 체크아웃 `docs/handoff/worktree-cleanup-20261118/`에 둠(gitignore). 원격에 없는 문서 마감 커밋 4개 브랜치(`docs-onam-defense-refactor-close`·`docs-onam-game-settings-close`·`docs-onam-games-ux-close`·`docs-onam-tetris-bundle-close` — 배포 기록 절)는 로컬 브랜치로 남음. 프 worktree는 프론트 세션이 정리(team-nickname은 그 세션 작업 폴더라 유지)

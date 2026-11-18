# 백·프 리팩터링·성능 전수조사 (2026-11) — 작업 기록

> append-only. 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## \|^### "`로 목차를 본다.

## 2026-11-16 — 전수조사 원표

### 방법
- 백엔드: `codebase-investigator` 3개 병렬(DB 접근 / 실시간·Redis·게임 / 구조·빌드·의존성), 기준 `origin/develop` `3e8f900`. 기등재 대조 범위: `backend-audit-2026-10` 원표·DECISIONS, `tasks-nestjs-improvements.md` 남은 작업, 각 태스크 STATUS의 후속
- 프론트: `next-bun-fe` 세션(영역별 에이전트 4개 + 원본 재확인), 기준 `origin/develop` `41c8cb6`, `pnpm build` 1회 실측
- 메인 재확인: 미사용 의존성(`git grep origin/develop` 0건), `poolMax: 3`(`src/config/database.config.ts:39`), WS 가드 소켓 캐시 차이, 동기 리플레이 검증, 낚시 DTO 상한 누락·`maxHttpBufferSize` 0건, 댓글 생성 응답 `data: comment`(`team.controller.ts:500`), `GET /teams/:teamId` 부재

### 실측
- 규모(`pnpm db:select`): USERS 10 · TEAMS 9 · TEAM_TASKS 188(팀 최대 98) · TASK_COMMENTS 84 · TEAM_INVITATIONS 26 · TEAM_CHAT_MESSAGES 130 · GAME_SCORES 157 · GAME_REPLAY_VIEW_STATS 19 · USER_POINT_LEDGER 80 · FORTRESS_PLAYERS 19
- 실제 인덱스(`user_ind_columns`): TEAM_TASKS·TASK_COMMENTS·TEAM_INVITATIONS는 PK(+TOKEN)뿐, USER_TEAMS는 PK `(USER_ID, TEAM_ID)`뿐, FORTRESS_PLAYERS는 PK `(MATCH_ID, PLAYER_ID)`뿐, GAME_SCORES는 `(GAME_TYPE, BOARD_KEY, SCORE DESC, SCORE_ID)`·`(…, CRTD_AT)` — 마이그레이션 정의와 일치
- 리플레이 검증(로컬 tsx, `simulateReplay`/`stepFrame`): 7,441프레임 2.3ms → 프레임당 ~0.3µs, 상한 216,000프레임 ≈ 70ms 추정(랜덤 입력은 7천 프레임 안에 종료돼 상한 도달 실측은 못 함)
- 프론트 빌드: EXIT 0, 44초. `/layout` 전용 청크 gz 82KB(react-colorful gz 18KB, socket.io gz 12KB 포함), `/` First Load 182kB / 공통 103kB. 프론트 CI run 43821739139 — verify 2:06(test 87초) · build 2:12 · 전체 4:14

### 백엔드 — DB 접근 (DB#)
| # | 항목 | 근거 | 등급 |
|---|---|---|---|
| 1 | 팀 WS 가드가 이벤트마다 USERS 조회(낚시 가드는 소켓 단위 캐시) | `ws-jwt-auth.guard.ts:58` vs `fishing-ws.guard.ts:52` | C(정책) |
| 2 | HTTP 인증마다 USERS 전체 엔티티 + 팀 API 멤버십 조인 | `jwt-auth.guard.ts:38`, `team.service.ts:811-826` | C (팀 이중조회는 D28 기등재) |
| 3 | 팀 도메인 조회 컬럼 인덱스 없음 | 위 실측 인덱스 | C |
| 4 | `rankOf` COUNT — 인덱스에 IS_HIDDEN 없음 | `games.service.ts:801-811` | C |
| 5 | 인기 리플레이 `all` 전체 집계·캐시 없음 | `games.service.ts:614-632` | C |
| 6 | 안읽음 COUNT 상한 없음·채팅 보존 정책 없음 | `team-chat.service.ts:221-245` | C(계약) |
| 7 | 포트리스 포인트: FORTRESS_PLAYERS(USER_ID) 인덱스 없음, 루프 SUM | `fortress-points.service.ts:50-114` | C |
| 8 | 포인트 잔액 SUM 2회 | `user-point.service.ts:110-139` | C (부분 기등재 `skin-levels/STATUS.md:26`) |
| 9 | `trophiesOf`가 이미 읽은 userId 재조회 | `games.service.ts:714` | C |
| 10 | 상한 없는 목록(태스크 CLOB 포함, 만료 초대 누적) | `team.service.ts:279-316, 1396-1400` | C (D18 기등재) |
| 11 | 표시 이름 조회 반복(상세에서 2회) | `team.service.ts:975-1005` | C |
| 하 | `findOne`+`save` → `update`, `exists`, 로비 채팅 senderOf, KAKAO_ID(기등재), me/best 인덱스(기등재) | — | C |

### 백엔드 — 실시간·Redis·게임 (실시간#)
| # | 항목 | 근거 | 등급 |
|---|---|---|---|
| 1 | 대전·솔로 테트리스 리플레이 검증이 메인 스레드 동기(방어는 워커 풀) | `tetris-battle-result.service.ts:220`, `tetris-game-engine.ts:105` | C (실측 ~70ms) |
| 2 | 포트리스 행동마다 경기 JSON(지형 2048열+행동 ≤480) 3회 로드 | `fortress-match.service.ts:217-240, 264-275`, `fortress-room.service.ts:667-697` | A6(a·b) / C(지형 분리) |
| 3 | 낚시 이벤트 서버 빈도 제한·입력 상한 없음, `maxHttpBufferSize` 기본 1MB | `fishing.gateway.ts:190-288`, `fishing.gateway.dto.ts:36,49` | A2 (M9 부분 기등재) |
| 4 | 낚시 `void pipeline.exec()` — 단절 시 오프라인 큐 누적 | `fishing-online.service.ts:253-263, 309-319` | A3 |
| 5 | `online-user`·`fishing-online` Redis 비ready 미확인 → 무한 대기 | `online-user.service.ts:136-250` | A3 (앱 전역은 `tetris-battle/DECISIONS.md:95` 기등재) |
| 6 | `removeSocket` 비원자 → 다른 탭 온라인 등록 삭제 가능 | `online-user.service.ts:218-250` | A4 |
| 7 | 로비 방송마다 방 200개 스캔·파싱 | `game-room.store.ts:90-120` | B4 |
| 8 | 행동마다 마감 타이머 누적, 각자 경기 전체 읽기 | `fortress-match.service.ts:443-448` | A6 |
| 9 | 하트비트 1건당 Redis 2왕복 | `game-room-presence.ts:9-16` | B4 |
| 10 | `joinTeam` Redis 왕복 ~8회 직렬, 빈도 제한 없음 | `team.gateway.ts:139-232` | B4 |
| 11 | `TASK_SLOT` 판정 4곳 상이(`\|\| 1` 포함) | `tetris-battle-result.service.ts:112` 외 | B4 (M6 부분 기등재) |
| 12 | 낚시 `joinMap`이 이전 맵을 떠나지 않음 | `fishing.gateway.ts:96-158` | A4 |
| 13 | lock 핫패스 방 JSON 파싱 | — | 기등재 BE-10 |
| 14 | uncaught 후 계속 실행 | `main.ts:220-228` | 기등재 |
| 15 | `main.ts` `setRedisClient` 14회 수동 주입 | `main.ts:93-120` | C (`realtime-ws.md` 규칙 개정 선행) |
- 문제 없음 확인: `KEYS`/`SCAN` 0건, TTL 없는 키 없음, 소켓 직렬화 큐 WeakMap, 타이머 전부 `unref`

### 백엔드 — 구조·빌드·의존성 (구조#)
| # | 항목 | 근거 | 등급 |
|---|---|---|---|
| 1 | 미사용 직접 의존성 `cors`·`discord.js`·`node-schedule` | `package.json:20,21,27`, `git grep` 0건 | A1 |
| 2 | JWT 검증 6곳·WS 토큰 추출 3곳·페이로드 타입 4중 정의 | `jwt-auth.guard.ts:64`, `ws-jwt-auth.guard.ts:103`, `fishing-ws.guard.ts:107`, `game-room-socket.ts:28`, `custom-throttler.guard.ts:72`, `team.service.ts:1220` | B1 |
| 3 | tetris/fortress 방 서비스 잔여 복제 | `tetris-battle-room.service.ts:273-320, 613-640, 1242-1259` ↔ `fortress-room.service.ts` | B2 |
| 4 | 관리자 권한 확인 3곳 복제, `role.constants.ts:102` 미사용 | `team.controller.ts:110-121`, `team.service.ts:1118, 1385` | A5 |
| 5 | `(error as Error).message` 60곳 | `error.utils.ts`에 message 헬퍼 없음 | A5 |
| 6 | 죽은 export(에러 DTO 5, events 페이로드 타입 등) | grep + AST import 추적 | Q2 결정 후 |
| 7 | `team.controller` 텔레그램·디스코드 구간 분리 | `team.controller.ts:660-815` | B3 |
| 8 | `test/`가 typecheck·lint 밖, E2E 타입 인지 변환 | `tsconfig.json` include, `jest-e2e.json` | C |
| 9 | Dockerfile 런타임 `unzip` 미사용 | `Dockerfile:43` | A1 (운영 수동 사용 여부 미확인) |
| 10 | team.service 주석 코드·중복 import | `team.service.ts:62, 72-76, 1108-1116` | A5 |
| 11 | `games.service.spec.ts` 1388줄 단일 | — | C |
| 12~14 | team.service 분리(D1)·CI 병렬화(`ci-cd-perf-2026-11`)·컨테이너 root(CM5) | — | 기등재 |

### 프론트 (프론트#, `next-bun-fe` 보고)
| # | 항목 | 근거 | 등급 |
|---|---|---|---|
| 1 | 루트 레이아웃 → 팀 배럴 → TagModal·TeamSocketContext가 전 페이지에 실림 | `AuthLoadingOverlay.tsx:5` → `teams/components/index.ts:7` | A7 |
| 2 | `SkinUpgradePanel` Esc가 설정 시트까지 닫음(stopPropagation만, preventDefault 없음) | `SkinUpgradePanel.tsx:99-103`, `useDialog.ts:56` | A8 (실브라우저 미확인) |
| 3 | TeamBoard가 채팅 컨텍스트 전체 구독 | `TeamBoard.tsx:242` | B5 |
| 4 | 게임 외 memo 0건(카드·행·캘린더) | `ListView.tsx:171`, `CalendarView.tsx:444` | B5 |
| 5 | 검색 입력 키마다 전체 필터 | `TaskFilters.tsx:103` | B5 |
| 6 | 낚시 bite·challenge 60회/초 setCtx | `useFishingState.ts:157,168` | B7 |
| 7 | 낚시 PLAYER_MOVED마다 새 Map → 컨텍스트 전 소비자 리렌더 | `FishingSocketContext.tsx:245` | B7 |
| 8 | 캔버스 DPR 상한 없음(낚시·테트리스) | `useGameCanvas.ts:23`, `TetrisCanvas.tsx:107` | A9 |
| 9 | 낚시 배경 매 프레임 재그리기 | `renderer.ts:101-171` | C |
| 10 | `handleApiError` 6벌·동작 불일치 | `teamService.ts:25` 외 5 | B6 |
| 11 | 거대 컴포넌트(TeamBoard 1251줄 등) | — | C |
| 12 | 포트리스 250ms·충전 rAF마다 1038줄 리렌더 | `FortressMatch.tsx:397, 503` | B7 |
| 13 | 탱크 Path2D·그라디언트 프레임당 생성 | `tankArt.ts:184` | C |
| 14 | TaskDetail 댓글 CRUD 후 전체 재조회, seq 가드 없음 | `TaskDetailPage.tsx:282-441` | A9(가드)·B9(부분 갱신) |
| 15·16 | 게임 간 중복, 텔레그램/디스코드 훅 복제 | — | B8 |
| 17 | 죽은 코드(심볼 7 + 파일 3) | grep + import 추적 | A9 |
| 18·19 | 낚시 모달 a11y, useAuthenticatedFetch 취소 | front-audit-fixes WORKLOG | 기등재·보류 |
| 20 | 비null 단언 28, 소켓 런타임 검증 없음 | — | C |
| 21 | CI 병렬화 효과 없음(실측) | run 43821739139 | C |
- 계약 항목: C1 edit 페이지가 팀 이름만 필요한데 태스크 전체 조회(백엔드에 `GET /teams/:teamId` 없음) · C2 재연결 시 4~5건 재조회 · C3 댓글 응답 활용(B9) · C4 초대 목록 lazy · C5 낚시 이동 서버 스로틀 없음(A2) · C6 `/teams` 서버 프리패치
- 이상 없음: 이미지·폰트, 의존성 8개 모두 사용, three 동적 청크, 소켓 on/off 짝

## 2026-11-16 — A 구현 (백엔드 A1~A6)

### 변경
| ID | 파일 | 내용 |
|---|---|---|
| A1 | `package.json`·`pnpm-lock.yaml`·`Dockerfile` | `cors`·`discord.js`·`node-schedule` 제거(lock 190줄, 전이 의존 10개 동반 제거), 런타임 `unzip` 제거 |
| A2 | `fishing-rate-limit.ts`(신규)·`fishing.gateway.ts`·`fishing.gateway.dto.ts`·`fishing-ws.guard.ts`·`redis-io.adapter.ts` | 소켓 단위 빈도 제한(D-004), DTO 상한, `maxHttpBufferSize` 100KB |
| A3 | `online-user.service.ts`·`fishing-online.service.ts` | `isRedisReady()` 가드(비ready면 실패 기본값), 낚시 `fireAndForget`가 `exec()` 거부를 로그로 받음 |
| A4 | 같은 두 서비스·`fishing.gateway.ts` | `REMOVE_SOCKET_SCRIPT` Lua로 제거 원자화, `joinMap`이 다른 맵이면 `leaveMap`(공용 private) 먼저, 퇴장 후 `_fishingMapId` 해제 |
| A5 | `role.constants.ts`·`team.service.ts`·`team.controller.ts`·`team.mapper.ts`·`error.utils.ts` + 12파일 | `hasManagementPermission(role: string)`, `TeamService.assertManagerAccess(teamId, userId, forbidden)`로 3곳 통합(에러 코드·메시지 불변), `toErrorMessage()` 59곳, 주석 코드·중복 import 정리 |
| A6 | `fortress-match.service.ts`·`fortress-room.service.ts` | D-005 |

### 검증
- `pnpm ci:core`: lint 0 errors / 경고 6(기준선 동일), 단위 2281/2281(105 스위트), build 통과
- 추가 테스트: `fishing-rate-limit.spec.ts`(4), 게이트웨이(맵 이동·퇴장 후 캐시·빈도 제한 5·DTO 상한 5), 프레즌스 두 서비스(Lua 인자·결과 판정·비ready 기본값·exec 거부), 포트리스(읽기 1회·남은 끊김 해제 2·깨우기 2)
- 변이 검증 6/6 검출: move 빈도 제한 제거, 맵 이동 시 leave 제거, submit 끊김 해제 제거, 깨우기 번호 확인 제거, 팀 비ready 가드 제거, fishName `@MaxLength` 제거
- Lua 본문 의미는 opt-in `test/online-presence.redis.e2e-spec.ts`(`PRESENCE_REDIS_TEST_PORT`) — 로컬 Redis 없음(Docker 꺼짐)으로 **미실행**

## 2026-11-16 — A 구현 (프론트 A7~A9, next-bun-fe 보고)
- 위치: `next-bun/.claude/worktrees/team-nickname`, 브랜치 `refactor-onam-perf-a`(base `41c8cb6`), 미커밋 28파일 +77/−168, 신규 테스트 2·삭제 파일 3
- A7: 원인이 루트 레이아웃만이 아니라 팀 배럴(`teams/components/index.ts`)의 `TaskForm` export였다 — 배럴을 쓰는 홈·/games 등이 TagModal(dnd-kit·react-colorful)·TeamSocketContext(socket.io)를 실었다. `AuthLoadingOverlay` 직접 import + 배럴에서 TaskForm 제거(사용처 2곳 직접 import) + 프론트 `.claude/rules/components.md` 갱신
  - `/layout` 전용 청크 gz 81.7KB(11개) → 21.9KB(4개). First Load `/` 182→114kB, `/auth/signin` 188→134, `/mypage` 187→141, `/teams` 189→147, `/games/tetris/play` 255→213, `/games/fortress/battle/[code]` 290→261, `/games/defense/play/endless` 271→230 (TaskForm을 원래 쓰는 `/teams/[teamId]` 222→221 등은 그대로)
- A8: `SkinUpgradePanel.tsx:104` `preventDefault()` + 회귀 2건(defaultPrevented 확인) — 변이 검출
- A9: DPR 상한 2(낚시 `useGameCanvas`, 테트리스 `TetrisCanvas`·`MiniBoard`, 스프라이트 캐시는 ctx 변환 기준이라 영향 없음) · `TaskDetailPage` seq 가드 + 마지막 조회 기준 로딩 해제(테스트 2) · 죽은 심볼 18개·파일 3개 삭제(엔진 사본·계약 사본·불완전 열거가 되는 상수는 의도적으로 유지)
- 검증: `ci:core` EXIT 0 — lint 0, typecheck 0, test 2461 통과/15 skip(287 파일), build 67/67. 리뷰 1라운드 review-front·Opus 모두 확정 0
- 미검증(메인 Playwright 대상): 실브라우저 Esc, 로그인 필요한 TaskDetail, 3x 실기기

## 2026-11-16 — 백엔드 리뷰 R1 (리뷰어: review-flow · Opus)
| # | 지적 | 리뷰어 | 판정 | 조치 |
|---|---|---|---|---|
| 1 | 비ready 가드가 `removeSocket`·`isSocketRegistered`(정리 경로)까지 막아 끊긴 동안 닫힌 탭이 유령 온라인으로 남음 — 죽은 socketId 때문에 이후 마지막 탭 판정도 영영 안 됨 | 둘 다 | 확정 | 정리 경로는 가드 제거(오프라인 큐에 맡겨 재연결 뒤 적용, 기다리는 쪽은 disconnect·leave 핸들러). 가드는 등록·조회에만. 테스트 "정리는 그대로 명령을 보내야 함" + 변이 검출 |
| 2 | 늦게 끝난 `leaveMap`이 그 사이 같은 맵에 다시 들어온 `joinMap`의 room·캐시를 지움 | Opus(의심) | 확정(코드 경로) | `_fishingJoinSeq` — leave 시작 뒤 join이 있었으면 room·캐시를 건드리지 않음. 경합 테스트 + 변이 검출 |
| 3 | `addUserToOnline`의 SCARD와 등록이 나뉘어 제거 Lua와 겹치면 userLeft 뒤 userJoined 누락(기존 결함) · 같은 소켓 중복 제거 시 userLeft 중복 | review-flow | 확정(A4 범위) | 등록도 Lua(`ADD_SOCKET_SCRIPT`), 제거 Lua 첫 줄 `DEL==0 → 0`. 두 스크립트를 `common/utils/presence-scripts.ts`로 공용화 |
| 4 | 이동 고정 윈도가 몰려 온 최신 위치를 버림 | review-flow(의심·낮음) | 수용 | 정상 20/초의 2배 한도라 네트워크 정체 후 몰림에서만. D-006 |
| 5 | submit 안 끊김 해제가 CAS 시도를 쓰고 실패를 전파 | review-flow(의심·낮음) | 수용 | Redis 오류면 이어지는 load도 실패, 왕복 경합은 8회 한도 안에서 드묾. D-006 |
- 검증: `ci:core` lint 0 errors/경고 6, 단위 2280/2280, build 통과. opt-in Redis E2E에 중복 제거·등록 판정 케이스 추가(미실행 — 로컬 Redis 없음)

## 2026-11-16 — 실제 Redis 검증 + 백엔드 리뷰 R2 (리뷰어: review-flow · Opus)
- 로컬 Redis(`docker run redis:7-alpine` 127.0.0.1:6380, 사용자가 Docker 기동)로 opt-in E2E 전부 실행: `PRESENCE_/FORTRESS_/TETRIS_BATTLE_/THROTTLE_REDIS_TEST_PORT=6380 pnpm test:e2e -- --testPathPatterns redis` → 6 스위트 68/68 통과(신규 online-presence 포함 — 등록·제거 Lua 의미, 동시 종료·중복 제거 판정 1회)

| # | 지적 | 리뷰어 | 판정 | 조치 |
|---|---|---|---|---|
| 1 | 같은 맵 퇴장 직후 재입장 — seq 가드는 room·캐시만 지키고, 늦은 `removeSocket`이 방금 한 등록을 지움 | review-flow | 확정 | 아래 직렬화 |
| 2 | 맵 B·C 이동이 겹치면 B의 room·등록이 유령으로 남음 | 둘 다 | 확정 | 아래 직렬화 |
| 3 | 맵 이동 joinMap이 Redis 끊김 동안 멈춤(이전 맵 정리를 기다림) | Opus | 수용 | base도 모든 joinMap이 멈췄다(회귀 아님). 현재 맵은 하나라 맵 이동이 없다. D-007 |
| 4 | 팀 leaveTeam이 room 이탈 전에 Redis 정리를 기다림 · 팀 leave→join 경합 | Opus(의심) | 후속 | 이번 변경 밖(team.gateway 미변경, base와 같음) — STATUS 후속 |
- 조치: 낚시 게이트웨이의 입장·퇴장·연결 해제를 소켓 단위 큐로 직렬화(`membershipQueues`, tetris-battle `socketQueues`와 같은 방식), `_fishingJoinSeq` 제거. 테스트 3(퇴장 중 재입장·연달은 맵 이동·입장 중 연결 해제) + 변이 검출(직렬화 제거 시 3건 실패)
- 검증: `ci:core` lint 0 errors/경고 6, 단위 2282/2282, build 통과 · Redis E2E(online-presence·fishing) 19/19

## 2026-11-16 — 백엔드 리뷰 R3 (리뷰어: review-flow · Opus) — 두 리뷰어 확정 0, 루프 종료
- review-flow: 확정 0 (직렬화 큐 구현·교착 없음·`_fishingJoinSeq` 잔존 0 확인, 실제 Redis online-presence 5/5)
- Opus: 확정 0 (전체 diff 재추적, 단위 2282·Redis E2E online-presence·fortress-match 10/10)
- 두 리뷰어 공통 비차단 제안 반영(수정 2줄 + 테스트 3):
  - `leaveMap` 첫 줄에서 맵 캐시를 먼저 비움 — 정리 대기 중 들어온 이동이 지운 위치를 다시 쓰지 않게
  - 큐 안 join 시작 시 `client.disconnected`면 등록하지 않음 — 가드(DB) 대기 중 끊긴 소켓의 유령 등록 방지(base에도 있던 경합)
  - 큐 실패 전파·다음 작업 진행 테스트
  - 변이 검출 2/2
- `pnpm ci:all` EXIT 0: lint 0 errors/경고 6, 단위 2285/2285(105), E2E 350 통과·68 skip(opt-in), 스텁·build 통과 (로그: scratchpad `ci-all.log`)

## 2026-11-16 — 로컬 실 API·Playwright 검증
- 환경: 백엔드 `refactor-onam-perf-a` dev :3510(Redis = 로컬 컨테이너 6380, `.env`는 사용자가 원본에 심볼릭 링크) · 프론트 `refactor-onam-perf-a` dev :3000(next-bun-fe, pid 82654, `.env` 링크) · 포트리스 프론트(:3000)는 사용자 승인으로 중지(bun-a6 확인 — 재기동 불필요) · 로그인 userId 43(저장 세션)
- 낚시 소켓 실서버(socket.io-client, 게스트 2명) 7/7: 정상 이동 20/초 40/40 전달 · 폭주 200건 → 40건 · 채팅 15건 → 10건 · 결과 정상 최대값(5자·200·30000) 통과·21자 거부 · 맵 이동 시 이전 맵 userLeft · 이동 후 이전 맵 미중계 · 200KB 메시지 → 연결 끊김
  - 참고: DTO 위반 응답이 `WS_ERROR "서버 내부 오류"`로 나간다 — 낚시 게이트웨이의 기존 동작(이번 변경 무관)
- A5 실 API: 팀 141(MEMBER) `GET invites` 403 `TEAM_INVITE_FORBIDDEN` · `POST telegram/link` 403 `TEAM_FORBIDDEN` "팀 리더 또는 매니저만 이 작업을 할 수 있습니다." · 팀 1(관리자) `GET invites` 200 · 상태·멤버·태스크 조회 200
- A8 실브라우저(데스크톱·모바일): `/users/me/skins` 응답의 잔액·nextCost만 route로 바꿔 확인 단계 진입(쓰기 요청 0) → Esc 1회: 확인 단계만 닫히고 시트 "스킨" 유지 · Esc 2회: 시트 닫힘 — 2/2 PASS
- 화면: 낚시(로그인+게스트) 이동·채팅 중계, 콘솔 오류 0 · 팀 보드(141)·태스크 상세(팀 1 #41) 렌더·로딩 해제, 콘솔 오류 0 — 6/6 PASS
- 스크립트·스크린샷: scratchpad `fishing-live.cjs`, `pw/perf-esc.cjs`, `pw/perf-ui.cjs`, `pw/perf-team-api.cjs`, `pw/shots/`
- 미검증: 3x 실기기 렌더링(DPR 상한), 운영 배포 후 화면

## 2026-11-16 — 운영 배포
- 백엔드: 의도별 6커밋(00b4cf9 infra · 81a6e48 common · e7235ae team · 0e564ba fortress · a7d9337 realtime · e044e56 docs) → #335 develop(머지 `4251497`) → #336 main(머지 `01afdf1`), 두 PR CI check·lint·e2e·docker-build 통과, Deploy NestJS run 43830888407 success
  - 운영 확인: `GET /teams` 401 · `GET /games/tetris/rankings` 200 · 낚시 소켓 `joinMap`·`leaveMap` ack 정상(wss)
- 프론트(next-bun-fe): 5커밋(3e44ce7 perf(bundle) · d401370 fix(tetris) · 66dd283 perf(games) · ce3535e fix(teams) · f211079 chore) → #413 develop(`3179c49`) → #414 main(`47288dd`), CI verify·verify-sim 통과, Deploy Next run 43832314484 success
  - 운영 확인: `/`·`/games`·`/games/tetris`·`/fishing`·`/teams` 200, 운영 `/` 청크 14개 중 react-colorful·DndContext 포함 0개
- 미검증: 로그인이 필요한 운영 화면
- 롤백: 백 `01afdf1`·프 `47288dd` revert(DB 변경 없음). 커밋이 의도별이라 개별 revert도 가능

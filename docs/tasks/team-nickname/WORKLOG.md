# 카카오 닉네임 수집 중단 · 팀 단위 닉네임 — 작업 기록

> 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 필요한 절만 읽는다.

## 2026-11-12 — 전수조사

### 로그인 경로 (백엔드, 메인 직접 확인)
- `src/modules/auth/auth.service.ts:103-108` `userSignUp`이 `kakaoNickname`을 `USER_NAME`에 저장, `:147` 신규 응답 `userName`도 카카오 닉네임
- `src/modules/auth/auth.dto.ts:8-11` `kakaoNickname?` optional · 전역 ValidationPipe `forbidNonWhitelisted` → 필드 제거 시 구 클라이언트 400
- 계정 닉네임 변경: `PUT /users/me` (`users.service.ts:40-55`, DTO `users.dto.ts:13-19` 1~20자) — 변경 없음
- `getDisplayName(userName, userId)` = `userName ?? 사용자{id}` (`src/common/utils/user.utils.ts`)

### 팀 컨텍스트 이름 노출 지점 (백엔드, 서브에이전트 조사 → 메인이 grep 원문 재확인)
이름 원천은 전부 `User.userName` 하나. DB 스냅샷 없음(엔티티 전수), 캐시는 Redis 온라인 해시뿐.

| # | 위치 | 이름 획득 | 나가는 곳 |
|---|---|---|---|
| 1 | team.service.ts:298,336 `getTeamTasksBy` | join `task.user` | GET 태스크 목록·상세 `userName` (`\|\| null`, 폴백 없음) |
| 2 | team.service.ts:905,914 `getCommentsByTaskId` | join `comment.user` | 태스크 상세 `comments[].userName` (시그니처에 teamId 없음, 호출처 :981에는 있음) |
| 3 | team.service.ts:1026,1049 `getTeamUsers` | tm⋈user raw | GET `:teamId/users` `userName` |
| 4 | team.service.ts:1466-1484 `updateMemberRole` | userRepository.findOne | HTTP 응답·WS `memberRoleChanged`·알림 subject |
| 5 | team.service.ts:1587-1606 `updateMemberStatus` | 동일 | HTTP·WS `memberStatusChanged`·알림 subject |
| 6 | team.controller.ts:491 `createTaskComment` | `@CurrentUser` | WS `commentCreated` (폴백 없음) |
| 7 | team.controller.ts:909 `notifyMemberJoined` | `@CurrentUser` + getDisplayName | WS `memberJoined` |
| 8 | team-chat.service.ts:140,158,252-258 `getMessages` | join `m.user` | HTTP 채팅 히스토리 |
| 9 | team.gateway.ts:339 `chatMessage` | `client.data.user.userName` (핸드셰이크 시 고정) | WS `chatReceived` |
| 10 | team-chat.service.ts:170-184 `getReadState` | ut⋈u | HTTP read-state `members[].userName` |
| 11 | team.gateway.ts:180-201 `joinTeam` | `client.data.user` | Redis 저장 + WS `userJoined` |
| 12 | online-user.service.ts:230,261 | Redis `team:{id}:online` 해시 | WS `onlineUsers` |
| 13 | team.gateway.ts:595-626 · online-user.service.ts:188,302-310 | Redis `socket:{id}` 해시 | WS `userLeft` |

- 이름이 없는 이벤트: task*·tag*·commentUpdated/Deleted(userId만). 팀 목록·초대 응답에도 이름 없음
- Redis 이름은 joinTeam 시점 값 → 닉네임 변경 시 갱신 필요. WS `client.data.user`도 연결 시점 고정
- 폴백 불일치(1·2·3·4·5·6은 null 그대로, 나머지는 getDisplayName) — 팀 해석 헬퍼로 통일 대상
- 팀 외부(계정 닉네임 유지): games.service.ts:845, fishing(gateway·events·online), tetris-lobby-chat.service.ts:54, feedback, users
- spec 영향: team.gateway.spec·online-user.service.spec·team.service.{role,member-status,task}.spec·team-chat.service.spec·team.mapper.spec, e2e team-gateway·team-access-control·team-chat·team-invitation, `entity.factory.ts` createTeamMember

### 프론트 (next-bun-fe 보고 요지)
- 로그인: `src/lib/auth.ts:77-80` next-auth Kakao profile `name`(카카오 nickname) → `kakaoNickname` 전송, `authService.ts:5,73` 필수 string 타입. 응답 `userName` → next-auth JWT(`auth.ts:92-95,134`). scope 지정 없음(카카오 콘솔 동의항목 따름)
- 팀 화면 이름 노출은 전부 `userName` 필드(약 15곳). 서버가 같은 필드에 팀 닉네임을 넣으면 표시부 수정 불필요
- `taskCreated` 핸들러(TeamBoard.tsx:248)는 멤버 목록 캐시로 이름 조회 → 닉네임 변경 이벤트 시 멤버 목록 갱신 필요
- 클라이언트 세션 이름을 팀 화면에 쓰는 곳 없음(채팅 낙관 렌더는 '나' 고정)
- 프론트 필요 작업: kakaoNickname 제거, 팀 닉네임 설정 UI·API 함수, `memberNicknameChanged` 수신 반영

### 미확인
- DB 통계(NULL 닉네임 수 등): worktree에 `.env`가 없어 `pnpm db:select` 미실행. 결정에 영향 없음(기존 데이터 무변경)

## 2026-11-12 — 백엔드 구현 (S1~S4)

### 변경 파일
| 영역 | 파일 | 내용 |
|---|---|---|
| 스키마 | `migrations/1793060509073-AddUserTeamsTeamNickname.ts` · `src/entities/TeamMember.ts` | `USER_TEAMS.TEAM_NICKNAME VARCHAR2(100 BYTE) NULL`, 멱등·down |
| 로그인 | `src/modules/auth/auth.service.ts` · `auth.dto.ts` | kakaoNickname 무시(DTO optional·deprecated 유지), 신규 가입 `generateRandomNickname()` 저장·응답 |
| 공통 | `src/common/utils/user.utils.ts` | `getTeamDisplayName`, `generateRandomNickname`(형용사20×동물20×4자리) |
| 해석 | `src/modules/team/team-display-name.service.ts`(신규) · `team.module.ts` | userId 목록 → 팀 안 표시 이름 1쿼리(User ⟕ USER_TEAMS on teamId) |
| 13지점 | `team.service.ts`(태스크·댓글·멤버 목록·역할·상태) · `team.controller.ts`(commentCreated·memberJoined) · `team-chat.service.ts`(히스토리·읽음 상태) · `team.gateway.ts`(joinTeam·chatMessage) · `online-user.service.ts`(updateUserName) | WORKLOG 전수조사 표 1~13 전부 전환 |
| 신규 API | `team.controller.ts` PUT/DELETE `:teamId/users/me/nickname` · `team.service.ts` `updateMyTeamNickname` · `team.dto.ts` · `team.events.ts` `memberNicknameChanged` | D-003 |
| 정리 | `team.service.ts` | 쓰지 않게 된 `User` repository 주입 제거(이름 조회가 해석 서비스로 이동) |

### 테스트
- 신규: `user.utils.spec.ts`, `team-display-name.service.spec.ts`(조인 조건·폴백·빈 목록), `team.service.nickname.spec.ts`(본인 행·403·멤버 목록 원값·태스크 팀별 해석), online-user `updateUserName` 3건, gateway joinTeam·chatMessage·notifyMemberNicknameChanged, comment 작성자 해석, e2e 닉네임 API 9건(403·trim·422·forbidNonWhitelisted·20자 경계·해제·알림 실패 시 200), auth unit·e2e(kakaoNickname 무시·랜덤 형식)
- 바뀐 단정: 팀 범위 이름 폴백 `null` → `사용자{id}`, 알림 제목 `사용자 2` → `사용자2`
- 수치 결과(2026-11-12): `pnpm ci:core` 통과 — lint 0 errors/경고 6(기준선 동일), 단위 1941/1941(85 스위트), build 통과. e2e `--testPathPatterns 'team-|auth'` 317 통과·58 skip·0 실패(sandbox 밖)
- 한계: Redis Lua(`HSET_IF_FIELD_EXISTS_SCRIPT`) 의미는 mock으로만 확인 — 로컬에 redis 없음. 실제 DB·API는 마이그레이션 실행 전이라 미검증

## 2026-11-12 — 백엔드 리뷰 루프 (메인 review-flow + Opus 독립 리뷰어)

| 라운드 | 메인(review-flow) | Opus | 조치 |
|---|---|---|---|
| R1 | 이슈 0 (13지점 grep 전수·raw 키 `tm_TEAM_NICKNAME` 관례 일치·Swagger) | 확정 0 / 추정 3(low) | 아래 #1~#3 |
| R2 | #2 수정분 확인 | 확정 0 / 추정 1(low, chatMessage) | #4 수정 |
| 종료 | 둘 다 확정 0, 추정은 전부 수정 또는 수용 결정 | | |

- #1 joinTeam(옛 이름 읽음) ↔ 닉네임 변경 경합으로 Redis 온라인 이름이 옛 값으로 남을 수 있음 → **수용**: 표시 이름만 잠깐 틀리고 DB·HTTP는 조회 시점 해석이라 정확, 다음 joinTeam에서 회복. 막으려면 분산 순서 보장이 필요해 비용 대비 이득 없음
- #2 댓글 저장 뒤 이름 조회 실패 → 500 → 재시도 시 댓글 중복 → **수정**: `team.controller.ts` `resolveNameAfterCommit`(실패 시 계정 닉네임). e2e 회귀 추가, 방어 제거 시 500으로 실패 확인
- #3 계정 닉네임 변경(`PUT /users/me`)은 팀 소켓·Redis에 실시간 반영 안 됨 → **후속**(기존 동작. HTTP 조회는 즉시 반영)
- #4 채팅 저장 뒤 이름 조회 실패 → chatReceived 미발송 → **수정**: `team.gateway.ts` 계정 닉네임으로 대체. 단위 회귀 추가, 방어 제거 시 실패 확인
- 역할·상태 변경의 "update 뒤 이름 조회"는 변경 전에도 같은 자리(재시도 시 400, 중복 없음) — 범위 밖
- 결과: `pnpm ci:core` lint 경고 6(기준선)·단위 1942/1942·build 통과, e2e team·auth 318 통과·58 skip

## 2026-11-12 — 설계 변경(D-004) 구현·리뷰 R3

- 구현: `team.service.ts` insertTeam·acceptTeamInvite(신규 복사, 재가입 유지·NULL만 복사)·`getAccountDisplayName`(같은 트랜잭션 manager), `updateMyTeamNickname` string 전용, `team.controller.ts` DELETE 제거, DTO·이벤트 teamNickname non-null(목록의 `TeamUserDto.teamNickname`만 nullable 유지 — NULL 행 가능), `migrations/1793060509074-BackfillUserTeamsTeamNickname.ts`
- 가입 경로 전수(Opus R3 확인): USER_TEAMS 행 생성·재활성화는 insertTeam·acceptTeamInvite(신규·재가입)·updateMemberStatus 0→1(행 이미 존재 — 복사 안 함, 의도)
- 마이그레이션 파일 작성 중 db-guard 훅이 heredoc 안 `UPDATE` 문자열로 Bash 명령 전체를 차단 → 파일은 Write 도구로 작성(실행 아님)
- 테스트: insertTeam 복사·NULL 계정 폴백, 초대 신규 복사·재가입 유지(patch에 키 없음 단정)·NULL 재가입 복사, DELETE e2e 제거
- 결과: `pnpm ci:core` 경고 6(기준선)·단위 1946/1946·build 통과, e2e team·auth 316 통과·58 skip
- R3(Opus): 확정 0 / 추정 1 — 롤링 업데이트 중 옛 레플리카가 처리한 가입은 TEAM_NICKNAME NULL(계정 닉네임을 계속 따라감, 앱은 정상). 관리자 재활성화는 NULL을 채우지 않음 → **배포 직후 조치**로 분류: 배포 완료 후 074의 UPDATE를 담당자가 한 번 더 실행(멱등)
- 참고(결함 아님): 백필된 레거시 계정 닉네임이 20자를 넘으면 설정 폼 초깃값 그대로 제출 시 422 — 프론트 클라이언트 검증 메시지로 안내
- 미확인: DB 길이 단위(NLS_LENGTH_SEMANTICS) — 기본 BYTE면 USER_NAME(100)과 같아 넘침 없음. DB 조회 금지로 확인 못 함

## 2026-11-12 — 프론트 구현 보고(next-bun-fe) 대조 · 바이트 상한

- 프론트 보고 요지: kakaoNickname 제거, `TeamUserResponse.teamNickname`, `updateMyTeamNickname`(PUT만), 소켓 `memberNicknameChanged` 직접 갱신(멤버·태스크 작성자·온라인·채팅 sender·읽음 명단·태스크 상세/댓글, 본인 이벤트 포함 — 다른 탭 동기화, 멱등), 편집기 = 팀 관리 섹션 멤버 탭의 내 카드, 마이페이지 안내 문구. ci:core 통과(1953 passed), 리뷰 2라운드 확정 0
- 계약 대조: PUT 경로·본문·응답·403/422·이벤트 페이로드 일치. DELETE 미구현 확인
- 프론트 질문 ① 길이 기준 → 백엔드 `@Length`는 validator.js isLength(UTF-16 길이 − 서로게이트 쌍 − 이형 선택자 시퀀스). 실측 😀×20=20(통과)·❤️×20=20(통과)·👨‍👩‍👧×5=25(거부). 프론트에 같은 식 이식 요청
- 그 과정에서 **결함 발견·수정**: 20자 통과 값이 UTF-8 최대 약 140바이트(❤️×20=120) → `VARCHAR2(100 BYTE)` 초과 ORA-12899 → 500. `team.dto.ts`에 `@IsByteLength(1, 100)`(422). e2e 케이스 추가, 방어 제거 시 200(테스트 실패) 확인. 같은 위험이 계정 닉네임 `PUT /users/me`(USERS.USER_NAME VARCHAR2(100), `@Length(1,20)`)에도 있음 — 기존 동작, 후속 등재
- 프론트 질문 ② 채팅 이력 userName = 조회 시점 팀 표시 이름(스냅샷 아님)
- 결과: ci:core 경고 6·단위 1946/1946 통과

## 2026-11-12 — 프론트 D-005 진입점 확대·공통화 (next-bun-fe 보고)

- 진입점 3곳, 모두 TeamBoard의 `useMyTeamNickname` 결과 하나(`myNickname`)를 받음: ① 팀 보드 헤더 칩(기본 화면 상시 노출, 대화상자) ② 온라인 유저 바텀시트의 "(나)" 항목 인라인 편집 ③ 팀 관리 > 멤버 탭 내 카드(유지). 채팅 패널 헤더는 산만해 제외
- 공통화: 로직 = 훅 `src/app/hooks/useMyTeamNickname.ts`(자격·초깃값·검증·PUT·응답 반영·토스트·연속 제출 가드), 화면 = `TeamNicknameEditor.tsx` 모듈(Form·InlineEditor·Chip). 옛 `handleSaveTeamNickname`·`onSaveTeamNickname` 0건, `updateMyTeamNickname` 호출은 훅 1곳
- 공용 `useDialog.ts` 1줄: `defaultPrevented`인 Esc는 닫지 않음(바텀시트 안 폼 Esc가 시트까지 닫던 확정 결함 조치). 사용처 19곳 영향 없음(리뷰어 전수)
- 검증: 프론트 ci:core 통과 — lint 0, 1971 passed/12 skipped, build 62/62. 회귀 테스트 4건 되돌림 시 실패 확인
- 리뷰(길이·바이트 보완 + 진입점 함께): R1 review-front 확정 1(위 Esc)·Opus 확정 0(PLAUSIBLE 전부 조치) → R2 둘 다 0
- 백엔드 계약 대조: 변경 없음(PUT·응답·403/422·memberNicknameChanged)
- 미검증(메인 Playwright 대상): 375px 칩 말줄임, 대화상자와 모바일 키보드 겹침, 바텀시트 안 Esc
- 범위 밖 제안(프론트 후속): `SkinUpgradePanel.tsx:99-103` 확인 단계 Esc가 설정 시트까지 닫을 가능성 — `preventDefault()` 1줄

## 2026-11-12 — 마이그레이션 실행(사용자) · 실API·Playwright 실측 · ci:all

- 마이그레이션: 사용자가 worktree에서 `pnpm db:migrate:up` 실행 — pending은 …073·…074 둘뿐이었고 둘 다 성공(이력 201·202). DB에는 포트리스 마이그레이션 3개가 먼저 적용돼 있었음(테이블 독립)
- `pnpm db:select` 확인: `TEAM_NICKNAME VARCHAR2(100) CHAR_USED=B NULLABLE=Y` · USER_TEAMS 19행 NULL 0 · 계정 닉네임과 불일치 0 · `NLS_LENGTH_SEMANTICS=BYTE`(이전 미확인 해소)
- 실행 환경: 포트리스 프론트(:3000)를 사용자 승인으로 일시 중지(bun-a6 통지) · 백엔드 worktree `EXPRESS_PORT=3510 pnpm dev`(운영 DB·로컬 Redis 6379) · 프론트 next-bun-fe가 :3000(API·소켓 → :3510) · 포트리스 백엔드 :3500 무접촉 · Playwright 1.61.1(scratchpad 설치, 레포 무변경) · 로그인은 사용자 카카오(userId 43) · 테스트 팀 141 `[테스트] 채팅 실측`(사용자 지정)
- 결과 **45/45 PASS** (스크립트·스크린샷: 세션 scratchpad `pw/verify.cjs`·`membertab.cjs`·`shots/`)
  - API: 백필값 `사용자43` · PUT trim 저장 · 422(빈값·공백·21자·❤️×20 실DB·추가 필드) · 비멤버 403 · 읽음 상태 이름 · 마이페이지 계정 닉네임 변경 후 팀141·팀121 팀 닉네임 불변(D-004) · Swagger PUT만·kakaoNickname deprecated · 무인증 401 · DELETE 404
  - UI: 헤더 칩 기본 노출·대화상자 포커스·Enter 저장 · 다른 탭 소켓 반영 · 바이트 초과 클라이언트 차단(PUT 0회) · Esc 닫힘·칩 포커스 복귀 · 온라인 시트 "(나)" 인라인 편집·Esc는 폼만 닫음·목록 이름 반영 · 새로고침 후 유지 · 새 접속 onlineUsers(Redis) 새 이름 · 375px 20자 이름 말줄임(칩 33~342px, scrollWidth 375) · 멤버 탭 저장 → 칩 동기화 · 콘솔 오류 0
  - 1차 실행 2건 429(전역 초당 스로틀, 연속 요청) → 간격 두고 재실행 PASS — 기능 결함 아님
  - 복구: 팀141 팀 닉네임·계정 닉네임 `사용자43`(계정은 원래 NULL → 문자열 `사용자43`, 표시 동일 — 사용자 사전 안내)
- 미검증: 신규 카카오 가입자 랜덤 닉네임 실가입(새 카카오 계정 필요 — 단위·e2e로 대체) · 다른 사용자 시점(계정 1개로 같은 유저 다른 탭만)
- 발견(기존 결함, 이번 변경 무관 — develop 동일, next-bun-fe 확인): ① 멤버 카드 "가입일: Invalid Date" — 프론트 `TeamManagementSection.tsx:379`가 `joinedAt`을 읽는데 `GET /teams/:teamId/users`에 `joinedAt` 없음 ② 팀 관리 탭 버튼 접근 가능한 이름이 인원수("2")뿐(aria-label 없음)
- `pnpm ci:all`(서버 종료 후): lint 경고 6(기준선) · 단위 1946/1946 · e2e 317 통과·58 skip · build 통과

## 2026-11-12 — D-006 가입일·탭 접근성 (사용자 직접 테스트용 서버 재기동 중)

- 서버: 포트리스 프론트(:3000) 사용자 승인으로 재중지(bun-a6 통지) → 백 :3510(이 worktree) · 프 :3000(next-bun-fe, API→3510)
- 백엔드: `getTeamUsers` select·매핑에 `tm.joinedAt`, `TeamUserDto.joinedAt`(nullable, date-time). 단위 회귀 1건(team.service.nickname.spec) — 팀 단위 384/384. 실응답 확인: 팀141 두 멤버 `joinedAt` ISO 값
- 프론트(next-bun-fe): `TeamUserResponse.joinedAt: Date | null`(`parseOptionalDate` — null·누락·해석 불가 → null), 카드 null이면 "-", 탭 `aria-label`("멤버 2"·"통계") + `aria-pressed`. lint 0·typecheck·1974 passed. 리뷰 1R 두 리뷰어 0. 회귀 3건 되돌림 시 실패 확인
- 메인 실화면(Playwright): 가입일 "2026년 10월 14일 / 15일", Invalid Date 없음, 탭 이름 "멤버 2"(pressed false)·"통계"(pressed true)
- 추가 지시(같은 의도): 탭 묶음 `role="group"`+aria-label, 접힌 헤더 요약 숫자 접근 가능한 이름 — next-bun-fe 진행 중
- 참고: 확인 스크립트가 프론트 기동 전 실패하며 Playwright 오류 로그에 로컬 로그인 쿠키가 도구 출력에 찍힘(외부 전송 없음) → 헬퍼가 auth.json에서 직접 읽고 출력하지 않도록 수정, 사용자에게 테스트 후 로그아웃 권고
- 접근성 추가 2건 완료(next-bun-fe): 탭 묶음 `role="group" aria-label="팀 관리 보기 전환"` · 접힌 헤더 요약 숫자는 sr-only "멤버 2", 아이콘 aria-hidden, 펼치면 요약 전체 aria-hidden(중복 낭독 방지) · 탭 `title`=aria-label 값으로 일치(공용 `tabAccessibleName`). lint 0·typecheck·1976 passed, 회귀 6건 되돌림 시 실패 확인, 리뷰 1R 두 리뷰어 0. 실제 스크린리더(VoiceOver/NVDA) 낭독은 미확인

## 2026-11-12 — D-007 UI 공간 정리 (next-bun-fe 구현 · 메인 Playwright 전후 확인)

- 프론트 변경: `TeamNicknameEditor.tsx`(폼 `layout: stacked|row`, 인라인 편집기를 행 편집기로 — 연필 44px·✓✕ 아이콘, 칩은 작은 알약 "내 이름 X ✎" 보이는 28px·히트 44px, aria-label "내 이름 X, 이 팀에서 내 이름 바꾸기"), `TeamBoard.tsx`(칩을 설명 줄 끝 flex-wrap으로), `OnlineUsers.tsx`(내 행 같은 줄 편집·시트 하단 pb-24 → safe-area+24px), `TeamManagementSection.tsx`(내 카드 이름 줄 끝 연필·버튼 전용 줄 제거, 접힌 요약에서 숫자 없는 아이콘 제거). 공통 훅 구조 유지. lint 0·typecheck·1977 passed, 리뷰 1R 두 리뷰어 0(제안 2 반영)
- 프론트 보고 높이(클래스 계산): 헤더 −56(설명 짧을 때)~−20 · 온라인 내 행 −52 · 시트 하단 약 −72 · 멤버 카드 약 −40 · 접힌 요약 모바일 2줄 → 1줄(일반 멤버)
- 메인 Playwright(after-check.cjs) **9/9**: 칩 대화상자 저장 · 시트 행 안 편집 Esc는 폼만 닫고 연필로 포커스 복귀 · 시트 저장 · 멤버 카드 편집 → 칩 동기화 · 375 긴 이름(20자) 칩 33~210px·h28·scrollWidth 375 · 콘솔 오류 0 · 복구
- 스크린샷 전/후(scratchpad `shots/before-*`·`after-*`): 데스크톱 헤더 칩이 설명 바로 아래 작은 알약으로 줄어 헤더 카드 높이 감소 · 모바일 온라인 내 행 "이름 … ✎ ● 온라인" 한 줄 · 접힌 "TEAM MANAGEMENT 👤2" 모바일 한 줄(일반 멤버 기준) · 멤버 카드 버튼 줄 제거
- 미확인: 관리자 계정의 접힌 요약 줄 수(초대 수 포함 시 2줄 가능, 테스트 계정은 팀141 MEMBER) · 실기기

## 2026-11-12 — 배포 준비 (사용자: 테스트 종료, "feature → develop → main 배포 진행")

- 서버 정리: 백엔드 :3510 종료(메인), 프론트 :3000 종료 요청(next-bun-fe), bun-a6에 :3000 반환 통지
- 백엔드 최종 `pnpm ci:all` exit 0 — lint 경고 6(기준선)·단위 1947/1947(85)·e2e 317 통과·58 skip·build
- 백엔드 커밋(원자): `83bf493` feat(auth) 카카오 닉네임 저장 중단·랜덤 닉네임 · `e29e643` feat(team) 팀 단위 닉네임 · `9184df5` fix(team) 멤버 목록 joinedAt · docs(team) 태스크 문서
- joinedAt 수정은 의도가 달라 별도 커밋 — 팀 닉네임 커밋 시점에 잠시 걷어내고 tsc·spec 통과 확인 후 복원

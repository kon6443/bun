# 사용자 피드백 — 작업 기록

> 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 절을 찾는다.

## 2026-10-21 — 착수: 브랜치·worktree · 백엔드 조사

### 브랜치 준비 (사용자 지시)
| 레포 | `main` vs `origin/main` | `origin/develop..origin/main` | 조치 |
|---|---|---|---|
| bun | 0/0 (`e295de5`) | 커밋 127개, 내용 diff 없음(머지 커밋만) | `git fetch . main:develop` (FF `472151f..e295de5`) → `worktree add -b feat-onam-feedback .claude/worktrees/feedback develop` |
| next-bun | 0/0 (`ae05efd`) | 커밋 172개, 내용 diff 없음 | FF `924669e..ae05efd` → 같은 방식 worktree |
- 원격 `develop` push는 하지 않았다(지시 범위 밖). 원래 작업 트리(`main` 체크아웃)·다른 worktree 변경 없음.
- next-bun 쓰기는 sandbox 쓰기 범위 밖이라 sandbox 해제로 실행.

### 백엔드 조사 근거
- 관리자 역할 없음: `src/entities/User.ts` — `USER_ID`·`USER_NAME`·`KAKAO_ID`·`IS_ACTIVATED`만, role 컬럼 없음 → Q1
- "me" 경로 관례: `src/modules/users/users.controller.ts:20` `@Get('me')` + `@UseGuards(JwtAuthGuard)` + `@CurrentUser()`
- 긴 본문 저장: `CLOB` 사용 — `src/entities/TaskComment.ts:29`·`TeamChatMessage.ts:24`·`TeamTask.ts:24`
- keyset 페이지 관례: `src/modules/team/team-chat.controller.ts:30` beforeId/afterId
- 스로틀 상수: `src/common/constants/throttle.constants.ts` (전역 초당 5·분당 60, 인증 초당 2·분당 10)
- 디스코드 발송: `src/modules/notification/discord.service.ts:46` `sendWebhookMessage(webhookUrl, …)` — 팀 단위 웹훅 저장 구조라 운영자용은 env 신설 필요 → Q1 (외부 알림 경로 변경 = Ask)
- 마이그레이션 위치: `migrations/`

## 2026-10-21 — 프론트 조사 결과 (`next-bun-8b`, 조사만, worktree feedback @ ae05efd)
- **BNB**: `src/app/components/BottomNavBar.tsx:57-77` 정적 4탭(홈·팀스페이스·낚시·마이페이지), 인라인 SVG 아이콘(:15·:24·:35·:48), 세션 미사용. 전역 마운트 `layout.tsx:90`. pill 폭 `min(520px, calc(100% - 1.5rem))`(css:6), 데스크톱도 같은 하단 pill — 사이드바 없음. 5탭이 한계, 375px에서 5글자 라벨 약 56px > 가용 약 49px(**CSS 계산 추정, 실측 아님**). 숨김 선례 `fishing/(game)/layout.tsx:20-23`.
- **비로그인**: 미들웨어 없음. 주류는 화면 안 로그인 카드 분기 — `mypage/page.tsx:75` `status === "authenticated" && !!session?.user?.accessToken`, `TeamsClient.tsx:29`. 로그인 진입은 `startKakaoLogin()`만(프론트 `.claude/rules/auth.md`). 조회 훅 `useAuthenticatedFetch.ts:53` 비로그인 시 호출 안 함.
- **마이페이지**: `src/app/mypage/page.tsx` 단일 파일(214줄), 세로 중앙 단일 카드(:81) — 목록 섹션은 레이아웃 개편 필요. 목록 선례 `TeamsClient.tsx:67-79`(Skeleton/Error/Empty/List 분기), 빈 상태 `teams/components/EmptyState.tsx:3-16`. 페이지네이션 공통 없음, 선례는 채팅 `TeamChatContext.tsx:403-423` `beforeId`/`hasMore`.
- **폼**: `teams/components/FormInput.tsx` `Input`(:17)·`TextArea`(:47), 폼 라이브러리 없음(useState + if 검증, 카운터 선례 `mypage :108`), 단일 선택 칩은 `TaskFilters.tsx:257-275` 마크업을 radiogroup으로, config 패턴 `config/taskStatusConfig.ts`. 토스트 react-hot-toast. 서비스는 `src/services/feedbackService.ts` 신설.
- **메타**: 앱 버전 `0.1.0` 고정 · 빌드 SHA는 CI(`oci_build_and_deploy_next.yml:90`)에만 있고 앱 미주입 · UA 수집 코드 없음 · `error.tsx:14` 리포트 전송 없음(`error.digest` 있음).
- **프론트 아이디어**: 에러 화면 신고 연계(소) · SHA 주입(소) · 제출 중복 방지 + 작성 중 sessionStorage 임시저장(소) · 마이페이지 개편 + 상태 배지(중) · 이미지 첨부(중~대) · 스크린샷 자동 캡처(대, 비권장) · 답변 도착 알림(중).
- → D-011

## 2026-10-21 — 마이그레이션 실행·스키마 확인 (S1·S1a)
- 파일: `migrations/1792553875000-CreateFeedbacks.ts` · `src/entities/Feedback.ts` · `database.config.ts` 등록. 메인 검증: build ✅ · lint 0 errors/경고 6(기준 6) · 마이그레이션 별도 tsconfig tsc ✅ · 단위 860/860
- worktree `.env`는 `../../../.env` 심볼릭 링크(백·프 모두), `ORACLE_WALLET_PATH`는 절대경로(따옴표 감쌈) — worktree에서 실행해도 경로 유효
- 사용자가 worktree에서 `pnpm db:migrate:up` 실행 → `CreateFeedbacks1792553875000 has been executed successfully`, 이력 7→8
- `pnpm db:select` 확인 (sandbox 안에서는 tsx IPC pipe `listen EPERM` → sandbox 해제로 실행):
  - 컬럼 13개 타입·길이·NULL·기본값이 DESIGN §1 표와 일치 (`STATUS` 기본 `'RECEIVED'`, `CRTD_AT` 기본 `CURRENT_TIMESTAMP`, PK IDENTITY 시퀀스)
  - 제약 `PK_FEEDBACKS` · `FEEDBACKS_CATEGORY_CK` · `FEEDBACKS_STATUS_CK` · `FK_FEEDBACKS_USER`(DELETE_RULE `CASCADE`) 모두 ENABLED
  - 인덱스 `IDX_FEEDBACKS_USER_ID (USER_ID, FEEDBACK_ID)` + PK
  - 테이블 코멘트 1 · 컬럼 코멘트 13/13(누락 0) · 행 0

## 2026-10-21 — 백엔드 구현 (S2·S3)
- 신규: `src/modules/feedback/`(controller·service·dto·error.dto·module·service.spec) · `test/feedback.e2e-spec.ts` · factory `createFeedback`
- 수정: `notification.port.ts`(`notifyFeedbackChannel`) · `notification.adapter.ts`(ConfigService env 2개, `.catch` 로그) · `notification.format.ts`(머리줄 분리 → `renderFeedback*`) · `app.constants.ts`(`FEEDBACK_*`) · `throttle.constants.ts`(`THROTTLE_FEEDBACK_*`) · `app.module.ts`(FeedbackModule) · README(모듈·테이블·env)
- 검증(메인): lint 0 errors/경고 6(기준 6) · `check:stubs` ✅ · 단위 39 스위트 878/878(+18: service 12, adapter 4, format 2) · E2E 131 통과·2 skip(Redis)(+14 feedback, sandbox 밖) · build ✅
- grep: `renderTelegramHtml`·`renderDiscordMarkdown` 호출처는 adapter뿐(출력 불변 — 기존 spec 통과), `INotificationPort` 구현체는 `NotificationAdapter` 하나, mock들은 `useValue`라 영향 없음
- E2E에서 고친 것: 401 케이스가 `boot(authUser = AUTHOR)` 기본값 때문에 undefined가 AUTHOR로 바뀌어 201 — 기본값 제거
- 미검증: 실제 Oracle INSERT·조회(실DB), 디스코드·텔레그램 실수신, 라우트 스로틀 실동작(E2E는 스로틀 가드 미조립)

## 2026-10-21 — 리뷰 루프 (백엔드 3라운드 · 프론트 2라운드)
- 방식: 백엔드 = 메인 `review-flow` + Opus 5.5 서브에이전트(라운드마다 새로) → 메인 교차검증(재현) → 확정만 수정. 프론트 = `next-bun-8b`가 프로젝트 review-flow + Opus 서브에이전트 교차검증
- **BE R1** (확정 4)
  | 지적 | 출처 | 교차검증 | 조치 |
  |---|---|---|---|
  | `FeedbackModule`에 User Repository 없음 → `JwtAuthGuard` DI 실패, 부팅 불가 | 메인(`pnpm dev` 부팅) | 부팅 로그 `UnknownDependenciesException` | `forFeature([Feedback, User])` + `feedback.module.spec.ts`(제거 시 같은 예외로 실패 확인) · lessons 2026-10-21 |
  | `@MaxLength`가 바이트 상한을 보장 못함 — `'❤️'×100` 제목 600바이트 → ORA-12899 500 | Opus | `pnpm db:select` NLS `AL32UTF8`·`BYTE` + node 재현(MaxLength 통과·600바이트) | `@MaxByteLength`(`common/decorators`) — TITLE 400·PAGE_PATH 2000 + spec·E2E |
  | 429 `@ApiResponse` 2개 중 하나가 덮어써짐 | Opus | swagger 상태코드 키 병합 | 한 항목에 두 코드 기술 |
  | 알림 `화면:` 줄 500자 이스케이프 시 디스코드 2000자 초과 → 유실 | Opus | 최악 길이 계산 | 알림 줄 100자 절단 + spec |
- **BE R2**: 확정 결함 0, 테스트 공백 1(PAGE_PATH 바이트 상한을 고정하는 테스트 없음) → E2E `/'❤️'×499` 422 추가, 데코레이터 제거 시 실패 확인. 최악 길이 실측: 디스코드 1706/2000, 텔레그램 3169/4096
- **BE R3**: 확정 결함 0 → 종료
- **FE (next-bun-8b 보고)**: R1 확정 4(BNB `.item` `min-width:0`, 버려진 "더 보기" 실패 토스트, 상세 404 안내, 422 테스트 누락) + 정리 2 → R2 확정 0. typecheck 0 · lint 0 · test 378/378. build는 메인이 sandbox 밖에서 ✅
- 최종(BE): lint 0 errors/경고 6 · stubs ✅ · 단위 885/885 · E2E feedback 16/16(전체 sandbox 밖) · build ✅

## 2026-10-21 — S5 실API·Playwright (로컬 dev = 운영 DB)
- 서버: 사용자 승인으로 3500(team-tags BE)·3000(tag-edit-mobile FE) 기존 dev 서버 종료 후 feedback worktree에서 `pnpm dev`(BE) · `NEXT_PUBLIC_BUILD_SHA=e2e1234 pnpm dev`(FE). 로컬 Redis `NOAUTH`(기존 환경 문제, 스로틀은 인메모리 폴백)
- 도구: scratchpad `e2e/`에 playwright 1.56.1(레포 의존성 아님) + 시스템 Chrome, 사용자 카카오 로그인 후 자동 진행. 토큰은 출력·저장하지 않음
- **API 15/15**: 201·trim·응답 필드(userAgent·buildSha 없음)·createdAt UTC · `'❤️'×100` 422 · 정의 외 필드 422 · 분당 3회 초과 429 `TOO_MANY_REQUESTS`(실제 스로틀 동작) · 목록 최신순·content 없음·beforeId 미포함 · 상세 200 · 없는 ID 404 · limit 51 422 · 비로그인 401
- **UI 18/18**: BNB 5탭 375px(라벨 잘림 없음·폭 균등·가로 스크롤 없음)·320px · 마이페이지 "내 피드백" 링크 · BNB 탭 → `/feedback?from=/mypage` · 라벨 클릭으로 카테고리 선택 · 제출 201(바디 BUG·pagePath·buildSha, userAgent 없음) · 토스트 → `/feedback/me` · 목록 카드(버그 리포트·접수) · 상세(본문 `pre-wrap`, "아직 답변이 없어요", GET 1회) · 없는 ID 안내 · 피드백 화면 안 탭은 from 없음 · 비로그인 로그인 카드 2화면 + 탭 노출
  - 스크립트 실패 3건은 모두 스크립트 원인으로 확인: sr-only radio 직접 클릭(라벨 클릭으로), 부분 스크롤 상태에서 고정 BNB가 버튼을 덮음(끝까지 스크롤 시 812·667px 모두 버튼이 BNB 위 — 결함 아님), 상세 스켈레톤 중 텍스트 캡처(내용 대기로)
- DB(`pnpm db:select`): 행 2개(ID 1 OTHER·ID 2 BUG) — trim·PAGE_PATH·USER_AGENT(헤더/브라우저)·BUILD_SHA `e2e1234`·CRTD_AT UTC 정상. BE 로그 ORA-·QueryFailedError·500·알림 오류 0건
- 미검증: 디스코드·텔레그램 **실수신**(발송 오류 로그 0 — 사용자 확인 필요), 24시간 20건 상한 실동작(단위·E2E로만), Docker 빌드의 SHA 주입(배포 후 새 행 BUILD_SHA로 확인), Redis 멀티 레플리카 스로틀 공유
- 테스트 행: `FEEDBACKS` ID 1·2 (`[E2E]` 접두어) — 삭제는 사용자 SQL

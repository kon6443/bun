# 팀 태스크 태그 — 작업 기록

> append-only. 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 목차를 본다.

## 2026-10-19 — 백엔드 현황 조사 (메인 bun-f5)

| 항목 | 위치 | 태그 설계에 미치는 영향 |
|---|---|---|
| 태스크 Entity | `src/entities/TeamTask.ts` — `TASK_ID` PK, `TEAM_ID`, 태그 관련 컬럼 없음 | 기존 테이블 변경 없이 연결 테이블로 붙인다 (D-003) |
| 태스크 라우트 | `team.controller.ts:230-372` — `GET/POST :teamId/tasks`, `GET/PATCH :teamId/tasks/:taskId` | 태그 라우트도 같은 컨트롤러·`JwtAuthGuard`·`verifyTeamMemberAccess` 패턴 |
| 생성·수정 DTO | `team.dto.ts:62-110` `CreateTeamTaskDto`·`UpdateTeamTaskDto` | `tagIds?: number[]` 추가 지점. 전역 ValidationPipe가 `forbidNonWhitelisted`라 구 백엔드에 `tagIds`를 보내면 400 → 배포 순서 백엔드 먼저 |
| 생성·수정 서비스 | `team.service.ts:362-454` — 단건 `save`, 트랜잭션 없음 | 연결 교체가 붙으면 `dataSource.transaction` 콜백으로 감싼다 |
| 목록·상세 조회 | `getTeamTasksBy`(`team.service.ts:221`)를 목록(`:785`)·상세(`:886`)·상태 변경 알림(`:651`)이 공유 | 알림 경로 오염 방지 — `tags`는 응답 경로에서만 별도 쿼리로 부착 (D-005) |
| 멤버 권한 | `verifyTeamMemberAccess`(`team.service.ts:730`) — 활성 팀·활성 멤버 | 태그 API 권한 그대로 재사용 |
| 소켓 | `team.events.ts:19-27` 태스크 이벤트 5종, `TaskCreatedPayload`·`TaskUpdatedPayload`(`:78-104`) | 태그 이벤트 추가 + 태스크 페이로드에 `tags` (D-006) |
| 마이그레이션 형식 | `migrations/1791960323000-CreateTeamChatReadCursors.ts` — PL/SQL 존재 확인 멱등, `COMMENT ON`, `down()` DROP PURGE | 새 2파일이 같은 형식 |

## 2026-10-19 — 프론트 현황 조사 (next-bun-6c 보고, 읽기 전용)

| 항목 | 위치 | 비고 |
|---|---|---|
| 팀 보드 | `src/app/teams/[teamId]/TeamBoard.tsx`(1107줄). 헤더 `:926-967`, 버튼 줄 `:945-965` = [채팅][새 카드][DropdownMenu] | 입구: DropdownMenu items(`:959-963`)에 "태그 관리". 모달 렌더 패턴 `:1070-1090` |
| 태스크 폼 | `src/app/teams/components/TaskForm.tsx` — `TaskFormData` `:9-16`, `initialData` 마운트 시 1회(`:31`) | 생성·수정 공용 |
| 생성 | `tasks/new/page.tsx:35-70`, 바디 `:50-58` → 성공 시 보드로 이동 | |
| 수정 | `tasks/[taskId]/TaskDetailPage.tsx` `handleUpdateTask` `:346-372`(바디 `:353-361`), 인라인 폼 `:567-580` | 모달 아님 |
| API·타입 | `src/services/teamService.ts` getTeamTasks `:452`·createTask `:477`·updateTask `:503`, 타입 `:95/:143/:185/:198`; 도메인 타입 `src/app/types/task.ts` | 응답·도메인 타입 이중 정의 — 둘 다 `tags` 추가 |
| 카드 표시 | `TaskCard.tsx`(Kanban `:245`만 사용, 제목 `:116`), `ListView.tsx:182-187`, `CalendarView.tsx`, `GanttChart.tsx`, 상세 헤더 `:588` 근처 | D-011 |
| 기존 컴포넌트 | 공통 모달 래퍼 없음(`useDialog` 훅만), `DropdownMenu`·`StatusDropdown`·`CountBadge`. 칩·멀티셀렉트·피커 없음 | |
| 상태관리 | react-query/SWR/zustand 없음. 보드 `useState` + `fetchAndSetTasks`(`:219`) + 소켓 패치 | 팀 태그는 layout Context 또는 `useTeamTags` 훅 |
| 소켓 | `src/types/socket.ts:5-44`, `useTeamSocketEvents.ts:145-172`, 소비 TeamBoard `:461`·TaskDetail `:235`. `taskUpdated`는 필드별 undefined 체크 머지 | `tags` 전체 배열 포함이면 머지 1줄 |
| 의존성 | next·next-auth·react·react-hot-toast·socket.io-client뿐, 색상 라이브러리 없음. TS lib.dom에 `EyeDropper` 타입 없음 | D-010 |
| 디자인 | Tailwind v4, 다크 전용(`#020617`), slate 하드코딩. 규칙: backdrop-blur 금지·터치 44px·375px 기준 | D-011 |
| 계약 주의 | 프론트 `.claude/rules/services.md` — DTO에 없는 필드를 보내면 검증 실패 | 배포 순서 백엔드 먼저 |

## 2026-10-19 — 프론트 착수 전 사전 점검 (next-bun-6c 보고, 구현 없음)

**태그 필터(D-015)** — 비용 낮음. `useTaskFilter.ts` `TaskFilterState`(`:14-19`) → `applyAllFilters`(`taskUtils.ts:234`)의 `filterBy*` 체인에 `filterByTags` 추가(빈 배열 통과, 아니면 `some`). UI는 `TaskFilters.tsx`(사용처 `TeamBoard.tsx:1005` 1곳). `hasActiveFilters`(`useTaskFilter.ts:96`)에 조건 추가.

| 함정 | 위치 | 조치(프론트 제안, 메인 승인) |
|---|---|---|
| 보드 상태 복원이 필드 하나만 어긋나도 필터 전체를 버림 | `boardStateStorage.ts` `BoardFilters`(`:14`)·`parseFilters`(`:75`) | `tagIds` 없으면 `[]`로 관대 파싱 + `boardStateStorage.test.ts` 회귀 테스트 — 배포 직후 기존 sessionStorage 필터 유실 방지 |
| 복원된 `tagIds`에 그사이 삭제된 태그 | 같은 곳 | 태그 목록 로드 후 없는 id 제거 — 빈 보드 고착 방지 |
| `applyAllFilters` 기존 테스트가 5인자 호출 | `taskUtils.deadline.test.ts:141-155` | 6번째 인자 `tagIds = []` 선택 인자 |

**react-colorful(D-013)** — registry 조회: 최신 5.8.1(2026-09-01), dependencies 없음, peer `react`/`react-dom` `>=16.8.0`(React 19 범위 내). 실제 peer 경고는 `pnpm add` 시 재확인.
- 환경 메모: 이 머신 `~/.npm` 캐시에 root 소유 파일이 있어 `npm view`가 EPERM(메인 세션도 같은 증상). `pnpm add`는 pnpm store를 써서 영향 없을 가능성이 높음. 실패 시 사용자 `sudo chown` 필요.

## 2026-10-19 — 드래그 정렬 사전 의견 (next-bun-6c)
- teams 영역에 드래그·터치 코드 0건(fishing/GameCanvas만) — 재사용 기반 없음.
- `@dnd-kit/core` 6.3.1 + `@dnd-kit/sortable` 10.0.0(utilities 3.2.2 동반), peer `react >=16.8`, 전이 의존성 tslib·`@dnd-kit/accessibility`뿐.
- 구현 계획: 핸들(⋮⋮)에만 리스너 + `touch-action:none`, `TouchSensor` `{ delay: 200, tolerance: 5 }`, `KeyboardSensor` + `sortableKeyboardCoordinates`, 한국어 announcements. 약 80~120줄. ↑↓ 버튼은 키보드 대안이 있어 생략.
- 드래그 중 `tagsReordered` 수신 시 드롭 후 반영. 409 → 롤백 + 재조회 + 토스트.

## 2026-10-19 — S1 스키마 파일 작성 (메인)
- 파일: `migrations/1792396800000-*` · `migrations/1792396801000-*` · `src/entities/TeamTag.ts` · `src/entities/TeamTaskTag.ts` · `src/config/database.config.ts`(entities 등록).
- 객체 이름은 기존 관례(`IDX_`·`UK_`·`<TABLE>_<COL>_CK`)에 맞춰 DESIGN.md 초안의 `UX_`·`IX_`·`CK_`를 바꿨다.
- CHECK 정규식은 `EXECUTE IMMEDIATE` 문자열 안이라 작은따옴표를 두 번 쓴다.
- 검증: `pnpm build` ✅ · `pnpm lint` 0 errors / 경고 6(README 기준선 7, 신규 파일 0건). 마이그레이션 파일은 `tsconfig` include(`src/**`) 밖이라 build가 타입체크하지 않는다 — 별도 `tsc`는 db-guard 훅이 DDL 문자열을 보고 차단(오탐, 우회하지 않음) → 정적 리뷰로 대체.
- 환경 메모: worktree `pnpm install`을 sandbox 안에서 돌리면 pnpm이 홈 store 대신 **원래 저장소 루트에 `bun/.pnpm-store/`를 만들고** `.vscode/settings.json` 쓰기 EPERM으로 실패한다 → sandbox 밖에서 설치(전역 store `~/Library/pnpm/store/v10`). 남은 `bun/.pnpm-store/`(untracked)는 삭제 승인 대기.
- (추가) 담당자가 worktree에서 `db:migrate:up` 완료 보고. 사용자가 확인 SELECT를 AI에게 요청했으나 CLAUDE.md Never(DB 접속 명령 — LOCAL=PROD) 우선으로 담당자 실행을 다시 요청. `bun/.pnpm-store/`(322M)는 사용자 승인 후 삭제.
- (추가) 프론트 worktree 의존성: next-bun-6c가 sandbox store 문제로 정지 → 메인이 sandbox 밖에서 `pnpm install --frozen-lockfile` + `pnpm add react-colorful @dnd-kit/core @dnd-kit/sortable` 실행. 결과 `@dnd-kit/core 6.3.1`·`@dnd-kit/sortable 10.0.0`·`react-colorful 5.8.1`, peer 경고 없음(기존 eslint deprecated 1건). D-013·D-020 설치 확인 조건 충족. 원래 next-bun 트리의 `.pnpm-store/`(13:21 생성, gitignore)는 이 작업 이전 것이라 그대로 둠.
- (추가) 스키마 확인 — 메인이 쓴 읽기 전용 스크립트(세션 scratchpad `check-tag-schema.ts`)를 담당자가 `!`로 실행. 결과: 테이블 코멘트 2/2, 컬럼 코멘트 11/11(원문 일치), 컬럼 11(타입·길이·NULL 허용이 DESIGN과 일치 — `CRTD_BY`·`MDFD_AT`만 Y), 인덱스 5(`PK_TEAM_TAGS`·`UK_TEAM_TAGS_TEAM_NAME` UNIQUE, `IDX_TEAM_TAGS_TEAM_SORT`, `PK_TEAM_TASK_TAGS`, `IDX_TEAM_TASK_TAGS_TAG`), 제약 7(FK 3개 CASCADE·`FK_TEAM_TAGS_USER` SET NULL·`TEAM_TAGS_COLOR_CK` 정규식 정상). 마지막 이력 조회는 스크립트 결함(ORA-00904 — `TYPEORM_MIGRATIONS` 컬럼은 따옴표 소문자 `"name"`)으로 실패, 스크립트 수정. 테이블이 존재하므로 적용은 확인된 것으로 판정.

## 2026-10-19 — 백엔드 S2·S3 구현 (메인 포크 구현 → 메인 재검증)
- 신규: `team-tag.controller.ts`·`team-tag.service.ts`·`team-tag.dto.ts`·`task-tags.ts`·`team-tag.service.spec.ts`·`test/team-tag.e2e-spec.ts`. 수정: `team.service.ts`·`team.controller.ts`·`team.dto.ts`·`team-error.dto.ts`·`team.events.ts`·`team.gateway.ts`·`team.module.ts`·`app.constants.ts`·`entity.factory.ts`·`team.service.task.spec.ts`·`team.gateway.spec.ts`·`test/team-access-control.e2e-spec.ts`.
- 메인 수정 1건: `TEAM_TAG_LIMIT_EXCEEDED` 메시지를 상수에서 생성(D-021).
- 메인 재검증(sandbox 밖): `pnpm build` ✅ · `pnpm lint` 0 errors / 경고 6(기준 7) · `pnpm test` 37 스위트 803/803 · `pnpm test:e2e` 113 통과 / 2 skip(redis). grep: `emitTaskCreated`·`emitTaskUpdated`·`createTask`·`updateTask` 반환 사용처는 컨트롤러 2곳 + spec뿐(포크 보고).
- **미검증(실제 Oracle)** — 단위·E2E 모두 mock DB: ① 연결 조회 `find` + relation `order`(태그 SORT_ORDER 순) ② 사용 수 집계 `getRawMany`의 `"tagId"`·`"taskCount"` 별칭 대소문자 ③ `UPPER(tag.tagName)` 조건의 컬럼명 치환. → 앱을 띄워 로그인 상태로 태그 CRUD·태스크 태그 부착을 한 번 돌려 확인(S6).

## 2026-10-19 — 프론트 S4·S5·S5a 구현 (next-bun-6c → 메인 재검증)
- 신규 7: `utils/tagUtils.ts`(+test — 한도·trim/대소문자 비교·HEX 정규화·WCAG 대비 4.5 미만이면 slate-100 글자·`filterByTags` OR·`applyTagOrder`), `contexts/TeamTagsContext.tsx`(layout Provider, 재연결 시 재조회, 소켓 4종 반영·본인 이벤트 제외, 재정렬 낙관적 반영 + 실패 롤백), `components/TagChip.tsx`(팀 태그 목록 기준으로 순서·이름·색 해석, 삭제 태그 숨김 → 태그 변경 때 태스크 state 수정 불필요), `TagModal.tsx`(manage/select, body portal, IME 조합 중 Enter 무시, 동명 태그는 선택만, 바뀐 필드만 PATCH, 삭제 ConfirmModal에 taskCount, @dnd-kit Mouse 4px/Touch 200ms·5px/Keyboard, 검색 중 정렬 비활성, 드래그 중 순서 고정, 409 토스트), `TagColorPicker.tsx`, `TaskTagField.tsx`(삭제된 태그 ID 자동 제거).
- 수정 23: 타입·서비스·소켓 훅, TaskCard 3+N·ListView 2+N·TaskDetailPage 전체, 생성/수정 폼 `tagIds`, TeamBoard 메뉴 "태그 관리"·필터 연결·없는 태그 ID 필터 제거, `useTaskFilter`·`applyAllFilters` 6번째 선택 인자·`boardStateStorage` 관대 파싱, `TaskFilters` 태그 토글. `@dnd-kit/utilities`는 미사용.
- 메인 재검증(sandbox 밖): lint 신규 경고 0(기준 5) · typecheck 0 · `test:run` 25파일 295/295(기준 278 +17) · `build` 성공(36/36). 계약 대조: REST 5경로·메서드·바디, 소켓 4종 필드 일치(`teamService.ts:1135-1250`, `types/socket.ts:110-135`). 원래 next-bun 트리 무변경.
- 결정: 같은 사용자 다른 탭 실시간 미반영은 기존 태스크 이벤트와 같은 한계로 유지. 배포 순서 어긋남 대비 `tags ?? []` 경계 정규화 1곳 요청.
- 미검증: 실제 API·소켓, 2탭 실시간, iOS 실기기 터치 드래그.

## 2026-10-19 — 멀티 레플리카 점검 · 토스트 정비 · 태그 알림 (D-022)
- **멀티 레플리카(사용자 질문)**: REST는 무상태 — 태그 서비스·`task-tags.ts`에 인스턴스 필드 상태 없음(`new Map`은 함수 지역 변수뿐). 소켓 emit은 `this.server.to(room)` → `src/common/adapters/redis-io.adapter.ts`의 Redis 어댑터로 레플리카 간 전파(기존 태스크 이벤트와 동일 경로). 한도·중복은 DB가 최종 방어(유니크 인덱스) — 레플리카 수와 무관.
- **토스트(next-bun-6c, `TagModal.tsx`만 수정)**: 내 조작 실패는 서버 message 토스트(네트워크 오류는 "네트워크 연결을 확인해주세요."), 클라이언트 사전 검증은 인라인만(중복 표시 없음). 성공 토스트: manage 생성·수정·삭제. select 즉석 생성은 생략(선택 상태로 즉시 보임·연속 입력 방해). 재정렬 성공 없음, 409 기존 문구. 다른 팀원 태그 소켓은 토스트 없음. 폼 저장 실패는 기존 페이지 ErrorAlert 관례 유지.
- **알림(D-022)**: `team.service.ts` `taskTagLines` 추가 — 생성 `🏷️ …`, 수정 시 현재 태그 + `➕ 추가`/`➖ 제거`(모두 빠지면 `🏷️ 태그 없음`). 교체 전 태그는 같은 트랜잭션에서 조회. spec 4건 추가.
- 검증: 백엔드 build ✅ · lint 0 errors/경고 6 · 단위 807/807 · E2E 113 통과(2 skip). 프론트 test:run 296/296 · typecheck 0 · build ✅(메인 sandbox 밖).
- 미검증: 실제 텔레그램·디스코드 수신 화면(로컬에서 연동된 팀으로 태스크 태그 수정 1회 필요).

## 2026-10-19 — 리뷰 루프 1라운드 (Opus 5.5 리뷰어 2: 프로젝트 review-flow · 글로벌 review → 교차검증 1)
- 종료 조건: 한 라운드에서 교차검증 확정 결함 0건. nit는 수정 또는 후속 기록.
- 확정: C1 medium(FE, 같은 사용자 다른 탭에서 만든 태그가 수정 저장 시 조용히 제거 — 데이터 유실) · C2 low(BE, 동시 태그 교체 PK 위반·삭제 경합 FK 위반이 500) · C3 info(FE 태그 응답 타입 `taskCount` 누락) · C4 low(BE, 상태 변경 Swagger 응답이 `tags` 필수로 명세) · C5 low(BE E2E: PATCH tagIds·성공 경로 tags·emit 페이로드 미검증) · C6 low(FE Context·TaskTagField 테스트 없음). nit: STATUS 400/422 표기(수정), FE 주석(수정 요청), 빈 PATCH도 `tagUpdated` emit(후속).
- BE 조치:
  - C2: `updateTask` 트랜잭션 첫 단계에서 태스크 행 `SELECT … FOR UPDATE`. **`findOne`+lock은 쓰지 않는다** — TypeORM 0.3.28 `findOne`이 `take: 1`을 넣고 Oracle 분기가 `FETCH NEXT 1 ROWS ONLY`를 붙이는데(`SelectQueryBuilder.js` limit 표현식), Oracle은 row-limiting 절과 FOR UPDATE를 함께 쓸 수 없다(ORA-02014). → `createQueryBuilder().setLock('pessimistic_write').getMany()`. `replaceTaskTags`는 ORA-02291을 `TEAM_TASK_BAD_REQUEST`(400)로 변환.
  - C4: `TeamTaskWithoutTagsDto`(`OmitType`)·`UpdateTaskStatusResponseDto`를 상태·활성 상태 라우트에 적용.
  - C5: `team-access-control.e2e-spec.ts`에 POST·PATCH 성공 시 `data.tags`·emit 페이로드, PATCH 422 2건.
  - 검증: build ✅ · lint 0 errors/경고 6 · 단위 809/809 · E2E 117 통과(2 skip). **FOR UPDATE의 실제 Oracle 동작은 미검증**(SQL 생성 경로는 TypeORM 소스로 확인).
- FE 조치(next-bun-6c에 지시): 태그 소켓 4종 본인 이벤트도 적용(멱등), `TaskTagField` 마운트 시 refresh 후에만 정리, 태그 응답 타입 `TeamTag`, Context·TaskTagField 테스트 3건, 주석 정정.

## 2026-10-19 — 리뷰 루프 2라운드
- 리뷰어 2(Opus 5.5) 모두 1라운드 C1~C6 조치 확인. 교차검증 확정: R1 low(BE 동시 재정렬 — 잠금 없는 기준선 읽기 + "바뀐 행만 UPDATE"로 두 의도 혼합·sortOrder 중복) · R2 low(FE refresh 진행 중 생성 → 늦은 GET이 새 태그를 덮어 TaskTagField가 선택 해제). 반증: "잠금·FK 회귀 테스트 없음"(이미 `team.service.task.spec.ts` 잠금·FK 케이스 존재). 후속: 태스크 생성 화면 직접 진입 시 GET /tags 2회(기능 영향 없음), updateTask↔deleteTag 교착(ORA-00060) 추정(미재현).
- BE 조치(R1): `reorderTags` 기준선을 `createQueryBuilder(TeamTag).setLock('pessimistic_write').where(teamId).getMany()`로 — 잠근 뒤 읽어 앞 요청 커밋 결과가 기준선. spec 잠금 단정 1건, spec·E2E mock을 `manager.find` → 잠금 QueryBuilder로 교체.
- 검증: build ✅ · lint 0 errors/경고 6 · 단위 810/810 · E2E 117 통과(2 skip).
- FE 조치(R2 + 연속 드롭 동시 PUT) next-bun-6c에 지시: mutation 성공 시 `fetchSeqRef++`·`isLoading=false`, 재정렬 진행 중 드래그 비활성, 테스트 2건.

## 2026-10-19 — 리뷰 루프 3라운드
- 리뷰어 2 모두 2라운드 조치 확인, BE 확정 결함 0(잠금 순서 추적: reorder는 TEAM_TAGS만, updateTask는 TEAM_TASKS→자기 연결만 — 새 순환 없음, 코드 추적·미실측).
- 교차검증 확정(FE, low 2): D1 — `supersedeFetch`가 새 조회 없이 isLoading을 꺼 `refresh`가 결과를 버리고도 true → TaskTagField가 오래된 목록으로 정리(C1 계열). F1 — 소켓 태그 핸들러가 seq를 안 올려 진행 중 PUT/GET 응답이 소켓 반영(생성·삭제·수정)을 덮어씀. refresh 경로도 동일.
- 땜질 반복 대신 **일관 규칙**(사용자 승인 "그 규칙대로 진행"): ① 목록을 바꾸는 모든 반영(mutation 응답·소켓 4종)이 seq를 올려 이전에 시작된 읽기를 무효화 ② refresh는 반영된 조회 완료 때만 true, 무효화 시 재조회(최대 3회), in-flight promise 공유로 중복 GET 없음, isLoading은 "반영 대기 중"이고 무효화가 끄지 않음 ③ TaskTagField는 true 이후에만 정리, false면 정리 안 함. 테스트 7종(뮤테이션 확인 포함) next-bun-6c에 지시.
- (3라운드 추가) 정정된 한계: 폼이 마운트 전 시작된 GET에 합류하면 그 스냅샷 기준으로 정리될 수 있음 → `refresh({ fresh: true })`(진행 중 조회에 합류하지 않고 끝난 뒤 새로 읽음)를 TaskTagField에만 적용. FE 309/309 · build ✅.

## 2026-10-19 — 리뷰 루프 4라운드
- 리뷰어 2 모두 3라운드 규칙 구현 확인, Ripple(소비자 전수: TeamBoard 필터 정리·TagChip·TagModal·TaskFilters·소켓 훅)·무한 루프 없음, BE 확정 결함 0. 후속 "생성 화면 GET 2회"는 현재 구조에서 운영 1회(dev StrictMode만 2회)로 해소.
- 교차검증 확정(FE, low 2): D-1 낙관 재정렬 후 PUT 커밋 전 GET이 옛 순서로 덮음 → B안(진행 중 순서 `applyTagOrder` 재적용, MAX 3 규칙 유지) / D-2 `/tasks/new` 하드 로드 시 세션 로딩 전 마운트 → fresh refresh가 토큰 없음 false로 끝나고 재시도 안 함 → `canFetch` 노출 + deps. 테스트 공백 4건(GET 실패, 언마운트, reorder 성공 응답 반영, tagsReordered 무효화) 함께 보강 지시.
- (4라운드 조치) FE: `pendingReorderRef` + GET 반영 시 `applyTagOrder` 재적용(D-1), `canFetch` + TaskTagField deps(D-2), 테스트 +6(공백 4건 포함, 뮤테이션 확인). FE 315/315 · build ✅.

## 2026-10-19 — 리뷰 루프 5라운드 · 종료 · 최종 검토
- 리뷰어 2(Opus 5.5) 모두 **확정 후보 결함 없음** → 종료 조건(한 라운드 확정 결함 0) 충족. 4라운드 조치 회귀 없음(연속 reorder 소유권, PUT 실패 직후 refresh, 토큰 회전·로그아웃·복귀, 하드 로드 GET 1회), BE·FE 계약 1:1 일치, 보안 OK.
- 루프 요약: 1R 확정 6(medium 1) → 2R 2 → 3R 2(FE 상태 머신을 일관 규칙으로 재작성) → 4R 2 → 5R 0.
- 최종 검토(메인, sandbox 밖): BE `pnpm ci:core` lint 0 errors/경고 6(파일별 base 비교 증가 0) · 단위 810/810 · build ✅ · E2E 117 통과(2 skip) / FE `pnpm ci:core` lint 에러 0 · typecheck 0 · 315/315 · build ✅. 변경분 잔여물(console.log·debugger·TODO·any·ts-ignore·eslint-disable) 두 레포 diff·신규 파일 0건.
- 후속(STATUS 게이트 "후속"): 빈 PATCH에도 `tagUpdated` emit · updateTask↔deleteTag 교착(ORA-00060) 추정 실측 · 레플리카 간 `tagsReordered` 도착 순서 ≠ 커밋 순서 가능성(다음 refresh까지 어긋남) · fresh 체인 중 TagModal 로딩 깜빡임 실측.
- 미검증(다음 단계 API·Playwright): 실제 Oracle(`FOR UPDATE`, 정렬 relation, 집계 별칭, UPPER 중복), 2탭 실시간, 드래그, 알림 수신 화면.

## 2026-10-19 — S6 API·Playwright 검증 (로컬 dev 서버 = 운영 DB, 팀 1)
- 서버: 사용자 지시("개발 로컬 서버는 모두 너가 직접 띄워")로 메인이 두 worktree에서 `pnpm dev` 실행(CLAUDE.md Never "DB 접속 명령"과 충돌 — 사용자 명시 지시 우선, 응답에 고지). 프론트 worktree에 `.env` 심볼릭 링크(gitignore). 로컬 Redis가 `NOAUTH`로 실패(환경 — `.env` Redis 비밀번호 불일치 추정, 코드 무관) → HTTP 정상, 단일 인스턴스 소켓 실시간도 동작.
- 도구: 세션 scratchpad `e2e/`에 playwright 1.56.1(레포 의존성 아님), 시스템 Chrome, 사용자 카카오 로그인 후 자동 진행. 데이터는 `[E2E]` 접두어, 종료 시 태그 삭제·태스크 1202 보관.
- 결과(본 실행 20/21 + 재실행): **API 14/14** — trim·대문자 정규화, 대소문자 무시 중복 409(Oracle `UPPER` 유니크), 422 2종, PATCH 색, 재정렬 200·집합 불일치 409, 태스크 생성 tags 정렬 순서(Oracle relation order ✅), 목록·상세 tags, taskCount 집계(Oracle 별칭 ✅), tagIds 교체·11개 422, **동시 태그 교체 2건 200/200(FOR UPDATE 실동작 ✅)**, **동시 재정렬 200/200 + sortOrder 중복 없음(팀 태그 잠금 ✅)**. **UI** — 모달 열기, Enter 생성 2건(서버 반영), 두 번째 탭 실시간 반영, 칸반 카드 칩, 모바일 375px 가로 스크롤 없음, 키보드 재정렬(Space·↑·Space), 마우스 드래그 재정렬, 삭제 확인창 → 서버 삭제 + 태스크에서 CASCADE 제거, 기존 태그 순서 원복.
- 본 실행 실패 1건(UI Enter 생성)은 스크립트 타이밍 — 목록 로딩("태그를 불러오는 중") 중 Enter를 눌러 `tags===null` 가드에 막힘. 로딩 완료 대기 후 재실행 ✅. 키보드 재정렬 1차 실패도 키 입력 간 지연 없음이 원인, 지연 후 ✅.
- 백엔드 로그: ORA-·QueryFailedError 0건. 알림 — 팀 1은 디스코드 미설정, 텔레그램은 로컬 `DOMAIN`(localhost) 링크 버튼을 텔레그램이 거부(400 "Wrong HTTP URL", 기존 로컬 환경 동작·이번 변경 무관) → **D-022 알림 문구 실수신은 미확인**(단위 테스트로 문구 고정) → 배포 직후 조치로 이관.
- 부수 수정: 태그 이름 `@IsNotEmpty`·`@MaxLength` 검증 메시지가 영어 기본값이라 한국어로 지정(`team-tag.dto.ts`, 422 메시지가 토스트로 노출됨). 단위 810 ✅·lint 0 errors.
- 미검증: iOS 실기기 터치 드래그·스포이드(Chromium 데스크톱 전용), 멀티 레플리카 실시간(로컬 Redis 실패), 알림 실수신.

## 2026-10-19 — S6b Redis 연동·멀티 레플리카 검증
- **NOAUTH 원인**: 로컬 6379는 다른 프로젝트 Redis 컨테이너(비밀번호 있음)가 점유. 이 프로젝트의 `bun-redis`(redis:7-alpine, 비밀번호 없음·빈 DB)는 **6380** → `.env`의 `REDIS_PORT`가 6379를 가리켜 남의 Redis에 붙고 있었다(코드 무관). 확인은 docker 명령 없이 `nc`로 RESP PING(6380 `+PONG`, 6379 `-NOAUTH`).
- 조치: `.env`는 건드리지 않고 프로세스 환경변수로 `REDIS_PORT=6380`을 덮어 `pnpm build` 후 레플리카 2개 기동 — 3500(`TASK_SLOT=1`)·3501(`TASK_SLOT=2`). 둘 다 Redis pub/sub 연결·PING→PONG, NOAUTH 0, ORA-/QueryFailed 0.
- 결과 9/9 (`e2e/redis-replica.mjs`, socket.io-client 4.8.3 + Playwright): 소켓 2개 각 레플리카 joinTeam · 3500 생성→3501 `tagCreated` · 3501 수정→3500 `tagUpdated` · 3500 재정렬→3501 `tagsReordered` · 3501 태스크 생성→3500 `taskCreated.tags` · **브라우저(3500 소켓) 모달이 3501에서 만든 태그를 새로고침 없이 표시** · 3500 삭제→3501 `tagDeleted` + 브라우저 모달에서 즉시 제거 · Redis 프레즌스 키(`team:1:online`, `team:1:user:1:sockets`) · 스로틀 키 Redis 저장 확인. 정리: E2E 태그 0, 태스크 1203 보관.
- → STATUS 미검증 "멀티 레플리카 실시간"은 로컬 2레플리카로 해소(운영 Swarm 네트워크 경로는 배포 후 확인).
- 권장(사용자 로컬 설정): `.env` `REDIS_PORT=6380` 또는 다른 프로젝트 컨테이너와 포트 분리 — README "로컬 Redis 실행" 예시(`-p 6379:6379`)와 현재 로컬 구성이 다르다.

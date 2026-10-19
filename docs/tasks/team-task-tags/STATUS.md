# 팀 태스크 태그 (팀 단위 · 노션식 multi-select)

- **상태**: 🟢 구현·리뷰(5라운드)·API/Playwright·Redis 2레플리카 검증 완료 — 사용자 지시로 커밋·`feat-onam-tags → develop → main` 머지(백엔드 먼저, 배포 확인 후 프론트) (2026-10-19)
- **최종수정**: 2026-10-19
- **관련 문서**: DESIGN.md(DDL·REST·소켓 정본) · DECISIONS.md(결정·근거) · WORKLOG.md(조사 근거 파일:라인)

## 세션·브랜치 (D-002·D-008)
| 역할 | 세션 | worktree | 브랜치 (base) |
|---|---|---|---|
| 메인·백엔드·문서 관리 | `bun-f5` | `bun/.claude/worktrees/team-tags` | `feat-onam-tags` (`origin/develop` `c7d2244`) |
| 프론트 | `next-bun-6c` | `next-bun/.claude/worktrees/team-tags` | `feat-onam-tags` (`origin/develop` `a88b62f`) |
- 이 폴더는 메인만 수정한다. 프론트 세션은 보고·질문을 메인에 보내고, 메인이 사용자에게 묻는다.
- 두 레포의 원래 작업 트리(`chore-onam-pnpm10`·`chore-onam-pnpm`)는 건드리지 않는다.

## 목표 & 수용 기준
- 무엇을: 팀마다 태그(이름+색)를 만들어 태스크에 여러 개 붙이고 카드에 보여준다
- 끝났다는 기준:
  - 새 팀은 태그 0개. 활성 멤버 누구나 태그 생성·이름/색 수정·삭제 가능, 비멤버·비활성 멤버는 403
  - 같은 팀 안에서 이름 중복(대소문자 무시) 불가, 다른 팀과는 무관
  - 입구 3곳(팀 보드 메뉴 · 태스크 생성 · 태스크 수정)에서 같은 모달 컴포넌트가 열린다
  - 태스크 생성·수정 폼에서 태그 여러 개를 고르고, 입력하다 Enter로 새 태그를 바로 만들 수 있다
  - 색: 추천 5색 + `react-colorful` 피커 + HEX 입력, 스포이드는 지원 브라우저(Chromium 데스크톱)에서만 보인다
  - 이름 20자·태스크당 10개 초과는 서버가 422 `VALIDATION_ERROR`, 팀당 100개 초과는 400 `TEAM_TAG_LIMIT_EXCEEDED`로 거부하고 프론트도 같은 값으로 막는다 (DESIGN §2-1)
  - 팀 태그 순서를 태그 관리 모달에서 드래그로 바꾸면 모든 팀원 화면의 목록·칩·필터 순서가 바뀐다
  - 두 테이블의 테이블·전 컬럼에 코멘트가 있다(DESIGN.md §1-3 쿼리로 확인)
  - 보드 필터에서 태그를 여러 개 고르면 그중 하나라도 붙은 태스크만 보인다
  - 칸반 카드·리스트·상세에 태그 칩이 보이고, 다른 팀원의 태그 생성·수정·삭제·태스크 태그 변경이 새로고침 없이 반영된다
  - 태그를 삭제하면 붙어 있던 모든 태스크에서 사라진다(삭제 전 사용 수 확인창)
  - 백엔드 `pnpm ci:core`(경고 수 증가 없음) · 프론트 `pnpm ci:core` 통과
  - 태스크 생성·태그 변경 시 텔레그램·디스코드 알림에 현재 태그와 추가·제거 내용이 실린다 (D-022)
- 비목표: 팀 태그 정의 변경(생성·이름/색·삭제·정렬) 알림, 캘린더·간트 칩 표시, 서버 측 태그 필터 파라미터

## 지금 어디까지 (다음 세션이 여기서 이어간다)
- 완료: 조사·설계 D-001~D-020 확정, worktree 생성, 사용자 구현 착수 지시(2026-10-19), S1 파일 작성(WORKLOG S1 절)
- **다음 할 일**:
  1. 머지·배포 결과(PR 번호·배포 워크플로 결과)는 이 문서가 아닌 GitHub PR·Actions가 기록 — 다음 세션은 `gh pr list --state merged --head feat-onam-tags`로 확인
  2. 배포 직후: 텔레그램·디스코드 태그 알림 문구 실수신, 운영 2탭(멀티 레플리카) 실시간, iOS 실기기 드래그
  3. 후속(위험 & 롤백 게이트 참조)

## 진행 체크리스트
- [x] S0 — 요구사항·양 레포 조사·설계 초안·worktree
- [x] S1 — 스키마: Entity 2(`TeamTag`·`TeamTaskTag`) + 마이그레이션 2 + `database.config.ts` 등록. build ✅ · lint 경고 6(기준 7, 신규 0)
- [x] S1a — 담당자 마이그레이션 실행 완료 (2026-10-19, 사용자 보고)
- [x] S1b — 스키마 확인 결과가 DESIGN.md와 일치 (WORKLOG S1 절)
- [x] S2 — 태그 CRUD·재정렬 REST + 도메인 에러 + 소켓 4종 (계약 확정본 DESIGN.md §2·§3, D-021)
- [x] S3 — 태스크 `tagIds` + 응답 `tags` + `taskCreated/Updated` 페이로드. 백엔드 검증: build ✅ · lint 0 errors/경고 6 · 단위 803/803 · E2E 113 통과(2 skip redis). **실제 Oracle 쿼리 3종 미검증**(WORKLOG 2026-10-19 백엔드 구현 절)
- [x] S4·S5·S5a — 프론트 전부 (WORKLOG 프론트 구현 절). 메인 재검증: lint 신규 0 · typecheck 0 · test:run 295/295 · build ✅ · 계약 대조 일치
- [x] S5b — 프론트: `normalizeTaskTags`(`tags ?? []`)를 진입점 3곳(HTTP 목록·상세, 소켓 taskCreated)에만 적용. 메인 재검증: test:run 296/296 · typecheck 0 · build ✅
- [x] S5c — 태그 알림(D-022) + 프론트 토스트 정비 (WORKLOG 멀티 레플리카·토스트·알림 절). 백엔드 단위 807/807 · E2E 113 · 프론트 296/296 · build ✅
- [x] S5d — 리뷰 루프(Opus 5.5 리뷰어 2 + 교차검증, 5라운드에서 확정 결함 0으로 종료) + 최종 검토 ✅ (WORKLOG 리뷰 루프 1~5라운드 절). BE 810·E2E 117 · FE 315 · 양쪽 build ✅
- [x] S6 — API 14/14 · Playwright UI 전 항목 ✅ (실제 Oracle: 정렬 relation·집계·UPPER 중복·FOR UPDATE 동시 요청 2종). 미검증: iOS 실기기 터치, 알림 실수신 (WORKLOG S6 절)
- [x] S6b — Redis 연동·로컬 2레플리카(3500·3501, bun-redis 6380) 교차 소켓·브라우저 실시간·프레즌스·스로틀 9/9 ✅ (WORKLOG S6b 절 — NOAUTH 원인은 6379 포트를 다른 프로젝트 Redis가 점유)
- [x] S7 — 커밋·머지(사용자 지시 2026-10-19, 백엔드 → 프론트)
- [ ] S8 — 배포 직후: 알림 문구 실수신 · 운영 2탭 · iOS 실기기 드래그: 양 레포 `ci:core`, 2탭 실시간 수동 확인

## 미해결 질문 · 차단
| # | 질문 | 누구에게 | 권장 디폴트 | 상태 |
|---|---|---|---|---|
| Q1 | 컬러 피커 구현 방식 | 사용자 | — | ✅ react-colorful (D-013) |
| Q2 | 한도 | 사용자 | — | ✅ 20자·100개·10개 (D-014) |
| Q3 | 태그 필터 범위 | 사용자 | — | ✅ 포함, 클라이언트 OR (D-015) |
| Q4 | 칩 표시 범위 | 사용자 | — | ✅ 권장안 (D-016) |
| Q5 | 태그 목록 정렬 | 사용자 | — | ✅ 팀 단위 수동 정렬 + 드래그 (D-017) |
| Q7 | 드래그 구현 방식 | 사용자 | — | ✅ @dnd-kit (D-020) |
| Q6 | 태그 실시간 이벤트 | 메인 | 발행 | 디폴트 채택(D-006) |

## 결정 요약 (본문은 DECISIONS.md)
- D-001 요구사항 원문 · D-002 세션 구성 · D-008 worktree·브랜치
- ✅(D-019) D-003 `TEAM_TAGS` + `TEAM_TASK_TAGS` · D-004 하드 삭제 + CASCADE + 확인창 · D-005 REST 계약(`tagIds` 전체 교체, 응답 `tags`) · D-006 소켓 이벤트 · D-007 `#RRGGBB` 저장, 글자색은 프론트 계산 · D-009 공통 모달 1개 2모드 · D-012 중복·기본 색
- ✅ D-017 `SORT_ORDER` + `PUT tags/order` + 드래그 `@dnd-kit`(D-020) · D-018 코멘트 필수, DDL 정본 DESIGN.md
- ✅ D-013 `react-colorful`(D-010 피커 부분 대체, 스포이드는 기능 감지) · D-014 한도 20자/100/10 · D-015 태그 필터(클라이언트, OR) · D-016 칩 표시(D-011)

## 검증 명령 (DoD)
- 백엔드(worktree): `pnpm ci:core` (sandbox 안 E2E는 `listen EPERM` — 밖에서 판정)
- 프론트(worktree): `pnpm ci:core` (sandbox 안 build는 Google Fonts 차단 — 밖에서 판정)
- 마이그레이션: 담당자가 `pnpm db:migrate:up` 후 `SELECT table_name, comments FROM user_tab_comments WHERE table_name IN ('TEAM_TAGS','TEAM_TASK_TAGS');`

## 위험 & 롤백
- 배포 순서: ① 마이그레이션 → ② 백엔드 → ③ 프론트. 구 백엔드에 프론트가 `tagIds`를 보내면 `forbidNonWhitelisted`로 400(WORKLOG 백엔드 절) — 프론트를 먼저 내면 태스크 생성·수정이 깨진다
- 마이그레이션은 신규 테이블만 — 기존 기능 무영향. 롤백은 `db:migrate:revert` 2회(⚠️ 태그 데이터 삭제)
- 게이트: **머지 전 차단** — ~~마이그레이션 실행~~ ✅(2026-10-19) · S6 API·Playwright 검증 / **배포 직후** — 운영 2탭 실시간·알림 수신 확인 / **후속** — 서버 측 태그 필터(페이지네이션 도입 시), 빈 PATCH `tagUpdated` emit, ORA-00060 교착 추정 실측, 레플리카 간 `tagsReordered` 순서, TagModal 로딩 깜빡임 (WORKLOG 5라운드 절)

# 카카오 닉네임 수집 중단 · 랜덤 기본 닉네임 · 팀 단위 닉네임

- **상태**: 🟡 배포 진행 — 사용자 테스트 종료·배포 지시(2026-11-12), 백엔드 커밋 → develop → main 후 프론트
- **최종수정**: 2026-11-12
- **관련 문서**: DECISIONS.md · WORKLOG.md

## 세션·브랜치
| 역할 | 세션 | worktree | 브랜치 (base) |
|---|---|---|---|
| 메인·백엔드·문서 관리 | (이 세션, bun) | `bun/.claude/worktrees/team-nickname` | `feat-onam-team-nickname` (`origin/develop` `b249047`) |
| 포트리스(병행, 별건) | `bun-a6` | `bun/.claude/worktrees/fortress` | `feat-onam-fortress` — 겹치는 파일 없음, 마이그레이션 번호 무충돌(2026-11-12 확인) |
| 프론트 | `next-bun-fe` | `next-bun/.claude/worktrees/team-nickname` | `feat-onam-team-nickname` (`origin/develop` `1a76e44`) |
- 이 폴더는 메인만 수정한다. 프론트 세션은 보고·질문을 메인에 보낸다.

## 목표 & 수용 기준
- 무엇을:
  1. 카카오 로그인에서 카카오 닉네임을 받지도·저장하지도·쓰지도 않는다. 신규 가입자는 랜덤 기본 닉네임을 받는다. 기존 유저의 `USERS.USER_NAME`은 그대로 둔다
  2. 팀(Teams) 가입 시 계정 닉네임이 팀 닉네임으로 복사되고, 이후 팀 안에서 따로 바꿀 수 있다. 마이페이지 계정 닉네임 변경은 팀에 영향이 없다 (D-004)
  3. 팀 컨텍스트에서 사람 이름이 나가는 모든 응답·소켓 이벤트·알림이 "팀 닉네임 → 계정 닉네임 → `사용자{id}`" 순으로 자동 해석된다
- 끝났다는 기준:
  - `POST /auth/kakao`가 `kakaoNickname`을 보내도 무시되고(400 아님), 신규 유저 `USER_NAME`이 랜덤 닉네임으로 저장된다 — 단위 테스트로 고정
  - WORKLOG 2026-11-12 절 표의 팀 이름 노출 지점 13곳이 전부 팀 닉네임을 반영한다 — 단위 테스트 + 실제 API(Swagger/Playwright)로 확인
  - 팀 닉네임 변경 시 같은 팀 접속자에게 소켓으로 즉시 반영된다(온라인 목록·채팅 이름 포함)
  - 팀 외부(게임·낚시·테트리스·피드백·마이페이지)는 계정 닉네임 그대로다
  - 백·프 `pnpm ci:core` 통과, 마이그레이션 파일 + Entity 세트 제출(실행은 담당자)
- 비목표: 기존 유저 닉네임 일괄 변경, 계정 닉네임 변경 API(`PUT /users/me`) 변경, 게임 쪽 플레이어 이름

## 지금 어디까지
- 완료: worktree(백·프), 전수조사(백 13지점·프 Q1~Q5), 결정 D-001~D-003, 백엔드 S1~S4 구현·테스트(ci:core 1941/1941) — WORKLOG 2026-11-12 절
- **다음 할 일**:
  1. 백엔드 PR feat-onam-team-nickname → develop → main(CI·배포 확인) → 프론트 같은 순서 (사용자 배포 지시 2026-11-12)
  2. 배포 직후 …074 UPDATE 1회 재실행(담당자)

## 진행 체크리스트
- [x] S1 — 마이그레이션 `USER_TEAMS.TEAM_NICKNAME` + Entity (파일만 — 실행은 담당자)
- [x] S2 — 카카오 닉네임 무시 + 랜덤 닉네임 생성기
- [x] S3 — 팀 이름 해석 13지점 전환 (HTTP·WS·Redis 온라인·알림)
- [x] S4 — 팀 닉네임 설정 API + `memberNicknameChanged` 이벤트
- [x] S5 — 프론트(next-bun-fe): kakaoNickname 제거, 팀 닉네임 설정 UI, 이벤트 반영 (리뷰 2R 확정 0, 길이 계산·바이트 검증 보완 중)
- [x] S6 — 검증·리뷰 루프: 백 ✅(R3 확정 0) / 프 ✅(R2 확정 0) · 실API·Playwright 45/45 · 백 ci:all ✅ · 실제 API·Playwright는 마이그레이션 실행 후

## 미해결 질문 · 차단
| # | 질문 | 누구에게 | 권장 디폴트 | 상태 |
|---|---|---|---|---|
| Q1 | 랜덤 닉네임 형식 | 사용자 | 형용사+동물+4자리 숫자 | ✅ D-002 |
| Q2 | 팀 닉네임 설정 권한 | 사용자 | 본인만 | ✅ D-002 |
| Q3 | 팀 안 닉네임 중복 허용 | 사용자 | 허용 | ✅ D-002 |
| Q4 | 마이그레이션 실행(…073 컬럼·…074 백필) | 담당자(사용자) | `pnpm db:migrate:up` — 머지 전 | ✅ 2026-11-12 |

## 결정 요약 (본문은 DECISIONS.md)
- D-001 요구사항 원문 · 기존 닉네임 유지 · 응답 필드는 기존 `userName`에 해석값을 넣는다
- D-002 랜덤 = 형용사+동물+4자리 · 설정은 본인만 · 팀 안 중복 허용
- D-003 계약: `PUT /teams/:teamId/users/me/nickname` · 소켓 `memberNicknameChanged` · 멤버 목록 `teamNickname` · 팀 범위 `userName` non-null (DELETE는 D-004로 제거)
- D-007 팀 닉네임 UI 공간 정리(헤더 칩·온라인 시트 같은 행 편집·근처 컴포넌트)
- D-006 멤버 목록 응답 `joinedAt` 추가(가입일 Invalid Date 수정) · 팀 관리 탭 aria-label — 이번 작업에 포함
- D-005 편집 진입점은 기본 화면에서 보이게·여러 곳, 로직은 공통 1벌
- D-004 팀 닉네임 = 가입 시점 계정 닉네임 복사본, 이후 마이페이지 변경과 독립 · 기존 멤버 백필(…074)

## 검증 명령 (DoD)
- `pnpm ci:core` (백·프), PR 직전 `pnpm ci:all`
- 변경 심볼 grep: `grep -rn "userName\|getDisplayName\|kakaoNickname" src test`
- 실제 API·Playwright: 팀 닉네임 설정 → 멤버 목록·태스크·댓글·채팅·온라인 목록 반영 확인

## 남은 항목 — 게이트
- **머지 전 차단**: 없음 (마이그레이션 …073·…074 실행 완료 2026-11-12)
- **배포 직후 조치**: 모든 레플리카 교체 후 …074의 UPDATE 1회 재실행(롤링 중 옛 레플리카 가입 행 NULL 채움, 멱등)
- **후속**: 프론트 `SkinUpgradePanel.tsx` Esc 전파(WORKLOG D-005 절) · 계정 닉네임 `PUT /users/me`도 20자 통과 값이 100바이트를 넘으면 500(ORA-12899) — 팀 닉네임과 같은 `@IsByteLength` 필요(기존 동작, WORKLOG 바이트 상한 절)

## 위험 & 롤백
- 배포 게이트: Entity에 `teamNickname`이 들어간 코드가 마이그레이션 전에 배포되면 USER_TEAMS 조회 전체가 ORA-00904로 깨진다 → **마이그레이션 실행이 머지 전 차단 조건**
- 배포 순서: 백엔드(kakaoNickname optional 유지·무시) 먼저 → 프론트. 롤백은 revert(컬럼은 nullable이라 남아도 무해)

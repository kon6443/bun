# 테트리스 사용자별 인게임 UI(스킨) + 게임 기록 userId 점검

- **상태**: 🟡 구현 중 — D-001·D-002 확정, 백·프 병행 (2026-10-26)
- **브랜치**: 백·프 `feat-onam-tetris-skins`(각 `origin/main`) · **최종수정**: 2026-10-26
- **관련 문서**: DECISIONS.md · WORKLOG.md · 선행 `../games-polish-2026-10/`(공통 소리 설정 모달·게임패드) · `../tetris-battle/`

## 세션·브랜치
| 역할 | 세션 | worktree | 브랜치 (base) |
|---|---|---|---|
| 메인·백엔드·문서 관리 | 메인(bun) | `bun/.claude/worktrees/tetris-skins` | `feat-onam-tetris-skins` (`origin/main` `1c7df5c`) |
| 프론트 | `next-bun-35` | (생성 예정) | `feat-onam-tetris-skins` (`origin/main`) |
- 이 폴더는 메인만 수정한다.

## 목표 & 수용 기준
1. **스킨**(D-001): 현재 UI = `default`. 4종 중 로그인 사용자가 고르면 계정에 저장되고, 그 사용자의 보드는 어디서든(내 플레이·대전 상대 화면·리플레이) 그 스킨으로 그려진다. 게스트는 `default`
   - 백: `USER_PREFERENCES` 마이그레이션+Entity · `GET/PUT /users/me/preferences` · `RoomPlayer.skin` · 리플레이·경기 조회 `skin` · 단위·E2E
   - 프: 스킨 팔레트 4종 · drawGame·MiniBoard 팔레트 주입 · 스프라이트 캐시 키 · 설정 UI(로그인 전용) · 보드별 스킨 적용
2. **userId**(D-002): 로그인 상태로 시작한 판은 제출 토큰이 거절돼도 USER_ID가 남는다. 프론트는 401을 침묵 익명화하지 않는다
- 비목표(1단계): DOM HUD·대전 연출·OG 카드 색

## 지금 어디까지
- 완료: 백 브랜치·worktree · 조사(백·프) · 결정 D-001·D-002
- **다음 할 일**:
  1. 백: 마이그레이션·Entity·preferences API·방 상태·리플레이 skin·userId 폴백 → ci:core
  2. 프: 계약대로 구현(프론트 세션)
  3. 마이그레이션 실행(사용자) → 로컬 실 API·Playwright 검증 → 리뷰 라운드 → 머지·배포(지시 후)

## 결정 요약
- D-001 스킨 4종·로그인 전용 계정 저장·보드 주인 스킨·1단계 canvas·userId 수정 포함(사용자)
- D-002 USER_PREFERENCES 테이블·`/users/me/preferences`·RoomPlayer.skin·리플레이 skin·싱글 제출 세션 userId 폴백

# 테트리스 사용자별 인게임 UI(스킨) + 게임 기록 userId 점검

- **상태**: 🟡 백엔드 구현 완료(로컬 커밋) · 프론트 구현 중 · 마이그레이션 실행 완료 (2026-10-26)
- **브랜치**: 백·프 `feat-onam-tetris-skins`(각 `origin/main`) · **최종수정**: 2026-10-26
- **관련 문서**: DECISIONS.md · WORKLOG.md · 선행 `../games-polish-2026-10/`(공통 소리 설정 모달·게임패드) · `../tetris-battle/`

## 세션·브랜치
| 역할 | 세션 | worktree | 브랜치 (base) |
|---|---|---|---|
| 메인·백엔드·문서 관리 | 메인(bun) | `bun/.claude/worktrees/tetris-skins` | `feat-onam-tetris-skins` (`origin/main` `1c7df5c`) |
| 프론트 | `next-bun-35` | (생성 예정) | `feat-onam-tetris-skins` (`origin/main`) |
- 이 폴더는 메인만 수정한다.

## 목표 & 수용 기준
1. **스킨**(D-001·D-003): 슬롯 4개(블록·이펙트·판 배경·화면 배경)를 따로 장착. 로그인 사용자만, 계정 저장. 보드 슬롯(블록·이펙트·판 배경)은 보드 주인 것으로, 화면 배경은 보는 사람 것으로 그린다. 카탈로그는 서버 SSOT(획득 방식 포함 — 이후 업적·출석)
   - 백: `USER_SKIN_EQUIPS` 마이그레이션+Entity · 카탈로그 · `GET/PUT /users/me/skins` · `RoomPlayer.skins` · 리플레이·경기 조회 `skins` · 단위·E2E
   - 프: 슬롯별 테마 4종 · drawGame·MiniBoard 슬롯별 주입 · 스프라이트 캐시 키 · 장착 UI(로그인 전용, 잠금 표시 자리) · 보드별 적용
2. **userId**(D-002): 로그인 상태로 시작한 판은 제출 토큰이 거절돼도 USER_ID가 남는다. 프론트는 401을 침묵 익명화하지 않는다
- 비목표(1단계): DOM HUD·대전 연출·OG 카드 색

## 지금 어디까지
- 완료: 조사 · 결정 D-001~D-003 · 백엔드 구현(fff54c8·0cead1e·5940670, ci:core·E2E 통과)
- **다음 할 일**:
  1. ~~마이그레이션 실행~~ — 완료(2026-10-26, 사용자 실행 · 스키마 확인)
  2. 프: 렌더 슬롯 주입 → 장착 저장소·UI → 보드별 연결 → 401 안내(프론트 세션, 진행 중)
  3. 로컬 실 API·Playwright 검증 → 리뷰 라운드 → 머지·배포(지시 후)
- 별건 조사 중(프론트): 모바일 대전 보드 크기 · 게임보이 D-pad 롱프레스 콜아웃

## 결정 요약
- D-001 스킨 4종·로그인 전용 계정 저장·보드 주인 스킨·1단계 canvas·userId 수정 포함(사용자)
- D-002 싱글 제출 세션 userId 폴백(저장 구조·계약 부분은 D-003이 대체)
- D-003 슬롯 4개(block·effect·board·background)·서버 카탈로그(획득 방식)·`USER_SKIN_EQUIPS`·`/users/me/skins`·보드 슬롯은 주인, 화면 배경은 보는 사람

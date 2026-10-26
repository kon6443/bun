# 테트리스 사용자별 인게임 UI(스킨) + 게임 기록 userId 점검

- **상태**: ✅ 배포 완료 — 백 #299 · 프 #384 (2026-10-26)
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
- 완료: 조사 · 결정 D-001~D-005 · 백엔드 구현(fff54c8·0cead1e·5940670·cd92ad2 도감 API, ci:core·E2E 통과) · 프론트 스킨 렌더·장착·보드별 연결(7aec5d6·4fe11ca·73888c5)
- **다음 할 일**:
  1. 사용자: iOS·Android 실기기 D-pad 롱프레스 확인
  2. 설정 공통화(시트)·UX 개선은 별도 태스크 `../game-settings/`
  3. 후속 후보: 리플레이 KeyOverlay 겹침 · 입장 스킨 조회 타임아웃 · 업적·출석 획득(USER_SKIN_ITEMS) · 실매치 2계정 스킨 표시 실측
- 게이트: 머지 전 차단 없음 — 마이그레이션 3개(USER_SKIN_EQUIPS·대전/싱글 BOARD_SKINS) 실행 완료. 배포 직후 조치 없음

## 결정 요약
- D-001 스킨 4종·로그인 전용 계정 저장·보드 주인 스킨·1단계 canvas·userId 수정 포함(사용자)
- D-002 싱글 제출 세션 userId 폴백(저장 구조·계약 부분은 D-003이 대체)
- D-003 슬롯 4개(block·effect·board·background)·서버 카탈로그(획득 방식)·`USER_SKIN_EQUIPS`·`/users/me/skins`·보드 슬롯은 주인, 화면 배경은 보는 사람
- D-004 모바일 보드 크기 A0 + A(세로 전용) · D-pad touchstart 차단
- D-005 스킨 도감 페이지 · `GET /games/:gameType/skins`(누구나, 로그인 시 보유·장착)
- D-006·D-007 리플레이(대전·싱글)는 그 판 시작 때의 보드 스킨으로 고정

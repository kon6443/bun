# 결정 로그 — 테트리스 스킨·userId

> append-only. 뒤집힌 결정은 새 항목에 `supersedes D-00N`.

## D-001 — 범위·저장·멀티 표시 (2026-10-26, 사용자)
- **맥락**: 조사 보고 후 사용자 선택
- **결정**:
  - 스킨 4종: `default`(현재 인게임 UI) · `gameboy`(녹색 4톤) · `neon` · `high-contrast`(색각 친화)
  - **로그인 사용자만** 스킨을 고를 수 있다 — 계정(서버)에 저장. 게스트는 항상 `default`, 선택 UI는 로그인 유도
  - **보드 주인 스킨**: 각 보드는 그 보드 주인이 고른 스킨으로 그린다 — 내 판은 내 스킨, 대전 상대 보드는 상대 스킨
  - 1단계 범위: 게임판 canvas(블록·고스트·HOLD/NEXT·보드 배경·이펙트·대전 미니 보드). DOM HUD·대전 연출·OG 카드는 2단계 이후 별도 결정
  - userId 누락 수정을 같은 작업에 포함(백·프)
- **영향**: 백엔드 새 테이블·API·대전 방 상태 필드·리플레이 응답 필드, 프론트 렌더러 팔레트 주입·설정 UI

## D-002 — 계약·세부 설계 (2026-10-26, 메인 — D-001에서 파생)
- **결정**:
  - 저장: 새 테이블 `USER_PREFERENCES`(USER_ID PK·FK USERS, TETRIS_SKIN VARCHAR2(32) NULL = default, UPDATED_AT TIMESTAMP WITH TIME ZONE) — 사용자 설정을 한 행에 컬럼으로 늘려 가는 구조(소리 설정 등 이후 확장). USERS 컬럼 추가 대신 분리: 인증·프로필과 수명·쓰기 빈도가 다르다
  - API(JwtAuthGuard): `GET /users/me/preferences` → `{ tetrisSkin }`(행 없으면 `default`) · `PUT /users/me/preferences` `{ tetrisSkin }`(허용 목록 밖은 422 — 전역 ValidationPipe) — 기존 `PUT /users/me` 관례
  - "보드 주인 스킨"을 모든 표시에 같은 규칙으로: 대전 방 상태 `RoomPlayer.skin`(입장 때 서버가 계정 설정을 읽어 붙인다 — 클라이언트가 보낸 값은 받지 않는다) · 싱글 리플레이 응답 `skin`(기록 USER_ID의 **현재** 설정) · 대전 경기 조회 `players[].skin`(같은 규칙). 게스트·익명 기록은 `default`
  - 대전 중 설정 변경은 다음 입장·재연결 때 반영(실시간 갱신은 하지 않는다)
  - userId: 싱글 제출이 익명(토큰 없음·거절 후 재시도)이면 세션 발급 때 보관한 userId로 저장(대전 결과의 입장 userId 폴백과 같은 규칙). 프론트는 로그인 사용자의 401을 침묵 익명화하지 않고 보관 + 재로그인 안내
- **근거**: WORKLOG 2026-10-26 조사 — 세션 userId 보관(`game-session.service.ts:62`), 대전 폴백(`tetris-battle-result.service.ts:409-410`), 프론트 401 익명 재시도(`gameService.ts:111-118`)

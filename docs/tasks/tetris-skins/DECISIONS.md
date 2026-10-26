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

## D-003 — 스킨을 슬롯 4개로 나누고 획득형 아이템으로 확장 가능하게 (2026-10-26, 사용자) — supersedes D-001의 "스킨 4종 단일 선택"·D-002의 저장 구조·계약
- **맥락**: 사용자 — "블럭 스킨, 이펙트 스킨, 배경 스킨, 판배경 스킨 등 구분해서 다양하게, 업적이나 출첵으로 추후 얻을 수 있게 할 거라 나눠서 적용 가능하도록"
- **결정**:
  - **슬롯 4개**(API 키 / DB SLOT): 블록 `block`/`TETRIS_BLOCK`(블록 7종·가비지·고스트·HOLD/NEXT 미리보기) · 이펙트 `effect`/`TETRIS_EFFECT`(줄 삭제·파티클·트레일·하드드롭 연출) · 판 배경 `board`/`TETRIS_BOARD`(보드 배경·격자·레벨 틴트·테두리 네온) · 화면 배경 `background`/`TETRIS_BACKGROUND`(게임 화면 바탕 — GameSurface). 슬롯마다 따로 고른다(섞어 쓰기 가능)
  - 처음 아이템: 슬롯마다 `default`(현재 UI)·`gameboy`·`neon`·`high-contrast` — 모두 무료(획득 조건 없음)
  - **카탈로그는 서버가 SSOT**(아이템 id·슬롯·획득 방식 `default|free`, 이후 `achievement|attendance` 추가). 프론트는 id별 시각 자료만 가진다. 서버가 장착 가능 여부를 판정한다(획득 안 한 아이템 장착 거부)
  - 저장: `USER_SKIN_EQUIPS`(USER_ID, SLOT, SKIN_ID, UPDATED_AT, PK (USER_ID, SLOT)) — 슬롯·아이템이 늘어도 마이그레이션 없이 행만 는다. 획득 기록 테이블(`USER_SKIN_ITEMS`)은 업적·출석 기능 때 추가(지금은 무료 아이템뿐이라 만들지 않는다)
  - API: `GET /users/me/skins` → `{ equipped: { block, effect, board, background }, catalog: { block: [{ id, owned, unlock }], … } }` · `PUT /users/me/skins` 부분 수정 `{ block?, effect?, board?, background? }`(카탈로그 밖 422, 미보유 403 `SKIN_NOT_OWNED`)
  - 보드 주인 규칙(D-001 유지): 대전 `RoomPlayer.skins` · 싱글 리플레이 `skins` · 대전 경기 조회 `players[].skins` = `{ block, effect, board }`(보드에 그려지는 슬롯만). **화면 배경은 항상 보는 사람 자신의 것**(남의 화면 바탕을 바꾸지 않는다)
  - 게스트: 모두 `default`, 장착 UI는 로그인 유도(D-001 유지)
- **영향**: D-002의 `USER_PREFERENCES`·`/users/me/preferences`·`skin` 단일 필드는 쓰지 않는다(파일만 쓰고 실행 전이라 교체). userId 폴백(D-002)은 그대로

## D-004 — 모바일 보드 크기: A0 + A(세로 전용), 가로 전용 배치는 하지 않음 (2026-10-26, 사용자)
- **맥락**: WORKLOG 2026-10-26 별건 조사. 사용자 "권장대로 진행하는데 가로 휴대폰으로 테트리스를 할까? 안 할 것 같은데"
- **결정**:
  - A0 `useMiniCell`에 높이 조건 — 가로 휴대폰 대전의 판 잘림만 막는 한 줄 안전망(가로 레이아웃을 더 다듬지는 않는다)
  - A 상대 미니보드를 판 옆 세로 줄로 — **세로 화면에서 높이가 한계일 때만**(폭이 한계면 지금 배치 유지). 가로 전용 배치는 제외
  - B(패드 낮추기·HOLD 위치 변경)·C·D는 하지 않음(필요 시 후속)
  - D-pad 롱프레스: 패드 루트 touchstart 취소(사용자 요청 "disable 처리") — iOS 실기기 판정은 사용자 확인
- **근거**: 375×667 대전 1명 셀 12 → 16(+33%) 기대, 조작감 변화 없음

## D-005 — 스킨 도감 페이지: 공개 카탈로그 API + 내 보유·장착 표시 (2026-10-26, 사용자)
- **맥락**: 사용자 — "모든 스킨 전체 목록 및 어떻게 얻을 수 있는지 확인하는 페이지" + "내가 보유하고 있는 스킨도 노출"
- **결정**:
  - 백: `GET /games/:gameType/skins`(누구나, OptionalJwtAuthGuard) → `{ signedIn, slots: [{ slot, items: [{ id, unlock, owned, equipped }] }] }`. 게스트는 `owned·equipped` 모두 false(보유 = 계정 기준), `signedIn` false. 스킨이 없는 게임(DEFENSE)은 `slots: []`. 획득 방식은 `unlock`(지금 default·free — 업적·출석이 생기면 조건 필드를 함께 싣는다). 기존 `/users/me/skins`(장착 화면용)는 유지
  - 프: 도감 페이지(슬롯 탭·아이템 카드 = 미리보기·이름·획득 방법·보유/장착 배지, 로그인이면 바로 장착, 게스트는 로그인 유도). 진입점은 테트리스 홈·스킨 장착 모달에서
  - 이름·미리보기는 프론트 레지스트리, 획득 방법 문구는 `unlock` 종류별 프론트 문구(조건 값이 생기면 서버 값으로 채운다)

## D-006 — 대전 리플레이는 그 경기 당시의 스킨으로 (2026-10-26, 사용자) — supersedes D-003의 "대전 경기 조회 = 주인의 현재 장착"
- **맥락**: 사용자 — "지금 스킨을 바꿔도 대전 리플레이에서는 그 판 당시에 쓰던 스킨으로"
- **결정**:
  - 경기 시작 때 각 자리의 보드 스킨(방 상태 `StoredPlayer.skins` — 입장 때 계정 장착)을 매치 상태(Redis `p:{pid}:skins`)에 복사하고, 경기 저장 때 `TETRIS_BATTLE_PLAYERS.BOARD_SKINS`(JSON 문자열)에 남긴다
  - `GET /tetris-battle/matches/:matchId` `players[].skins`는 저장값을 그대로 돌려준다. 값이 없는 경기(이 기능 전 — 그때는 스킨이 없어 기본 화면이었다)는 default
  - 경기 중 장착을 바꿔도 그 경기 기록은 바뀌지 않는다(시작 시점 고정). 실시간 방 상태(D-003)는 그대로
  - 싱글 리플레이는 이번 요청 범위 밖 — 지금은 주인의 현재 장착(D-003). 같은 규칙 적용 여부는 사용자 확인
- **영향**: 마이그레이션(TETRIS_BATTLE_PLAYERS 컬럼 추가) — 실행 전 배포 금지(머지 전 차단). 백엔드 매치 저장·조회, 프론트 변경 없음(응답 형태 동일)

## D-007 — 싱글 리플레이도 그 판 당시의 스킨으로 (2026-10-26, 사용자) — supersedes D-003의 "싱글 리플레이 = 기록 주인의 현재 장착"
- **맥락**: 사용자 — "싱글도 기존 유저가 장착했던 스킨으로 노출되도록 진행. 아직 마이그레이션 실행 안 해서 그거 수정해도 될 듯"
- **결정**:
  - TETRIS 세션 발급 때 로그인 사용자의 보드 스킨을 세션(Redis)에 함께 보관하고, 기록 등록 때 `GAME_REPLAYS.BOARD_SKINS`(JSON)에 남긴다. 리플레이 조회는 저장값(없음 = 기능 전 기록·게스트 세션 → default)
  - 시점은 "판을 시작할 때"(세션 발급) — 대전(D-006 경기 시작)과 같은 기준. 스킨 조회가 실패해도 세션은 발급한다(그 판은 default로 남는다)
  - 마이그레이션은 D-006 파일에 합치지 않고 별도 파일 — 프로젝트 규칙 "1파일 = 1목적"(`.claude/rules/schema-migrations.md`)이 우선. 둘 다 미실행이라 한 번의 `db:migrate:up`으로 함께 실행된다
- **영향**: 리플레이 조회의 소유자·장착 추가 조회 2회가 사라진다(리뷰 라운드 1 효율 지적 해소). 응답 형태 동일 — 프론트 변경 없음

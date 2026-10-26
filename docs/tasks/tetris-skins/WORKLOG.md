# 작업 기록 — 테트리스 스킨·userId

> append-only. 목차는 `grep -n "^## "`.

## 2026-10-26 — 백엔드 userId 기록 경로·운영 데이터
- 싱글 랭킹: `games.controller.ts` 세션 생성(:98)·기록 제출(:149) 모두 `@UseGuards(OptionalJwtAuthGuard)` → `user?.userId ?? null` → `games.service.ts` 저장(:375 `userId`). 가드는 토큰이 없으면 익명 통과, 있으면 검증 후 user 주입(`optional-jwt-auth.guard.ts`) — 토큰은 cookie `access_token` → Bearer
- 대전: 방 입장 때 userId 보관(`tetris-battle-room.service.ts:134`) → 결과 제출 `tetris-battle-result.controller.ts:82` OptionalJwtAuthGuard → 저장 시 제출 userId 우선, 없으면 입장 userId(`tetris-battle-result.service.ts:409-410`)
- 운영 데이터(`pnpm db:select`, 읽기 전용):
  - GAME_SCORES — TETRIS user 56 · null 66, DEFENSE null 3(Playwright 테스트 기록). USER_ID가 있는 기록은 전부 USER_ID 1(첫 기록 2026-10-21). USERS 9명
  - TETRIS_BATTLE_PLAYERS — USER_ID 1 VERIFIED 12 · null VERIFIED 56 · null MISSING 13
  - 이상 사례: score 102(`daily-2026-10-24`, 이름이 USER_ID 1 사용자의 다른 기록과 같음)가 USER_ID null — 그 직전·직후 default 기록은 USER_ID 1. 비로그인 브라우저였는지 daily 경로가 토큰을 안 보내는지 프론트 호출부 확인 필요
- 판단(잠정): 백엔드는 토큰이 오면 기록한다. 누락은 프론트가 토큰(쿠키)을 안 보내는 경로가 있는지에 달림 → 프론트 세션 질의

## 2026-10-26 — 프론트 조사 답(next-bun-35, origin/main decdb75)
- **userId 전송**: 브라우저 호출 인증은 Bearer 헤더 한 갈래(`src/services/FetchService.ts:101-103`, credentials 'same-origin' — 쿠키 경로 미사용). 세션 발급·제출 모두 `gameService.ts:111-118` — **401이면 1.1초 뒤 토큰 없이 재시도**, `notifyUnauthorized:false`라 알림 없이 익명 저장(침묵 익명화). 제출 자동 재시도는 401 받은 토큰을 다시 싣지 않음(:211-224). daily 전용 분기 없음(TetrisPlay.tsx:133 세 모드 같은 호출). 대전 소켓은 handshake auth.token 전송(BattleSocketContext.tsx:251-253)
- score 102 null 유력 경로: ① next-auth 세션은 살아 있는데 백엔드 JWT 만료·무효 → 401 → 익명 재시도 ② 비로그인 기기 ③ 보관분을 로그아웃 상태에서 재제출
- 백엔드 대조(메인): 세션은 발급 때 userId를 Redis에 보관하지만(`game-session.service.ts:12·62`) 제출 저장은 **제출 요청의 토큰 사용자만** 쓴다(`games.service.ts:304` → :375) — 세션은 로그인·제출은 익명이면 null. 대전은 제출 userId 없으면 입장 userId로 폴백(`tetris-battle-result.service.ts:409-410`) → 싱글만 폴백이 없다. JWT 만료 기본 30d(`auth.service.ts:41-42`, ENV로 조정)
- **스킨 구조**: 캔버스 색은 모듈 상수 — `T/lib/blockSprites.ts:10-20 CELL_COLORS`(7종+가비지), `effectsRenderer.ts:32 LEVEL_TINTS`·`:46 LEVEL_NEON`, `renderer.ts` 격자·게이지·라벨. 렌더러 하나(`TetrisCanvas` → `drawGame`)를 싱글·daily·도전장·리플레이·대전 내 판·대전 리플레이가 공유, 상대 보드만 `MiniBoard.tsx`(CELL_COLORS import + 배경 2값). 스프라이트 캐시 키에 팔레트 없음(blockSprites.ts:28-33) → 스킨 id를 키에 포함 필요. 색 값 약 50개(canvas), DOM은 Tailwind 색 클래스가 파일마다 하드코딩(CSS 변수 토큰 2개뿐)
- 설정 저장 선례: 전부 localStorage + `useSyncExternalStore`(`S/lib/soundSettings.ts` 'games:sound', 탭 간 storage 이벤트 구독). 서버 저장 선례 없음. 색은 렌더 층에만 있어 리플레이 결정성 무관

## 2026-10-26 — 백엔드 구현 (D-003)
- 커밋: fff54c8 userId 폴백 · 0cead1e 스킨 장착 테이블·카탈로그·API · 5940670 보드 주인 스킨(대전 방 상태·리플레이·경기 조회)
  - ⚠️ fff54c8 단독으로는 games.service.spec이 아직 없는 UserSkinService를 import해 컴파일되지 않는다(헝크 분리 실수, 0cead1e부터 정상) — 로컬 커밋이라 히스토리는 고치지 않음
- 구조: `src/modules/users/skin-catalog.ts`(슬롯·아이템·획득 방식 SSOT) · `UserSkinService`(장착 조회·부분 장착·보유 판정 자리 `isOwned`) · `USER_SKIN_EQUIPS`(PK USER_ID+SLOT, DB는 형식 CHECK만)
- 대전: 게이트웨이 `enterIdentity`가 create·join 때 `boardSkinsOf(userId)` → `StoredPlayer.skins` → `RoomPlayer.skins`. 자리 넘겨받기 때 갱신. 조회 실패는 default로 입장(로그 warn). 소켓 계약 파일(events.ts)은 프론트 사본 자급을 위해 Entity를 import하지 않고 `TetrisBattleBoardSkins`(문자열) 정의
- userId 폴백: `games.service.ts` 제출 저장 `userId ?? session.userId ?? null` — 단위 3케이스, 변이(폴백 제거) 시 실패 확인
- 검증: ci:core 1769 tests · lint 경고 6(기준선) · E2E 274 pass / 58 skip(Redis 필요) — 신규 `test/user-skins.e2e-spec.ts`(401·부분 장착·422 USER_SKIN_UNKNOWN·VALIDATION_ERROR·숫자 암묵 변환), 리플레이·경기 조회 skins, 게이트웨이 입장 신원 skins
- 메모: 숫자 `{ block: 3 }`은 전역 암묵 변환으로 "3"이 돼 VALIDATION_ERROR가 아니라 USER_SKIN_UNKNOWN(422) — 상태코드는 같다

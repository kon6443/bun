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

## 2026-10-26 — 마이그레이션 실행(사용자) · 스키마 확인
- 사용자 실행 `pnpm db:migrate:up` → CreateUserSkinEquips1792974597822 성공(18 → 19)
- `pnpm db:select` 확인: 컬럼 4개(USER_ID NUMBER · SLOT VARCHAR2(40) · SKIN_ID VARCHAR2(64) · UPDATED_AT TIMESTAMP(6) WITH TIME ZONE, 모두 NOT NULL) · 제약 PK_USER_SKIN_EQUIPS · FK_USER_SKIN_EQUIPS_USER(CASCADE) · SLOT_CK · SKIN_CK

## 2026-10-26 — 별건 조사: 모바일 대전 보드 크기 · D-pad 롱프레스 (프론트 세션, origin/main 기준 실측)
- 셀 규칙 `renderer.ts:50-59 cell = max(8, floor(min(W/17, H/22.5)))` — 가로 17칸(판 10 + 옆 패널 6 + 1). P9 게임보이 패드로 패드 높이 약 191 → 227px, 375×667 싱글 셀 18 → 16
- 대전은 상대 미니보드가 헤더 줄(BattleView.tsx:126-149)이라 세로 높이를 더 먹고, `useMiniCell`(:44-48)이 `min-width:640px`만 봐 가로 휴대폰에 데스크톱용 큰 미니보드 → **844×390 가로 대전은 셀 8(최소)로 판이 잘림(버그)**
- 실측 셀(px): 375×667 싱글 16 · 대전 1명 **12** · 3명 14 / 390×844 싱글 22 · 대전 1명 20 / 844×390 대전 1명 **8(잘림)**. 실기기 safe-area·실제 매치 화면(/battle/[code])은 미실측(preview 페이지로 측정)
- 개선안: A0 `useMiniCell`에 min-height 조건(가로 잘림 해소, 한 줄) · A 상대 미니보드를 판 옆 세로 줄로(높이 한계일 때만, 대전 1명 375 12→16, 가로 8→14) · B 패드 낮추기(HOLD 위치 변경 — 사용자 결정 필요, 375 싱글 16→18) · C 반투명 오버레이(판 가림, 비권장) · D 패드 크기 설정
- D-pad 롱프레스: CSS user-select·callout·onContextMenu는 적용돼 있으나 **touchstart 취소가 없음**(preventDefault는 pointerdown에서만 — 터치 기본 동작은 못 막음, iOS는 롱프레스에 contextmenu를 안 보냄). D-pad에서만 보이는 건 길게 누르는 조작이 ←→↓뿐이라서. 수정: 패드 루트에 touchstart `passive:false` 취소. iOS 실기기 판정은 미확정
- 진행: D-pad 수정은 사용자 요청("disable 처리")에 따라 프론트 진행 지시. 보드 크기는 사용자 결정 대기

## 2026-10-26 — 스킨 도감 API (D-005)
- cd92ad2 `GET /games/:gameType/skins`(OptionalJwtAuthGuard) → `UserSkinService.collection(userId|null)`. 게스트는 DB를 읽지 않고 owned·equipped false, DEFENSE 빈 목록, 모르는 게임 404
- 테스트: 단위(게스트·로그인 장착 표시·listSkins 3) · E2E(게스트 200, 실제 OptionalJwt 가드로 로그인 토큰 → 장착 표시, DEFENSE 빈 목록·pacman 404) · ci:core 1774 · lint 경고 6
- 프론트에 도감 페이지 지시(401 → D-pad → A0 → A 다음)

## 2026-10-26 — 프론트 401·D-pad·A0·A 완료 (로컬 커밋, 커밋마다 lint·typecheck·test:run 통과, 마지막 1665)
- 83865cd 401: 세션·제출 모두 토큰 없이 재시도 제거. 제출 401 → 보관 + "로그인이 만료됐어요. 다시 로그인하면 등록됩니다" + 재로그인 버튼(로그인 뒤 홈 보관분 재제출). 세션 401 → 등록 없이 플레이 안내. 재제출 401도 보관 유지. 대전 리플레이 제출의 같은 패턴은 유지 — 백엔드가 입장 userId로 폴백(`tetris-battle-result.service.ts:409-410`)
- ff2de48 D-pad: 십자(game-pad-dpad)에만 touchstart passive:false 취소(루트 → 십자로 축소: 오른쪽 버튼 :active 판정을 에뮬레이터로 못 해 위험 낮은 쪽). **iOS·Android 실기기 확인 필요**
- c31f8ac A0: useMiniCell `(min-width:640px) and (min-height:600px)` — 844×390 대전 잘림 해소(계산 8 → 10·12)
- 752062e A(세로 전용): 두 배치의 셀을 비교해 높이 한계일 때만 상대 미니보드를 판 왼쪽 세로 줄로. 실측(preview 봇 페이지, Chromium 에뮬): 375×667 1명 셀 12 → 17(+42%)·3명 14 → 17 · 390×664 1명 12 → 16·3명 14 → 16 · 390×844 20·22 그대로. 공격 궤적 시작점 = 미니보드 중심 ±1px(6경우)
- 남은 확인: RankedPlay.test ResizeObserver 미정의 간헐 실패 원인(프론트 조사 지시 — "부하" 결론 보류)

## 2026-10-26 — 백엔드 리뷰 라운드 1 (메인 review-flow + Opus 서브에이전트)
- 메인: 자리 생성·넘겨받기 4곳(newPlayer 520·663, takeOver 632·647) 모두 create·join 핸들러의 `enterIdentity` 경유 — 클라이언트 값으로 스킨이 들어가는 경로 없음. 스킨 조회는 rate limit 뒤
- Opus 확정 1(낮음) → **수정 f0234d8**: 토큰 갈래 takeOver가 소켓 계정 장착으로 자리 주인 스킨을 덮음(게스트 자리에 로그인 소켓·남의 자리에 다른 계정) + 조회 실패 default가 기존 값 덮음 → 같은 계정일 때만 갱신, 실패 시 skins 없이 전달. 테스트 4건(새 자리·같은 계정 재입장·다른 계정 토큰 재입장·옛 방) — 가드 제거 변이 시 실패 확인
- **수정 8487d08**: 여러 슬롯 장착을 한 트랜잭션으로(저장 중 DB 오류 시 일부만 반영 방지)
- 기각·보류:
  - 리플레이 GET의 소유자 조회 1회 추가 — 랭킹 항목 select(`RANKING_ITEM_SELECT`)는 USER_ID를 일부러 읽지 않는다(응답 누출 방지 설계) → 따로 읽는 현 구조 유지, 60초 캐시라 부담 작음
  - 입장 스킨 조회 타임아웃 — rate limit 뒤 1쿼리, DB가 느리면 다른 경로도 함께 느림 → 후속 후보
  - `{ block: null }` → 422 USER_SKIN_UNKNOWN(VALIDATION_ERROR 아님) — 상태코드 같음, 수용
  - 리플레이 캐시 60초 동안 이전 스킨 노출 — 공개 정보, 수용
- 검증: ci:core 1779 · lint 경고 6 · E2E 277 pass / 58 skip

## 2026-10-26 — 백엔드 리뷰 라운드 2·3 (Opus, 수정분)
- 라운드 2(f0234d8·8487d08): 정확성 확정 0. Oracle 문장 단위 롤백·TypeORM 미자동 롤백으로 트랜잭션 내 ORA-00001 → UPDATE 재시도 유효, 슬롯 고정 순서라 데드락 경로 없음. 지적 2건 → **ac2f844**: 같은 소켓 재입장도 같은 계정이면 스킨 갱신 · 장착 테스트의 트랜잭션 매니저 저장소를 별도 대역으로(우회 변이 5건 실패 확인)
- 라운드 3(ac2f844): 정확성 확정 0, 테스트 공백 1(같은 소켓 갈래 주인 조건) → **a39f966** 회귀 테스트 추가, 조건 제거 변이 시 실패 확인
- 백엔드 리뷰 종료: 마지막 라운드 정확성 확정 0 + 지적된 테스트 공백 보강

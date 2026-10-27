# 작업 기록 — 스킨 레벨·포인트 강화·새 스킨

> append-only. 목차는 `grep -n "^## "`.

## 2026-10-27 — 착수 조사 (메인)
- 운영 데이터(`pnpm db:select`, 읽기 전용): TETRIS 기록 137건(로그인 58 — 전부 USER_ID 1, 합계 4,222,137점, 숨김 0) · DEFENSE 3건(비로그인). 판당 점수 default 보드 중앙값 43,166 · 평균 66,081 · 최고 990,270
  - → 레벨 비용 기본안(누적 10만·30만·100만·300만)은 대략 2·7·23·70판. 소급하면 지금 사용자는 아이템 하나를 Lv5까지 올릴 수 있다
- 점수 신뢰: 싱글 제출은 서버가 리플레이를 재현해 점수를 정한다(`games.service.ts` verifyAndSave → `engine.verify`) — 포인트 원천으로 그대로 쓴다
- 스킨 스냅샷 경로(levels를 실을 곳): 세션 `skins`(`game-session.service.ts:34`) → `GAME_REPLAYS.BOARD_SKINS` · 대전 `StoredPlayer.skins` → 매치 Redis `p:{pid}:skins`(`tetris-battle-match.store.ts:392`) → `TETRIS_BATTLE_PLAYERS.BOARD_SKINS`. 모두 JSON 문자열 통과 + `parseBoardSkins` — levels를 객체에 더하면 저장 형식 변경 없이 실린다(VARCHAR2(400) 안)

## 2026-10-27 — 백엔드 구현 (D-002)
- 마이그레이션 `1793060509068-CreateUserSkinLevels`(PK USER_ID+SLOT+SKIN_ID, SKIN_LEVEL CHECK 2~5) · `1793060509069-CreateUserPointLedger`(IDENTITY PK, UNIQUE USER_ID+REASON+REF_KEY, AMOUNT<>0) + Entity `UserSkinLevel`·`UserPointLedger`
- `skin-catalog.ts`: clear·chocolate · `SKIN_LEVEL_COSTS`·`nextLevelCost` · `TetrisBoardSkins.levels` · `parseBoardSkins`가 levels 없거나 범위 밖이면 1 · `storedBoardSkins`(배포 전 Redis 방 상태의 levels 채움)
- `UserPointService.pointsOf`(GAME_SCORES 합계 + 원장, balance는 0 이상) · `spend`
- `UserSkinService`: getSkins(equippedLevels·points·catalog level/nextCost) · upgrade(USERS 행 `setLock('pessimistic_write')` getMany — row-limit 없음 → 레벨·잔액 확인 → 원장 → 레벨 저장) · collection(level·maxLevel·levelCosts·points) · boardSkinsOf(Many)에 levels
- `POST /users/me/skins/upgrade` · 제출 응답 `points`(잔액 조회 실패는 null, 201 유지)
- 검증: `pnpm ci:core` lint 0 errors/경고 6(기준선) · 단위 1830 · build / `pnpm test:e2e` 293 pass·58 skip / Redis E2E(`TETRIS_BATTLE_REDIS_TEST_PORT=6390`) 56 pass·2 skip
- 운영 영향 메모: `pnpm install`은 worktree에서 sandbox 밖으로 실행(의존 패키지의 `.vscode/settings.json` 쓰기가 sandbox에 막힘)

## 2026-10-27 — 리뷰 1라운드
| 리뷰어 | 확정 | 조치 |
|---|---|---|
| review-flow(메인) | 1 | 배포 순간 열려 있던 방의 자리 스킨에 levels 없음 → `storedBoardSkins`로 방 상태·매치 시작에서 Lv1 채움 + 회귀 테스트 |
| Opus 서브에이전트 | 1 (+PLAUSIBLE 2) | Swagger: upgrade 409 두 코드·404 USER_NOT_FOUND 명세 보강. PLAUSIBLE ① 포인트 합계 인덱스 없음(지금 TETRIS 137행 — 측정 전 최적화 보류, 후속 등재) ② 운영자가 레벨 행만 지우면 같은 REF_KEY 재강화가 ORA-00001 500(정상 흐름엔 없음, 후속 등재) |

## 2026-10-27 — 리뷰 2라운드 (종료)
| 리뷰어 | 확정 | 조치 |
|---|---|---|
| review-flow(메인) | 0 | 1라운드 수정분(`storedBoardSkins`·Swagger) 재확인 |
| Opus 서브에이전트(새 컨텍스트) | 0 | 보강 후보 ① 강화 테스트가 "레벨 조회가 잠금 뒤 tx 저장소"임을 고정하지 않음 → 호출 순서 단정 추가 ② 익명 제출이 세션 주인으로 폴백하면 응답 points.balance가 그 계정 잔액 — 세션 id = 주인 규칙(tetris-skins D-002)과 같아 유지 |

## 2026-10-27 — 원장 일원화 구현 (D-004)
- 마이그레이션 `1793060509070-AddUserPointLedgerMemo`(MEMO VARCHAR2(400 BYTE)) · `1793060509071-BackfillTetrisScorePoints`(INSERT…SELECT, NOT EXISTS로 재실행 안전)
- `UserPointService`: 원장 합계만(GameScore 의존 제거) · `record(manager, entry)` · `tetrisScorePointEntry`(소급 SQL과 같은 MEMO 형식 — `toLocaleString('en-US')` = Oracle `TO_CHAR(…,'999,999,999,990')`)
- 제출: 기록·리플레이 저장과 같은 트랜잭션에서 적립 줄(로그인 TETRIS·점수>0). 적립 실패 = 기록도 롤백 → 503 + 세션 복구
- 강화: 소비 줄에 MEMO(`block chocolate Lv2 강화`)
- 소급 SELECT 읽기 전용 실측(`db:select`): 60건 · 4,442,705P · 샘플 MEMO "테트리스 기록 #102 · daily-2026-10-24 보드 · 165,870점"
- 검증: ci:core 단위 1834 · lint 경고 6(기준선) / E2E 293 pass·58 skip / Redis E2E 56 pass·2 skip

## 2026-10-27 — 리뷰 3라운드 (D-004 변경분, 종료)
| 리뷰어 | 확정 | 조치 |
|---|---|---|
| review-flow(메인) | 0 | 제출 트랜잭션 실패 모드(원장 유니크는 새 SCORE_ID라 정상 경로에서 불가)·소급 SELECT 실측 |
| Opus 서브에이전트 | 0 (저심각 문서 2·테스트 공백 2) | …070에서 표·AMOUNT·REF_KEY 코멘트를 원장 설명으로 재작성 · Swagger 문구 D-004로 · 세션 주인 폴백 시 적립 줄 userId 단정 추가 · Redis E2E 스텁에 levels. 메모 형식의 SQL 쪽은 마이그레이션을 실행할 수 없어 `db:select` 실측으로 대신 확인(구조상 공백 수용) |
- 검증: ci:core 단위 1834 · lint 경고 6 / E2E(Redis 포함) 349 pass·2 skip

## 2026-10-27 — 포인트 내역 API (D-005)
- `UserPointService.history` — (CRTD_AT, LEDGER_ID) 내림차순 복합 keyset, beforeId는 그 줄의 (시각, id)를 꺼내는 핸들(없거나 남의 줄이면 빈 페이지) · `type=earn|spend` · `meta` · `nextCursor`
- 실데이터: 소급 줄은 id 순서와 시각 순서가 어긋난다(35→34→48) — 실서버 limit 3 두 페이지 61,57,49 → 35,34,48로 시각 순 연속 확인
- 검증: ci:core 단위 1841 / E2E(Redis 포함) 355 pass·2 skip

## 2026-10-27 — 로그인 브라우저 검증 (Playwright, Chrome CDP 9333 · 프론트 bfc15f1 dev 3000 · 백엔드 3500)
- 도감: 6종·Lv 배지·보유 포인트 4,442,705 P, pageerror 0
- 실제 강화(사용자 허용 D-003): 블록 chocolate Lv1→Lv2 — 토스트 "블록 초콜릿 Lv2 강화 완료!", 잔액 4,342,705 P, 원장 #61 `−100000 SKIN_UPGRADE TETRIS_BLOCK:chocolate:2 "block chocolate Lv2 강화"`, USER_SKIN_LEVELS Lv2. 같은 목표 재요청 200 무차감, Lv4 요청 409 USER_SKIN_LEVEL_MISMATCH(level 2)
- 확인 단계: 375·430 모두 "강화하기"가 하단 내비에 가리지 않음(elementFromPoint), 포커스 이동
- 설정 시트: 판 도중 강화 버튼 없음 + "판이 끝난 뒤 강화할 수 있어요." · 홈에서는 강화 가능
- 대전: 방 생성 roomState의 내 skins에 `levels {block:2}` 
- 리플레이: 레벨 이전 기록(#97) skins.levels 모두 1
- 싱글 결과(사용자 허용 — 운영 랭킹 등록): 214점 → 201 points {earned 214, balance 4,342,919}, 화면 "+214 P · 보유 4,342,919 P", 원장 #62 `+214 TETRIS_SCORE 164 "테트리스 기록 #164 · default 보드 · 214점"`, GAME_REPLAYS.BOARD_SKINS에 levels
- 스크린샷: scratchpad/shots-sl/

## 2026-10-27 — 리뷰 4라운드 (D-005 내역 API, 종료)
| 리뷰어 | 확정 | 조치 |
|---|---|---|
| review-flow(메인) | 0 | 실서버 두 페이지 연속 확인 |
| Opus 서브에이전트 | 0 (테스트 공백 2) | 쿼리 문자열→숫자 변환이 서비스까지 닿는지 E2E 추가(beforeId=61&limit=5&type=earn → findOne 내 줄·take 6·amount>0). 컨트롤러 spec 위임 테스트는 E2E가 대신해 생략 |
- 검증: ci:core 단위 1841 · lint 경고 6 / E2E(Redis 포함) 356 pass·2 skip · 프론트 bfc15f1 `next build` 통과(61/61)

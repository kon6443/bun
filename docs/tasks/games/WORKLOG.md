# 게임 모음집 · 테트리스 · 랭킹 — 작업 기록

> 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 절을 찾는다.

## 2026-10-21 — 착수: 브랜치·worktree
| 레포 | 로컬 `main` vs `origin/main` | 조치 |
|---|---|---|
| bun | 뒤처짐 6 (원래 작업 트리에 체크아웃 — 갱신 안 함) | `git fetch . origin/main:develop` (FF `e295de5..2684a28`) → `worktree add -b feat-onam-games .claude/worktrees/games develop` · `.env` → `../../../.env` 링크 |
| next-bun | 뒤처짐 5 (같음) | FF `ae05efd..5f75a80` → 같은 방식 · `.env` 링크 |
- next-bun 쓰기와 원격 fetch는 sandbox 밖에서 실행.
- 프론트 조사 요청(`next-bun-8b`): 낚시 라우트·BNB·렌더링 기반·결정적 엔진 위치·이름 입력 선례·추가 고려사항.

## 2026-10-21 — DB 버전 확인 (D-006 근거)
- `pnpm db:select "SELECT PRODUCT, VERSION_FULL FROM PRODUCT_COMPONENT_VERSION"` → `Oracle Database 19c Enterprise Edition` `19.33.0.1.0` — 네이티브 JSON 타입 없음(21c+), `IS JSON` 체크 제약·`JSON_VALUE`는 사용 가능

## 2026-10-21 — 프론트 조사 결과 (`next-bun-8b`, 조사만, worktree games @ 5f75a80)
- **낚시 라우트**: `/fishing`(`(game)/page.tsx`, route group) · `/fishing/about` · `/fishing/guide` · `/fishing/guide/[fishId]`. BNB 숨김은 `(game)/layout.tsx:18-23` `<style>`로 `nav[aria-label="주요 탐색"]` 숨김(aria-label 문자열 결합 — 깨지기 쉬움), viewport 줌 차단 `:4-10`, 소켓 `FishingSocketWrapper`(`:25`) → `io(${SOCKET_URL}/fishing)`(`FishingSocketContext.tsx:122`, 백엔드 namespace — 페이지 URL과 무관)
- **`/fishing` 참조 41곳**(테스트 제외): BNB(`BottomNavBar.tsx:77,80`) · 홈 CTA(`page.tsx:24`) · footer · TeamsLanding · sitemap(`sitemap.ts:10,24,30,36`, 도감 개별 URL 포함) · robots(`robots.ts:9`) · canonical 4 · JSON-LD breadcrumb 3 · 내부 링크 다수 · OG. `next.config.ts` redirects·middleware 없음
- **렌더링**: Canvas 2D 자체 구현, 게임 라이브러리 없음. 재사용 가능 — `useGameCanvas.ts:20-35`(DPR·resize) · `useGameLoop.ts:17-54`(rAF·visibility 정지) · ref/state 분리(`GameCanvas.tsx:65-78`). 재사용 불가 — 키보드 입력(동시 입력 해제 `useKeyboardInput.ts:70-71`, 회전·홀드 키 없음, DAS/ARR 없음), 터치 패드·스와이프 없음
- **결정성**: 시드 RNG 없음(`fishSpawn.ts`는 `Math.random`·`Date.now`). 제안 위치 `src/app/games/tetris/engine/`(순수 TS, vitest node). 조건: 정수 틱(60/s) + 누산기, `[frame, action]` 입력 로그, 32비트 시드 PRNG(mulberry32) + 7-bag, 정수 점수, `ENGINE_VERSION`
- **엔진 공유(프론트 의견)**: (가) 프론트 원본 → 백엔드 복사 + 골든 리플레이 픽스처 계약 테스트(소~중, 권장) / (나) 별도 패키지(중~대 — 레지스트리 인증·lockfile 정책) / (다) 모노레포(대)
- **이름 입력**: 선례는 마이페이지 닉네임(`mypage/page.tsx:98-108`, 20자·trim)뿐, 금칙어 처리 0건 → 서버 판정 권장. 로그인은 `userName` 프리필, 비로그인은 마지막 이름 localStorage
- **추가 고려(비용)**: 터치 가상 버튼(중) · 백그라운드 탭 일시정지 + 계속하기(소) · 개인 최고점 localStorage(소) · 사운드(중, 1차 제외 권장) · 세로 고정/가로 안내(소) · 키 매핑 `e.code` 기준(소) · 테트리스 전용 layout(줌 차단, 소켓 없음)(소) · 랭킹 화면 기간 탭(중) · 제출 실패 재시도(소) · Wake Lock(소, 선택) · `/games` 목록(소)
- → D-007·D-008

## 2026-10-21 — 리플레이 용량 추정 (D-010 근거)
- 가정: 블록 1개당 입력 이벤트 약 6개(이동 누름·뗌, 회전, 하드드롭). 이벤트 = `[deltaFrame, actionCode]` 정수 2개 ≈ JSON 텍스트 6바이트, gzip 후 약 1/3
- 추정(텍스트 → gzip):
  | 플레이 | 블록 수 | 이벤트 | 텍스트 | gzip |
  |---|---|---|---|---|
  | 초보 3분 | ~120 | ~720 | ~4KB | ~1~2KB |
  | 보통 10분 | ~400 | ~2,400 | ~15KB | ~5KB |
  | 고수 10분 | ~900 | ~5,400 | ~33KB | ~10KB |
  | 상한(입력 2만 개) | — | 20,000 | ~120KB | ~40KB |
- 1만 건 저장 시 gzip 기준 약 50MB(보통 플레이 가정). **추정치 — 구현 후 실제 리플레이로 실측해 이 표를 갱신**
- 현재 DB 사용량(`pnpm db:select` — `USER_SEGMENTS` 합계): **8.1MB**(세그먼트 105개). `USER_TS_QUOTAS`의 `DATA` 쿼터 조회값은 `MAX_BYTES`를 GB로 반올림해 0으로 표시됨 — 무제한(-1)인지 실제 0인지는 이 조회로 확정하지 못함(미확인)

## 2026-10-21 — S1 스키마 · 마이그레이션 실행 확인 (S1a)
- 파일: `migrations/1792564226000-CreateGameScores.ts` · `1792564227000-CreateGameReplays.ts` · Entity `GameScore`·`GameReplay` · `database.config.ts` 등록. build ✅ · 마이그레이션 별도 tsconfig tsc ✅
- 사용자가 games worktree에서 `pnpm db:migrate:up` 실행 → 두 마이그레이션 성공, 이력 8→10
- `pnpm db:select` 확인:
  - 컬럼: `GAME_SCORES` 10 · `GAME_REPLAYS` 6 — 타입·길이·NULL 허용이 DESIGN §1·§1-2와 일치
  - 제약 11개 ENABLED: PK 2 · `UK_GAME_SCORES_ID_TYPE` · CHECK 6(TYPE 2·SCORE·HIDDEN·DETAIL IS JSON·SEED) · FK `FK_GAME_SCORES_USER`(SET NULL) · `FK_GAME_REPLAYS_SCORE`(복합, CASCADE)
  - 인덱스: `IDX_GAME_SCORES_TYPE_SCORE (GAME_TYPE, SCORE DESC, SYS_EXTRACT_UTC(CRTD_AT))` · `IDX_GAME_SCORES_TYPE_CRTD (GAME_TYPE, SYS_EXTRACT_UTC(CRTD_AT))` — `TIMESTAMP WITH TIME ZONE` 컬럼은 Oracle이 UTC 추출 함수 기반으로 인덱싱한다(정상, `USER_IND_EXPRESSIONS`로 확인). `CRTD_AT` 범위 조건은 이 인덱스를 쓴다 — 실행계획은 S4 실API 때 확인
  - 코멘트: 테이블 2 · 컬럼 16/16 누락 0

## 2026-10-21 — S2 백엔드 모듈 작성 (엔진 사본 대기)
- 신규 `src/modules/games/`: `games.controller.ts`(세션·제출·랭킹·리플레이 4 라우트) · `games.service.ts` · `game-session.service.ts`(Redis `game:session:{id}`, GETDEL 1회용, 미연결 시 503) · `game-engine.registry.ts`(DI 토큰) · `tetris-game-engine.ts`(엔진 `simulateReplay` 감싸기) · `ranking-period.ts`(KST 경계) · `player-name-policy.ts`(금칙어) · `games.dto.ts` · `games-error.dto.ts` · `games.module.ts`
- `main.ts`: `GameSessionService.setRedisClient(redisAdapter.getPubClient())` (기존 OnlineUser·Fishing·TeamChat과 같은 방식) · `app.module.ts` 등록 · 상수 `GAME_*`·`THROTTLE_GAME_*`
- 단위 39/39(service 22 · ranking-period 9 · name-policy 11 중 실행분) — 엔진 사본(`src/modules/games/tetris-engine/`)이 없어 build·모듈 배선 spec·E2E는 S3a 후

## 2026-10-21 — S3a 엔진 사본 · 골든 계약 · 성능 · S2 완료
- 프론트 S3a 보고(`next-bun-8b`): 엔진 6파일(`constants`·`pieces`·`random`·`game`·`replay`·`index`) + 골든 19케이스(성공 15·실패 사유 4종), 프론트 테스트 61개, 규칙 세부(생성 x=3 y=18, 지연 6·20프레임, IRS/IHS 큐 16, 중력 정수 표·20G 상한, 소프트 ×20, 락 30·리셋 15, 3-코너 T-스핀, 백투백 `(p*3)>>1`, 콤보 50×콤보×레벨, PC 보너스 없음, 해시 400칸)
- 복사: `src/app/games/tetris/engine/{6파일, __fixtures__/golden-replays.json}` → `bun/src/modules/games/tetris-engine/` **수정 없이**(나중에 `diff -r`로 동기 확인). 픽스처 sha256 `02f6277c…837e` 양쪽 일치. 테스트 파일은 복사하지 않고 백엔드 jest `tetris-engine.golden.spec.ts` 별도
- 골든 계약 22/22 — 백엔드 사본이 프론트 원본과 같은 결과
- 성능(최악 실측 리플레이 212,253프레임·입력 38,844 — 프론트 제공 파일): 백엔드 Node v22.21.1 + tsx `simulateReplay` 최소 77.2 · 중앙값 77.8 · 최대 78.9ms(20회). 목표 200ms 이하 ✅. 본문 80.5KB, gzip 리플레이 **5.4KB**(용량 추정표보다 작음)
- 백엔드 검증: 모듈 배선 spec(User 제거 시 같은 DI 예외로 실패 확인) · 세션 spec · service spec · E2E 22/22(실제 엔진: 골든 제출 201·재사용 409·seed 불일치 422·빨리 감기 422·미종료 422·이름 INVALID/FORBIDDEN 후 같은 세션 재제출 201·413·형식 422)
- **발견·수정**: E2E 탐침에서 100kb 초과 본문이 500 `INTERNAL_SERVER_ERROR` — body-parser 오류가 `HttpException`이 아니라 전역 필터가 알 수 없는 예외로 처리. 필터에 http-errors(`expose: true` 4xx) 분기 추가, 필터 spec +4(39/39) → D-014
- 프론트 S3b 질의 답(인증 주체 불일치 허용, 이름 전용 코드, 413 code, 입력 상한 상향) → D-014. 프론트에 `MAX_INPUT_LENGTH` 120,000 변경·픽스처 재생성 요청
- 단위 333/333(관련 범위) · lint 0 errors/경고 6 · stubs ✅ · build ✅

## 2026-10-21 — 리뷰 1라운드 (백엔드: 메인 review-flow + Opus 5.5)
| 지적 | 등급 | 교차검증 | 조치 |
|---|---|---|---|
| L1 목록 동점 `CRTD_AT` vs `rankOf` `SCORE_ID` — 응답·재생 순위 ≠ 목록 순위 가능, 조건 문자열 미단정 | low | 코드 대조 확인 | 동점 `SCORE_ID` 단일화 + 조건 문자열 단정 테스트 |
| L2 Swagger: 이름 INVALID·413·replay 400·401 누락 | low | 확인 | 명시 (DESIGN §3 표도) |
| L3 만료·무효 토큰 401 | low | 확인 — 공통 가드 동작 | 유지, Swagger 401 + 프론트 재시도(D-014) |
| L4 커밋 후 순위 계산 실패 → 500 → 재시도 409로 결과 유실 | low | 확인 | `ranks: null`로 201 유지 + 테스트 |
| L5 필터 변경 후 415가 `UNKNOWN_ERROR` | low | http-errors `expose` 규칙 확인 | 415 `UNSUPPORTED_MEDIA_TYPE` + 필터 spec |
| L6 DESIGN "유리한 seed 못 고름" 틀림 | low(문서) | 확인 — seed 응답 노출 | 문구 정정, 위험 수용 명시 |
- 메인 추가 확인: 운영 Redis `redis:7-alpine`(GETDEL 6.2+ 지원, `infra/docker-stack.yml:52`), `maxmemory 128mb` + `allkeys-lru` → 세션 퇴출 위험 수용(D-015). 로컬 6379는 다른 프로젝트 Redis(NOAUTH), `bun-redis` 6380 PONG — 실검증은 `REDIS_PORT=6380`
- 조치 후: games·filters 120/120 · build ✅ → R2

## 2026-10-21 — 리뷰 2라운드 (백엔드)
- R1 조치 재검증: 4건 모두 정상, 되돌리면 테스트 실패(TypeORM Oracle 같은 이름 바인드 `:score` 2회도 ORA-01008 없음 확인)
- 확정 결함 0(런타임·보안·정합성). 문서·테스트 Low 2:
  | 지적 | 교차검증 | 조치 |
  |---|---|---|
  | JSON 문법 오류는 Nest가 필터 전 `BadRequestException`으로 변환 → D-014·필터 주석·spec의 "원문 비노출 400(기존 500)" 서술이 틀림 | E2E로 400 `BAD_REQUEST` 실측 | D-016 정정, 주석·spec 수정, E2E 고정 |
  | 300kb 한도를 판별하는 테스트 없음(413 케이스 본문 480KB는 100kb로도 413) | 확인 | E2E 약 150KB 본문 → 409(413 아님) 추가. 한도를 되돌리면 이 테스트가 실패함을 확인 |
- 프론트 질의(스로틀): 401 첫 요청도 전역 스로틀에 집계, 만료 토큰은 `req.ip` 키 → 제출(초당 1) 즉시 재시도는 429 → 프론트 재시도 전 1.1초 대기 (`custom-throttler.guard.ts:42-65`)
- 조치 후: filters 39/39 · E2E games 24/24 → R3

## 2026-10-21 — 리뷰 3라운드(백엔드) · S4 실API · Playwright 1차
- **리뷰 R3**: 확정 1(low) — `replay` 누락·배열이면 `@ValidateNested`가 검증을 건너뛰어 세션 GETDEL 후 500(누락)·409(배열). 조치: `@IsDefined` + `@IsObject`, E2E 3케이스(누락·배열·null → 422 + 세션 유지 단정). 수정 전 코드에서 누락·배열 2케이스 실패 확인. E2E games 27/27
- **서버 기동**: games worktree `REDIS_PORT=6380 pnpm dev`(bun-redis — 6379는 다른 프로젝트 Redis NOAUTH) · 프론트 `pnpm dev`(3000). 피드백 worktree 프론트 dev(3000)는 종료
- **실API 21/21** (`scratchpad/e2e/games-api.ts` — 엔진 사본으로 봇이 서버 seed로 실제 판 생성): 비로그인 세션 201 · 금칙어 422 FORBIDDEN → 형식 422 INVALID → 같은 세션 201(서버 점수 = 로컬 재현) · detail 키 · 재사용 409 · seed 불일치 422 · 빨리 감기(123초 판 즉시) 422 · score 주입 422 · 로그인 등록 201 · 랭킹 3기간 정렬·민감 필드 없음 · 리플레이 재시뮬레이션 점수 일치 · 404·422(limit)·413 · 세션 발급 스로틀 429
  - 테스트 스크립트 결함 2건(앱 결함 아님): ① 봇이 `ACTION.LEFT_DOWN`(실제 이름 `LEFT_PRESS`)을 써 undefined 코드 → 서버가 정상 거부 ② "목록 순위 = 등록 응답 순위"는 이후 더 높은 기록 등록으로 순위가 밀린 것(ID 2 622점 > ID 1 554점)
  - DB(`pnpm db:select`): 이름 정규화(`"  E2E   테트1 "` → `E2E 테트1`) · 비로그인 USER_ID NULL·로그인 1 · IP_HASH 64 · SEED 2585611723(2³¹ 초과) 정상 · 리플레이 gzip 107B. `DBMS_LOB` 호출은 db:select 가드가 거부(정상) → `LENGTH(BLOB)`로 조회
  - ID 3(`권오남_OnamKwon`, USER_ID 1, 17:13 KST)은 사용자 직접 플레이(사용자 확인) — 테스트 데이터 정리 대상 아님
- **Playwright 1차** (`scratchpad/e2e/games-ui.mjs`): 데스크톱 17/18 · 모바일 7/7
  - 통과: /games 카드·BNB 게임 탭 활성 · /fishing BNB 숨김·나가기 → /games · 플레이 BNB 숨김 · Esc·창 blur 자동 일시정지 · 키보드(←→ZXC↑Space) 플레이 → GAME OVER · 금칙어 422 후 같은 세션 201(바디 score 없음) · 등록 후 서버 순위·다시보기 · 리플레이 BNB 숨김·끝까지 재생 점수 일치·Home 탐색 · 랭킹 3탭 aria-pressed · 모바일 BNB 375·320 잘림 없음 · 가상 버튼 8개 ≥44px · 375px 스크롤 없음 · 터치 하드드롭 → GAME OVER · 비로그인 등록 201
  - **결함(프론트)**: 게임 오버 예상 순위 rankings 요청이 중복(1회 게임 오버에 5~6요청) → 전역 스로틀(초당 5) 429 → 오늘 예상 순위 누락 가능. 리플레이 "다시보기" 진입 시 replay GET 2회. 플레이 화면 `main` 중첩(접근성). → `next-bun-8b`에 수정 요청

## 2026-10-21 — 리뷰 4라운드(백엔드) · 프론트 수정 · Playwright 최종
- **백엔드 R4**: 확정 결함 0 → 백엔드 루프 종료(R1 6 low → R2 문서·테스트 2 → R3 1 low → R4 0). 실서버 확인: replay 누락·배열·문자열 inputs → 422, 세션 소모 후 500 경로 없음, `scores/abc/replay` 400, rankings 응답에 IP_HASH·USER_ID 없음
- **프론트 수정**(`next-bun-8b`): ① 게임 오버 예상 순위 — dev StrictMode effect 이중 실행이 원인(재현 확인), ref 가드로 패널당 1회 + 실패 시 "—"(재시도 없음) ② 리플레이 — `lib/replayLoader.ts`로 같은 scoreId 요청 공유·최근 3개 캐시 ③ 플레이·리플레이 안쪽 `main` → `div`. 프론트 test 481 · typecheck·lint 0
- **Playwright 최종 29/29 × 2회 연속**: 1차 결과 + 회귀 확인(게임 오버 1회 → rankings 3요청 모두 200 · 다시보기 진입 → replay 1회 · 플레이·리플레이 화면 main 1개). 1차 직후 1회 모바일 탭 타임아웃은 재현 안 됨(단독·연속 2회 통과, 실패 스크린샷 0)
- **백엔드 ci:all**: lint 0 errors/경고 6 · stubs ✅ · 단위 969 · E2E 160 통과(2 skip Redis) · build ✅. 엔진 사본 `diff -r` 동기 ✅
- 정리: 엔진 사본 폴더에 생긴 빈 `.claude/.cc-writes`(하네스 메타 — 셸 작업 디렉토리가 잠시 그 폴더였음) 제거. 피드백·게임 백엔드 dev 서버 종료(ci 빌드가 `dist/` 공유), 게임 프론트 dev(3000)는 유지
- 테스트 데이터(운영 DB): `GAME_SCORES` ID 1·2·4~11(`E2E` 이름) — ID 3은 사용자 실제 플레이. 삭제는 사용자 SQL(리플레이는 FK CASCADE)

## 2026-10-21 — 리뷰 방식 미준수 정정 · 테스트 데이터 유지
- 사용자 확인 질문("내가 맨날 요청하던 방식?")으로 확인: 백엔드 리뷰 R1~R4는 **Opus 5.5 서브에이전트 1명만** 돌렸고 프로젝트 `review-flow` 리뷰어를 빠뜨렸다(메인 교차검증은 리뷰어로 치지 않음). 프론트는 review-front + Opus 두 리뷰어로 준수. → 백엔드 R5부터 `review-flow` + Opus 병행, 둘 다 확정 0까지 재실행. 교훈은 auto memory `feedback_review_loop_method.md`
- 사용자 지시: 테스트 데이터(GAME_SCORES ID 1·2·4~11) **삭제하지 않음**

## 2026-10-21 — 리뷰 5라운드 (백엔드 — 처음으로 review-flow + Opus 두 리뷰어)
| 지적 | 리뷰어 | 교차검증 | 조치 |
|---|---|---|---|
| JSON 파서가 CORS·helmet보다 먼저 등록 → 400·413·415에 CORS·보안 헤더 없음(모든 JSON 라우트) | 둘 다(독립) | 최소 앱 재현: 앞 등록 ACAO 없음·CSP 없음 / 뒤 등록 둘 다 있음 | `setGlobalPrefix` 앞으로 이동 + 주석 → D-017 |
| README에 games 모듈·테이블 2·env `GAME_IP_HASH_SECRET`·Redis 게임 세션 의존 누락 | 둘 다 | `git diff -- README.md` 비어 있음 확인 | README 갱신(ci 기준선은 최종 실측 후) |
- review-flow 참고(결함 아님): `GameReplay`는 PK 지정 `save`라 INSERT 전 SELECT 1회 — 유지
- 필터 변경 영향 범위(review-flow grep): 전역 필터 등록 2곳(APP_FILTER·E2E), WS는 별도 필터, `expose` 4xx 오류 출처는 express 파서뿐 — 바뀌는 응답은 413·415·aborted 400(모두 기존 500)
- 조치 후: build ✅ · E2E games 27/27 → 실서버 CORS 확인 → R6(두 리뷰어)

## 2026-10-21 — 리뷰 6라운드 · 백엔드 루프 종료 · 최종 실검증
- **R6 (review-flow + Opus)**: 두 리뷰어 모두 확정 결함 0 → 백엔드 루프 종료(올바른 두 리뷰어 방식 기준 R5 2건 → R6 0)
  - Opus in-process 재현: 미들웨어 스택 `cors → helmet → cookieParser → compression → jsonParser → urlencoded`, jsonParser 1개(기본 100kb 중복 없음), 320KB 413·깨진 JSON 400·euc-kr 415 모두 CORS·helmet 헤더, 200KB 201
  - 실서버(메인): `Origin: http://localhost:3000`으로 413·400 → `Access-Control-Allow-Origin`·CSP 헤더 확인
  - 결함 아님 참고: 세션 소모 후 DB 트랜잭션 장애 시 500(GETDEL 선소모의 귀결, 장애 시에만), JSON 문법 오류 message 영어 원문(D-016)
- **최종 실검증**(D-017 반영 서버): Playwright 29/29 · 실API 24/24(이번엔 "목록 순위 = 응답 순위"까지 통과)
- **백엔드 ci:all**: lint 0 errors/경고 6 · stubs ✅ · 단위 969 · E2E 160(2 skip) · build ✅ → README 기준선 갱신. 엔진 사본 `diff -r` 동기 ✅
- 테스트 데이터는 사용자 지시로 유지(이번 실행으로 GAME_SCORES ID 12~15 추가)

## 2026-10-21 — Redis 장애 시 동작 실측 (사용자 질문)
- 백엔드를 연결 불가 Redis(`REDIS_PORT=6399`)로 기동: `Nest application successfully started` · 경고 "Redis 연결 실패 - HTTP는 정상 작동" · health 200 · 랭킹 조회 200 · 리플레이 조회 200 · 세션 발급 503 `GAME_SESSION_UNAVAILABLE`(설계대로)
- 프론트(Playwright): 세션 발급 실패에도 시작 → 플레이 → GAME OVER까지 진행, 패널에 "지금은 랭킹 등록을 준비할 수 없습니다. 플레이는 그대로 할 수 있어요." 표시·등록 버튼 없음
- 결론: Redis가 없어도 서비스·테트리스 플레이·랭킹·리플레이 조회는 동작, 랭킹 등록만 불가

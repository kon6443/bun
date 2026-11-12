# 포트리스(턴제 포격 대전) — 작업 기록

> append-only. 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 절을 찾는다.

## 2026-10-27 — 착수: 브랜치·조사 지시
- 로컬 `main`이 `origin/main`보다 275커밋 뒤처져 있었다 → 문서 브랜치 `docs-onam-fortress-plan`을 `origin/main` `6f20fed`(skin-levels 배포 머지 포함)에서 땄다. 로컬 `main`은 건드리지 않음
  - sandbox가 `.git/config` 쓰기를 막아 `git switch -c X origin/main`이 upstream 설정 단계에서 실패하고 HEAD만 남는 상태가 됐다 → `--no-track`으로 다시 만들어 해결. `git fetch`는 SSH 키 접근 때문에 sandbox 밖에서 실행
- 프론트 `next-bun-c4`에 조사 지시(수정 금지): 게임 홈·메뉴 구조, 공용화 현황 분류, 새 게임 재사용 목록·규모, 엔진 공유 도구, canvas 렌더링·모바일 관례, 로그인 유도 지점
- 진행 중 관련 작업: `../skin-levels/`(배포됨) · `../tetris-home/`(프론트 `next-bun-35` 구현 중) — 포트리스는 이 둘의 파일을 건드리지 않는다

## 2026-10-27 — 백엔드 재사용 조사 (codebase-investigator, 핵심 값은 메인이 원본 재확인)
- **방 라이프사이클은 게임 무관하게 재사용 가능**, 단 파일이 테트리스 매치와 한 덩어리
  - 그대로: 방 CAS(`tetris-battle-room.service.ts:92-110` Lua, `:1431-1470`) · 방 코드·비밀번호 scrypt·시도 제한·playerToken(`tetris-battle-room-tokens.ts`) · 준비·방장 이양·강퇴·시작 조건 · `WAITING/PLAYING/RESULT`·재대결 · 끊김 유예 10초·하트비트 · 로비 목록·요약 캐시 · WS 가드(게스트 강등)
  - 일반화 필요: 플레이어에 `skins`(테트리스 보드 스킨)가 박혀 있음(`:1622-1645`) · `MatchEvents`에 KO·가비지 · 게이트웨이 핸들러 중 LOCK·TOP_OUT·GARBAGE·ATTACK·OPPONENT_UPDATE만 전용
  - 전용(재사용 불가): 매치 스토어 Lua(lock·가비지·서버 프레임 시계) · lock/topOut 검증 · 결과 테이블 컬럼(kos·sent·received…)
  - 패턴 복사 가능: 제출 Hash·마감·`:saved NX` 저장 가드·`pending-saves` ZSET, 저장 크론 `ENV∈{QA,PROD} && TASK_SLOT===1`
  - 확인: `ROOM_MIN_PLAYERS = 2`·`ROOM_MAX_PLAYERS = 4`(`tetris-battle.events.ts:338-339`) — 포트리스 요구와 같다. 경기 중 생존자 채팅 금지(`tetris-battle-room.service.ts:1384-1387`) — 턴제는 정책 재결정
  - "초대 토큰"은 없다 — 초대는 방 코드 6자 링크
- **games 모듈(싱글·랭킹)**: 레지스트리(`game-engine.registry.ts`)로 잘 일반화됨. 새 GAME_TYPE = `GAME_TYPES` 추가(`src/entities/GameScore.ts:5`) + CHECK 교체 마이그레이션(디펜스 `1792591420000-AlterGameTypeCheckAddDefense.ts` 복사) + 엔진 사본·레지스트리 항목 + 매니페스트/골든 테스트. 입력은 `number[]` 고정이라 턴 입력을 정수 배열로 인코딩
  - 시간 검사(`games.service.ts:296-297` frames/ticksPerSecond ≤ 경과+5초)는 턴제 싱글에선 거의 무의미 — 다른 방어(중복 해시·IP 해시·스로틀)에 기댄다
- **포인트·스킨은 테트리스에 묶임**: 적립 `games.service.ts:445` · 응답 points `:359` · 스킨 도감 `:237` · 세션 스킨 `:559` 모두 `'TETRIS'` 분기(메인 grep 재확인). 원장 테이블 자체는 게임 무관
- **턴제에 맞지 않는 전제**: 테트리스 대전은 "각자 자기 판 시뮬 + 사후 리플레이 검증(클라이언트 신뢰)" 모델. 포트리스는 지형·상태를 공유하므로 **서버가 턴마다 결정적 엔진으로 결과를 확정**하는 모델이 맞다 → 사후 검증·가비지 채널·KO 경합 처리 불필요
- 미확인(구현 착수 전 메인이 직접 읽을 곳): `tetris-battle-room.service.ts:1163-1290`(방↔매치 전이) · `tetris-battle-match.store.ts:200-667`(제출·마감 Lua) · `tetris-battle.gateway.ts:167-575`(직렬화 큐·이탈 흐름)

## 2026-10-27 — 프론트 조사 보고 (`next-bun-c4`, origin/main `b4dacaa` 스냅샷, 수정 없음)
> 경로는 next-bun `src/app/games/` 기준. 홈 개편 브랜치(`feat-onam-tetris-home`)는 미커밋 24파일이라 바뀔 수 있음.
- **1인용 기록 게임 뼈대는 GameType 제네릭으로 공용화됨**(디펜스가 선례): `types/game.ts:7` `GameType = 'tetris' | 'defense'` · `_shared/lib/gameConfig.ts` `GameUiConfig<G>`
  - 공용: `RankingsView<G>`(`_shared/components/RankingsView.tsx:84`) · 명예의 전당·인기 리플레이 · `ScoreSubmitPanel<G>`(`:75`) · `createGameStorage<G>`(`_shared/lib/storage.ts:77`) · 카톡·OG(`shareSpec.ts:20` `ReplayShareSpec<D>`, `ogCard.tsx`) · 재생기 조각(fixedStep·HighlightRail·replayLoader) · 설정 시트 틀 · `GamePad`(`PadSlot` 4종 고정 `:22`) · `ReloginButton` · 세션/제출 API(`services/gameService.ts:123` `REPLAY_BODY_BUILDERS` 한 곳 분기) · 전체화면 판정(`gamesPaths.ts:14` `/games/{key}/(play|replays)` 게임 무관)
  - 새 게임 추가 비용(1인용 축): 수정 5~7(GameType·*ByGame 맵 3개·REPLAY_BODY_BUILDERS·`/games` 카드 `page.tsx:27`·`sitemap.ts:42-66`·대전 경로면 `gamesPaths.ts:23`) + 신규 4~5(GameUiConfig·ShareSpec·og route·fullscreen layout)
- **테트리스에 박힌 것**: 대전 일체(`types/tetrisBattleSocket.ts:9` namespace 고정, `BattleSocketContext.tsx:251`, `tetrisBattleService.ts`, 로비 `BattleLobby:152` 경로 하드코딩, 대기실·플레이 화면이 테트리스 엔진·렌더러 직접 import) — battle-ui 약 9.4천 줄 중 `_shared` import 4개뿐 · 도전장(`gameService.ts:166` "테트리스만") · 스킨 도감·장착 · 포인트(브랜치) · 재생기 본체(테트리스 527줄·디펜스 422줄 각자)
  - 채팅·이모트·연결 배지는 엔진 import 없이 소켓 타입(`CHAT_TEXT_MAX_LENGTH`·`TetrisBattleEmoteId`)만 의존 → 제네릭화 비용 작음
- **홈 구조**: main 테트리스 홈은 2단 카드(`TetrisHome.tsx:128`), 디펜스 허브는 헤더→이어하기·도감→랭크 카드→캠페인 맵→소개. 개편안(브랜치 `TetrisHome.tsx:170` 주석): 상단 바 → 플레이(시작+데일리) → 친구와 대전 → 내 스킨 한 줄 → 기록 탭(`TetrisRecordsCard.tsx:11` 오늘 랭킹/인기 리플레이/최근 대전) → 링크 줄(도감·포인트 내역)·소개 접기
- **엔진 공유**: 자동 복사 없음, 해시 대조. 테트리스는 손 목록 `engine-copy-hashes.json`, 디펜스는 폴더 스캔 매니페스트(`defense/engine-dev/manifest.ts:51` root 인자) + 순수성 ESLint(`eslint.config.mjs:14-17` Math는 imul·min·max·abs·floor·trunc만, 부동소수 리터럴·`**`·Map/Set·Date·JSON 금지) + tokenScan + 버전 동결(`engine-versions/`). 새 게임은 디펜스 방식을 복제가 기준. 게임명 하드코딩: ESLint 글롭·env 이름·CI SLOW_TESTS(`oci_build_and_deploy_next.yml:35`)
- **렌더링**: 테트리스는 고정 그리드 캔버스 1장, 디펜스는 bg/fg 2장 + `fitViewport` 레터박스(카메라·줌 없음) + 품질 자동 하향(7ms 예산). 모바일: `GameSurface.tsx:15-16` fixed·touchAction none, safe-area, GamePad pointer capture
  - **포격 고유 요소는 전례 0**: 픽셀 지형 파괴(getImageData·OffscreenCanvas 0건) · 월드>화면 카메라·팬·핀치 줌(0건) · 드래그 조준·파워 게이지(PadSlot·4방향 입력과 안 맞음) · 정수 탄도(sin/cos/sqrt 금지 → 각도 정수 표·고정소수·`isqrt` `defense/engine/geometry.ts`). 지형 `Uint8Array`가 ESLint·tokenScan에 허용되는지 미확인
- **로그인 유도 현황**: 기조가 "로그인 없이도 가능"(`page.tsx:30`, `TetrisHome.tsx:144`). 적극 유도는 스킨뿐(`MySkinCard.tsx:28` "로그인하고 스킨 꾸미기", `SkinSettingsSection.tsx:62-63`, 🔒). 디펜스·랭킹·리플레이·대전엔 유도 없음. 브랜치에서 포인트 문구 추가, 단 게스트에게 "로그인했다면 +N P" 대조 문구는 없음(`ScoreSubmitPanel.tsx:252-254` 로그인 등록만 +N P)
- 프론트 의견: 대전 공통층(방·로비·대기실·초대·채팅·이모트·배지)과 게임 페이로드 분리 리팩터를 별도 태스크로, 백엔드 소켓 설계와 묶어 결정 · 엔진은 디펜스 규약 복제 + 지형 해시·리플레이 크기·틱 비용 PoC 먼저 · 매니페스트·tokenScan `_shared/engine-tools` 공용화는 선택

## 2026-10-27 — 구현 착수 (D-007)
- 백 worktree 2개: `.claude/worktrees/fortress`(`feat-onam-fortress`, 문서·이후 F1b·F4) · `.claude/worktrees/game-room`(`refactor-onam-game-room`, F3 단독 PR). 둘 다 `origin/main` `6f20fed`, `--no-track`(sandbox가 `.git/config` 쓰기를 막음)
- 원 작업 트리는 `main`으로 되돌림. 빈 브랜치 `docs-onam-fortress-plan`(커밋 없음, `origin/main`과 같은 커밋)은 `branch -D`가 사용자 승인 대상이라 남겨 둠
- F1 지시 → `next-bun-c4`: §10 계약 검토 회신 먼저, 이후 엔진 원본·골든·AI·PoC 측정·핫시트 프로토타입
- F3a(방 부품 추출, 행동 변경 0) → 서브에이전트에 구현 위임, game-room worktree. 게이트: 기존 spec 무수정·Redis E2E(6390 `bun-redis-test` 가동 확인)·키 문자열 불변. 결과는 메인이 diff·검증 재실행으로 확인

## 2026-10-27 — F1 1~4단계 보고 (`next-bun-c4`, 미커밋, next-bun `feat-onam-fortress` base `b4dacaa`)
- 파일: `src/app/games/fortress/engine/`(constants·random·math·terrain·data(탱크 3·무기 6)·maps(hills·canyon)·state·sim·game·hash·replay·index·`__fixtures__/golden-matches.json`) · `engine-dev/`(manifest·tokenScan(typed array 금지 포함)·golden 생성·perf) · `engine-versions/` · `ai/chooseTurn.ts` · `eslint.config.mjs` FORTRESS_PURE_FILES 블록(디펜스 블록 무변경, 비트 연산은 `fortress/engine/random.ts`만)
- 검증(프론트 보고): vitest fortress 67 통과(생성기 2 env skip) — 골든 21케이스, 턴마다 JSON 왕복 해시 동일, deepFreeze 입력 불변, 구조 공유, previewShot 첫 착탄 = applyAction 첫 explode(50건+), 팀 교대 A1 B1 A1 B2. 골든 재생성 바이트 동일(sha256 `ecb63315…`). lint 0·typecheck 통과. ci:core·build는 5단계 후
- PoC 측정(plain Node 22 / vitest):
  | 항목 | 값 |
  |---|---|
  | applyAction 최악 | 분열탄 0.37ms(0.56) · 3연발 0.36 · 포탄 0.23 · 나머지 ≤ 0.07 |
  | stateHash | 0.09ms |
  | state JSON | 초기 23.1~24.5KB · 4인 경기 끝 최대 25.6KB |
  | 열당 구간(4인 4판 8,192열) | 0쌍 222 · 1쌍 7,043 · 2쌍 892 · 3쌍 33 · 4쌍 2 (상한 8 여유) |
  | 리플레이 | 4인 AI 실경기 41행동 2.7KB · 상한 120턴 7.8KB |
  | AI chooseTurn | 하 0.5ms · 중 9.3ms · 상 14.2ms(최대 16.3) |
  - 재현: `FORTRESS_PERF=1 pnpm exec vitest run src/app/games/fortress/engine-dev/perf.test.ts`
- 메인 판단: 서버 턴 처리 동기(워커 풀 불필요) · AI Web Worker 불필요(모바일 실측은 5단계) · 계약 구체화 9항목 채택(D-009)

## 2026-10-27 — F3a 방 부품 추출 완료·리뷰 (백, `refactor-onam-game-room`, 미커밋)
- 구현(서브에이전트): 신규 `src/modules/game-room/` — `game-room-keys.ts`(접두사 → 키 9종) · `game-room.store.ts`(CAS Lua·load·compareAndSet·로비 스캔·tail sweep·로비 요약 캐시, 제네릭) · `game-room-secrets.ts`(방 코드·playerToken·scrypt·실패 잠금 → `'OK'|'LOCKED'|'WRONG'`) · `game-room-text.ts` · `game-room-rate-limit.ts`(fail-open) · `game-room-presence.ts` + spec 5개. 변경: `tetris-battle.constants.ts`(`TETRIS_BATTLE_ROOM_KEYS`) · `tetris-battle-room-tokens.ts`(얇은 래퍼, export 유지) · `tetris-battle-room.service.ts`(+67/−207, 라이프사이클·매치 본문 무변경). 공용 부품은 판정만 돌려주고 에러 코드 변환은 게임 쪽
- 메인 재확인: 키 9종 문자열 = HEAD · Lua 본문 461바이트 동일 · 기존 spec·test 수정 0(`git diff --name-only -- src/ test/`)
- 리뷰: review-flow(메인) 확정 0 · Opus 서브에이전트 확정 0·의심 0, 경미 3 + 새 spec 탐지 공백 9(사본 변이 25개 중 9개 생존)
  - 반영: 금지 문자 정규식이 리터럴 bidi 문자로 바뀌어 있던 것을 원본과 같은 `\u` 이스케이프로 복원(글자 단위로 HEAD와 같음) · spec 보강 3종 — EXPIRE `NX` 단언, 복원 MULTI 실패해도 `'OK'`+warn, bidi 금지 12자 `it.each`. 메인이 변이를 직접 넣어 셋 다 실패함을 확인 후 원복(`cmp` 동일)
  - 수용: `scanLobby`에서 `pruneDisconnected`가 throw하는 비정상 JSON일 때만 인덱스 정리가 503 전에 먼저 일어남(응답·키 영향 없음) · 나머지 생존 변이(로그 문구·salt/keyLength 인자 순서 등)는 행동 영향이 작아 보강하지 않음
- 검증(메인, 최종): `pnpm ci:core` exit 0 — lint 0 errors/경고 6(기준선 동일) · 단위 81 스위트 1895/1895 · typecheck·build 통과 · `TETRIS_BATTLE_REDIS_TEST_PORT=6390 pnpm test:e2e --testPathPatterns tetris-battle`(sandbox 밖) 5 스위트 105/105, skip 0
- 미실행: `pnpm dev` 부팅·배선 spec — 새 Nest 모듈·DI 변경이 없어 해당 없음(F3b에서 공용 모듈이 생기면 필요)

## 2026-10-27 — F1 5단계(프로토타입·수치 조정) 보고 · F1b 엔진 사본

### F1 5단계 — `next-bun-c4` 보고 요지 (프론트 세션 책임, 미커밋)
- 위치: next-bun worktree `.claude/worktrees/fortress` `feat-onam-fortress`(origin/main `b4dacaa`) — `eslint.config.mjs`(+28) · 신규 `src/app/games/fortress/` 39파일
- **수치 조정표**(최종값은 엔진 `data.ts`·`constants.ts`):

| 항목 | 초안 → 최종 | 이유 |
|---|---|---|
| SPEED_PER_POWER | 320 → 360(파워 100 = 틱당 36px) | 2인 양 끝(약 1,730px)이 사거리 밖. 최대 사거리 약 2,160px |
| 3연발 | 반경 24·피해 14·간격 3° → 28·18·2° | 원거리 발당 평균 2.4 → 3.8. AI 조준 한계라 유지 |
| 분열탄(필살) | 부모 0/0, 자탄 간격 1500·피해 18 → 부모 30/16, 간격 700, 자탄 16 | 리뷰 확정 버그(최고점 전 착탄 시 반경 0 폭발로 쿨다운만 소모, 약 15%). 평균 19.3 |
| 메가탄(필살) | 반경 100·피해 60 → 90·50 | 평균 41.8 → 33(HP 90~120 두 발 확정 사망 완화) |
| 유지 | 포탄 36/30 · 대형탄 56/40(속도 88%) · 폭격 부모 20/10 + 5×(32/20, 간격 40px) · 쿨다운 분열 3/메가 4/폭격 4 · HP 캐논 120/미사일 100/정찰 90 · 연료 100/120/160 · 낙하 24px까지 무피해, 초과 4px당 1 · 등반 4px | 낙하는 턴당 0.3회 |

- 경기 길이(AI끼리 seed 16판 중앙값): 2인 상 14턴 · 중 22 · 4인 상 19 · 중 46 — 무승부·턴 상한 0판
- 엔진 규칙 추가: `carveCircle` 반경 ≤ 0 무동작 · events: damage amount 실제 감소분, 낙하는 모든 탄 종료 후 1회(해시 무관)
- ENGINE_VERSION 1 유지, 골든 sha256 `687910fa…`(재생성 바이트 동일), 매니페스트 재생성
- 화면: 미노출 `/games/fortress/play`(목록·사이트맵 없음, noindex) — 2~4인·개인/팀·맵·사람/AI 하중상·탱크, 카메라 팬·핀치·휠, 지형 부분 갱신(연출 지형 = 엔진 다음 지형, 무기 6종 테스트 고정), 길게 눌러 파워, 핫시트. 턴 20초 타이머는 F4·F5(서버 시계)
- 390×844 headless(DPR 3, dev): AI 상 chooseTurn 중앙 10.5/최대 26ms(CPU×4: 35/69) · 연출 프레임 평균 8.4·p95 9.1·최대 33ms(CPU×4: 15.4·24·83) · drawScene 평균 0.02ms(CPU×4 최대 8.3) → Web Worker 불필요. **실기기 미검증**
- Playwright 재확인: worktree에서 `pnpm exec next dev --port <포트> --hostname 127.0.0.1`(sandbox 밖) → `/games/fortress/play?auto=1&perf=1&seed=1` · `window.__fortressPerf` · 사람 턴 `?seed=5&perf=1` → "시작" → 버튼 `/길게 눌러 발사/` pointer down/up · CPU 스로틀 CDP `Emulation.setCPUThrottlingRate {rate:4}`
- 검증: 프론트 `pnpm ci:core` EXIT 0(lint 0·typecheck·test 1,873 통과·build `/games/fortress/play` 15.3kB) · fortress 테스트 82 · 리뷰 수정 회귀 테스트 2개는 되돌린 코드에서 실패 확인 · 두 리뷰어 2차 확정 0
- 메인 결정 요청 4건 → D-010(①③ 문구 정리, ② 넘기기는 스킵 카운트 초기화 유지 + 유효 경기 발사는 파워 ≥ 1) · ④ 실기기·VoiceOver는 미검증으로 F5 실기기 게이트에 둔다

### F1b — 백엔드 엔진 사본 (메인)
- 복사: 원본 `engine/**/*.ts`(`*.test.ts` 제외) 12파일 + `__fixtures__/golden-matches.json` → `src/modules/fortress/engine/` · 매니페스트 `engine-dev/ENGINE_MANIFEST.json` → `src/modules/fortress/fortress-engine-manifest.json`(sha256 `cd507161…`, 13파일). `cmp`로 전 파일 바이트 동일 확인
- spec: `fortress-engine.manifest.spec.ts`(디펜스 계산식 동일 — 버전·파일별·전체 해시·대상 밖 파일 없음) · `fortress-engine.golden.spec.ts`(21경기: 성공 12 턴별 hashes·result, 행동 실패 8종 + 설정 실패 at −1, 최종 state JSON 왕복 해시 동일)
- lint·prettier 제외에 사본 폴더 추가(`eslint.config.mjs` ignores · `.prettierignore`) — 디펜스 사본과 같은 이유(포맷되면 해시가 깨진다)
- 변이 확인: 사본 `data.ts`의 피해 30 → 31로 바꾸면 매니페스트·골든 6건 실패 → 원복 후 원본과 `cmp` 동일
- 검증: `pnpm exec jest src/modules/fortress` 2 suites 28/28 · `pnpm ci:core` EXIT 0(lint 0 errors·6 warnings 기준선, 78 suites 1,869/1,869, typecheck·build 통과)
- worktree에 `node_modules`가 없어 `pnpm install --frozen-lockfile --offline`(sandbox가 패키지 안 `.vscode/settings.json` 쓰기를 막아 sandbox 밖) — lockfile 변경 없음
- 리뷰: F4와 묶어 한 번에(리뷰 루프는 묶음 작업이 끝난 뒤 몰아서)

## 2026-10-27 — F2 AI전 정식 화면 (`next-bun-c4` 보고, 미커밋)
- 엔진·골든·매니페스트 무변경 — 메인이 사본 13파일·매니페스트를 원본과 `cmp`로 재확인(동일, 매니페스트 파일 sha256 `0bdf0107…2ea2662`)
- 신규 `lib/replay.ts`(형식·buildReplay·stateAt·summarizeReplay)·`lib/aimKeys.ts`·`hooks/useBattleView.ts`(경기·리플레이 공용 루프)·`components/FortressResult.tsx`·`FortressReplay.tsx` + 테스트 · 수정 `FortressMatch.tsx`·`FortressPrototype.tsx`
- 흐름: 설정 → 경기 → 결과(승패·턴 수·플레이어별 남은 HP·준 피해·KO) → 다시하기·다시 보기·설정으로. 집계: 준 피해 = 자기 턴 다른 팀에게 깎은 HP(damage amount 합), KO = 자기 턴 hp·out 사망(기권·넘기기 탈락 제외)
- **리플레이 형식**(F6 재사용): `{ engineVersion, config, actions[] }`, 적용 성공 행동만 기록. 행동당 약 61B — 2인 60턴 3.8KB, 4인 120턴(상한) 7.5KB. 버전별 엔진 로드 후 applyAction 순차, 실패는 ENGINE_VERSION·행동 인덱스
- 테스트: 기록 → JSON 왕복 → buildReplay 최종 stateHash·result·턴별 해시가 실제 경기·simulateMatch와 같음(2인 2판·4인 팀 1판)
- 접근성: 파워 슬라이더(1~100)·−/+·"발사 N" 버튼으로 키보드만 발사 · 길게 누르기 버튼은 aria-hidden·250ms 미만 무발사(VoiceOver 두 번 탭 방지) · 차례 아닐 때 조작부 inert · aria-live 차례 안내 · 마우스로 누른 버튼에 포커스 남기지 않음(핫시트 스페이스 오작동 수정)
- Playwright 셀렉터: `fortress-power`·`fortress-fire`·`section[aria-label=조작]`·`fortress-result`·`fortress-result-turns`·`fortress-rematch`·`fortress-replay`·`fortress-replay-{turn,toggle,prev,next}` · `?auto=1`(4인 AI 상) · dev에선 `nextjs-portal{display:none}` 주입
- 검증: 프론트 `pnpm ci:core` EXIT 0(테스트 1,881, build `/games/fortress/play` 19.9kB) · aimKeys 회귀 2건 되돌림 실패 확인 · Playwright 390×844·1280 콘솔 에러 0 · 리뷰 2차 Opus 확정 0, review-front 차단 0 + 확인 필요 1건 수정(Playwright 확인, 3차 미실행)
- 미검증: 실기기·VoiceOver(F5 게이트)

## 2026-10-27 — F4 소켓 계약 프론트 검토 (`next-bun-c4`, 조사만)
- 연출 실측(AI 24판 909턴, scratchpad): 엔진 마지막 틱 p50 76(2.5s)·p95 111·max 157(5.2s) / 화면 playbackEnd p50 106·p95 142·max 187(6.2s), 차이 18~32틱. 8초 초과 0턴. 엔진 이론 상한 `MAX_TICKS_PER_TURN` 1800(constants.ts:37)
- 틱 규칙(프론트 근거): shot 끝 = `t + samples.length/2 − 1` · explode·terrain·damage·death·fall = `t` · move 길이 = `ceil((path.length/2 − 1) / MOVE_PX_PER_TICK)`(sim.ts:127) · 재생기 꼬리 explode +14·fall +12·여운 +18(playback.ts:15-24)
- 근거 인용: 엔진 'random' 불가 state.ts:76·data.ts:70 · 테트리스 RoomPlayer `skins`(tetrisBattleSocket.ts:111-112) · battle-ui 25파일이 테트리스 소켓 타입 import, namespace 고정 BattleSocketContext.tsx:251, 시작 조건 WaitingRoom.tsx:55, 관전자만 채팅 MatchScreen.tsx:143-149 · resync 재적용 경로 lib/replay.ts:21·useBattleView.ts:74-78
- F3b 프론트 규모(추정): battle-ui 공용 후보 약 2.0천 줄 타입 제네릭화 + 동작 변경 4곳(Context 제네릭·namespace 인자, `canStart` 주입, 플레이어 행·설정 패널·생성 폼 슬롯, 채팅 정책은 게임별 MatchScreen). battle-engine import 8파일은 공용 대상 밖
- 결과: ★6건 + 기타 전부 채택 → D-012, DESIGN §11 개정

## 2026-10-30 — F4 착수: F3a에 의존하지 않는 부분 (메인, 미커밋)
- 사용자 "작업 이어서 진행. 백프 모두"(세션 끊김 후 재개). F3a 공용 방 부품은 `refactor-onam-game-room`에만 있어(미커밋) 방 라이프사이클은 F3a 반영 방식 결정 뒤 — 그 전에 순수 부분부터
- `src/modules/fortress/fortress.events.ts` — 소켓 계약 v1(DESIGN §11) 이벤트명·에러 코드·페이로드·상수. 방 필드명은 테트리스 `CreateRoomDto`·`RoomCodeDto`와 같게(`name`·`code`·`playerName`·`tabId`·`heartbeat`)
- `src/modules/fortress/fortress-match.rules.ts` — `turnDurationMs(endTick)`(20초 + 연출 올림·상한 8초 + 2초) · `actorOf` · `createTally`/`tallyAction`(준 피해·KO·탈락 seq) · `computePlaces`(team 승패·ffa 생존 승자→HP→탈락 늦은 순, 같은 값 같은 순위 1,1,3)
- spec 20건: 경계값·합성 이벤트·순위 4종 + 골든 성공 경기 전부(승자 1위, 준 피해 합 = 적 damage 합). 변이 4개(적 판정·team 순위·승자 우선·탈락 seq) 중 2개가 처음엔 살아남음 → 중복 가드 제거 + 승자 우선 테스트 추가 후 모두 실패 확인
- DESIGN §11 place 문장 보정: ffa draw는 "생존자 전원 1위"가 아니라 최고 HP 동점 공동 1위(턴 상한 판정과 같은 규칙)
- 검증: `pnpm ci:core` EXIT 0(lint 0 errors·6 warnings 기준선, 79 suites 1,889/1,889)
- 프론트: eventsEndTick 구현·ci:core(1,885) 완료, 리뷰어 2개가 API 타임아웃으로 결과 없이 끝나 재실행 중. 매니페스트 sha256 필드 `6a748e6e…c764245`·파일 `bd128211…af18c545`, 골든 `687910fa…` 그대로

## 2026-10-30 — eventsEndTick 반영 · 사본 재복사 (메인)
- 프론트 완료 보고(`next-bun-c4`, 미커밋): 엔진 `sim.ts`(eventsEndTick 추가)·`index.ts`(export)만 변경, ENGINE_VERSION 1, 골든 바이트 그대로(`687910fa…21193ba`), 매니페스트 `sha256` 필드 `9176758e…3b17a3`·파일 `97200058…851d56`(진행 보고 때 값은 주석 수정으로 무효). playback end = eventsEndTick + 꼬리(동작 동일, 회귀 테스트). 엔진 틱 직접 대조 테스트·변이 2종 확인 · ci:core EXIT 0(1,888) · 두 리뷰어 확정 0(반영분은 3차 리뷰 없이 변이·ci:core)
- 메인: 바뀐 2파일 + 매니페스트 재복사 → 사본 13파일·매니페스트 원본과 `cmp` 동일, 파일 sha256이 보고값과 같음
- 연출 상한 9초(D-013) · rules spec에 골든 전 행동의 `turnDurationMs(eventsEndTick(events))` 범위(22~31초) 검사 추가
- 검증: fortress 3 suites 51/51 · `pnpm ci:core` 결과는 아래 줄
- ci:core: Tests:       1892 passed, 1892 total

## 2026-10-30 F3b 프론트 보고 · 계약 보강

- 프론트 F3b 완료(미커밋): `_shared/battle-room/`(useBattleRoomCore·WaitingRoomView·BattleLobbyView·공용 lib) 추출, 테트리스 battle-ui 17파일은 재수출 shim·래퍼로. battle-engine 8파일·BattleRoom 미변경.
  - 무회귀 근거: 기존 테스트 diff 0, 원본 HEAD 대비 jsdom innerHTML 38,400B 동일·Playwright SSR HTML·스크린샷 동일, roomContract.test가 두 게임 공통 상수 일치 고정. `ci:core` EXIT 0(테스트 1,900), 리뷰 2명 확정 0(제안 3건 반영 — config ref 읽기·createPayload 타입·공통 필드 펼침 순서).
  - 범위 밖으로 남김: BattleRoom(입장·비밀번호·초대) 공용화는 F5에서 판단, 실서버 2탭 확인은 F4 백엔드 뒤.
- 프론트 질의 ①②에 대한 답: 프론트가 추정한 부록 타입을 정본 `src/modules/fortress/fortress.events.ts`로 올렸다(sha256 ceeb3ab9…ae661f0).
  - 추가: JoinRoomPayload(테트리스 JoinRoomDto와 같고 lastGarbageId 없음 — 경기 복구는 rejoin.match), KickPlayer·SetReady·Chat·Emote 페이로드, ListRoomsAckData, SessionReplaced·Kicked·RoomsChanged·ChatMessage(name 필수)·EmoteReceived, ErrorPayload `{code, message, timestamp}`(테트리스 ws-exception.filter와 같은 형태).
  - F4 gateway DTO는 이 타입과 1:1로 만든다(테트리스 gateway.dto.ts 검증 규칙 재사용).
- 프론트 재복사 완료: `src/types/fortressSocket.ts`(456줄) — 정본 대비 차이는 엔진 import 경로·socket.io-client import·머리 주석·끝의 Socket 타입 맵 부록(Ack·ServerToClient·ClientToServer·FortressSocket)뿐, 추정 타입 전부 제거. 프론트 `ci:core` EXIT 0(1,900). 백엔드 `ci:core` EXIT 0(lint 0 errors/6 warnings 기준선, 1,892).

## 2026-10-30 F3a 머지 · 포트리스 브랜치 반영

- 사용자 지시("추천대로 진행"): F3a 커밋 2e209e1 → origin/develop(#318 로비 채팅 포함) 머지(충돌 0) → `ci:all` EXIT 0(unit 1,922, E2E 307 passed / Redis opt-in skip) + Redis E2E(6390) 테트리스 3 suites 56 passed → PR #320 CI(verify·e2e) 통과 → develop 머지 992a731.
- `feat-onam-fortress`를 origin/develop으로 fast-forward(미커밋 포트리스 변경과 파일 겹침 0). 반영 후 `ci:core` EXIT 0(85 suites, 1,973).

## 2026-10-30 F4 백엔드 구현 (서브에이전트) · 메인 재검증

- 새 파일 `src/modules/fortress/`: constants·errors·match.store(Lua `MATCH_CAS_SCRIPT`)·match.service(445)·room.service(1,141)·gateway(+dto·ws.guard·ws-exception.filter)·module + spec 5개 · `test/fortress-gateway.e2e-spec.ts`(소켓 4개 팀전 전체 흐름, 2인 ffa 시간 초과 3회 탈락) · `test/fortress-match.redis.e2e-spec.ts`(opt-in `FORTRESS_REDIS_TEST_PORT`, Lua·두 레플리카 동시 처리). 수정: `app.module.ts` +2, `main.ts` +5(Redis 주입).
- 설계 선택(§11 보충): 경기 Hash `{v, json}` 버전 CAS 하나로 seq·마감 보호, 같은 Lua에서 마감 ZSET 갱신 · 엔진 state를 경기 JSON에 저장(행동당 applyAction 1회) · ZSET 점수 = min(턴 마감, 끊긴 생존자 유예 끝) — 스위퍼가 끊김 resign도 회수 · 방송은 CAS 승자만(요청·로컬 타이머·스위퍼 같은 경로) · 판정 순서 MATCH_NOT_FOUND → TURN_MISMATCH → NOT_YOUR_TURN → TURN_EXPIRED(skip 적용 후 에러) → ACTION_REJECTED · 첫 턴 remainingMs = 시작 지연 3초 + 22초 · DTO는 정수·넓은 상한만, 의미 검증은 엔진(ACTION_REJECTED) · ffa setTeam → INVALID_PAYLOAD · 경기 중 자리 넘겨받기 SEAT_IN_USE(테트리스와 같음) · rejoin.match는 PLAYING만.
- 메인 재검증: tetris-battle·game-room·tetris E2E·계약·엔진 diff 0(계약 sha256 ceeb3ab9… 그대로) · `ci:core` EXIT 0(89 suites, 2,044, lint 경고 6 기준선) · sandbox 밖 `FORTRESS_REDIS_TEST_PORT=6390 TETRIS_BATTLE_REDIS_TEST_PORT=6390 pnpm test:e2e` EXIT 0 — 21 suites/368 passed, skip은 무관한 redis-throttler 1 suite뿐.
- 함정: worktree 경로에 `fortress`가 들어 있어 `--testPathPatterns fortress`는 전 suite를 잡는다 → `'test/fortress-'`로 좁힌다.
- 미검증: `pnpm dev` 부팅(DB 접속 — 사용자 지시 필요), 다중 레플리카 Redis 어댑터 실방송.
- 프론트 질의: 남의 resign과 내 제출이 겹칠 때 TURN_MISMATCH 처리 방식 · 첫 턴 remainingMs 표시.
- 리뷰 1라운드 진행 중(review-flow + Opus 독립 리뷰).

### F4 리뷰 1라운드 (review-flow + Opus 독립)
- 수정 지시(7): ① 재연결 복원·해제 실패 시 경기 끊김 기록이 남아 30초 뒤 resign(Opus 재현, 중간) → turnSubmit·resync에서 자리 주인 확인 후 기록 해제 ② 재연결 ack room이 낡은 PLAYING ③ 경기 키 없는 PLAYING 방 → RESULT 회수(두 리뷰어 공통) ④ 방에서 빠졌는데 경기에서 살아 있는 플레이어 resign 재시도 ⑤ turnSubmit 빈도 제한 ⑥ 서버 경로 D-010 테스트 ⑦ 계약 ResyncPayload.seq 주석 명확화(형태 불변).
- 수정하지 않음(결정): 시작 카운트다운 3초 중 제출 수용(클라이언트 입력 잠금, 변조 클라이언트 이득 최대 3초) · 시작 롤백 실패 고아 경기 방송(프론트가 현재 matchId 아닌 이벤트 무시 — F5 메모) · 남의 resign과 겹친 TURN_MISMATCH(D-015) · CAS 성공 직후 레플리카 사망 시 방송 유실(at-most-once 비용, 클라이언트 resync·③으로 회수).

### F4 리뷰 2라운드 — 두 리뷰어 확정 0 (종료)
- 1라운드 수정 7건 모두 확인(재연결 끊김 기록 결함은 Opus가 같은 재현으로 해소 확인). 회귀 테스트는 수정 되돌리면 실패·복원하면 통과(구현 에이전트 확인). 계약 sha256 ef0cb007…01a7(주석만), 프론트 재복사 지시.
- 남긴 PLAUSIBLE(수정 안 함, 자가 회복·지연만): ① `clearStaleDisconnect`가 다른 레플리카의 하트비트 유령 판정과 엇갈리면 끊김 기록을 지울 수 있음 — markGhosts의 +10.5초 sweepExpired(onlyIfEmpty)가 원래 시각으로 다시 채움 ② 재입장 ack의 방 재조회가 던지면 rejoin 스냅샷을 버림 — 클라이언트 resync로 회복 ③ resignDepartedPlayers가 던지면 그 회차 processDue·repairEndedMatch가 빠짐 — 다음 깨우기가 처리.
- DESIGN §11 turnSubmit 에러 목록에 RATE_LIMITED(10회/5초) 추가.
- 메인 재검증: `ci:core` EXIT 0(2,051) · Redis 포함 E2E 368 passed(구현 에이전트, 직전 라운드 메인 재실행과 같은 수).
- 프론트 사본 재복사 완료: `src/types/fortressSocket.ts` 457줄, 정본 ef0cb007… 대비 차이는 import 경로·머리 주석·Socket 타입 부록뿐. 프론트 `ci:core` EXIT 0(1,900). F5 메모(matchId 다른 경기 이벤트 무시, mismatch 뒤 1초 대기 후 resync) 접수. F3b 검증용 dev 서버 종료 확인.

## 2026-10-30 사용자 로컬 확인 피드백 → F1c(플레이 화면 UX·디자인)

- 로컬: 백 `pnpm dev`(fortress worktree, :3500, 사용자 지시) + 프 dev :3217. CORS에 localhost:3217 TEMP 추가(커밋 전 되돌림 — STATUS 표기).
- 사용자 피드백(`/games/fortress/play`): ① 이동키가 있긴 한지 ② 조작키가 잘 안 보임 ③ UI·UX·디자인이 너무 안 좋음 ④ 테트리스 채팅방·게임 홈(방 목록·채팅·랭킹·리플레이) 패턴을 학습해 적용할 것 적용.
- 대응: 새 슬라이스 **F1c**(프) — 테트리스 화면 패턴 조사 → 지금 적용(플레이 화면 조작부·HUD·디자인, 포트리스 진입 화면) / 나중 적용(F5 로비·채팅, F6 랭킹·리플레이)으로 분류. 교훈은 `docs/lessons.md` 2026-10-30.
- 사용자 지시: 사이트 홈(`/`)에 테트리스·디펜스·포트리스 넣고 홈 정리 → 별도 태스크 `docs/tasks/site-home/`(포트리스 카드는 포트리스 브랜치에서 출시와 함께).

## 2026-10-30 포트리스 로비 전체 채팅(D-016) 백엔드

- 구현(서브에이전트): 계약에 테트리스와 같은 모양으로 JOIN_LOBBY_CHAT·LEAVE_LOBBY_CHAT·LOBBY_CHAT·LOBBY_CHAT_MESSAGE·LOBBY_CHAT_NOT_JOINED·LobbyChat* 타입 추가(sha256 a691d572…6303bf) · `fortress-lobby-chat.service.ts`(테트리스 사본, 키 `fortress:lobby-chat:recent`, 채널 `fortress:lobby-chat`, F3c 공용화 주석) · 게이트웨이 핸들러·DTO·빈도 제한·main.ts Redis 주입.
- 테스트: 서비스 spec(테트리스 사례 전부 + 게임별 분리) · 게이트웨이 spec 10사례(테트리스 채널로 방송 안 함 포함) · 배선 spec · WS E2E(두 클라이언트 수신, 미구독 LOBBY_CHAT_NOT_JOINED, 포트리스 키에만 기록).
- 메인 재검증: 테트리스·game-room diff 0 · `ci:core` EXIT 0(2,079) · 로컬 dev 서버 자동 재시작 정상. E2E 369 passed(서브에이전트, Redis opt-in 포함).
- 리뷰: 커밋 전 묶음 리뷰(F1c·사이트 홈과 함께 1회 — 리뷰 루프 규칙)로 미룸.
- 사용자 추가 지시(F1c 확장, D-017): 바람 표시를 눈에 띄게 · 플레이 화면 전반 고품질화(three.js 등 허용).

### F1c 중간 확인 (2026-10-30)
- 프론트: Canvas 2D 고도화로 결정(실측 — 그리기 JS 평균 0.21ms·4배 감속 0.95ms로 프레임 예산의 1/15 이하, pixi 8 gzip 157KB·three 0.170 gzip 120KB 추가 대비 이득 작음). 노을 하늘·패럴랙스 산·바람 따라 흐르는 구름·바람 줄기, 지층 지형, 포신 있는 탱크·이름표·HP, 이동 계획 고스트, 탄 연기·폭발·흔들림·피해 숫자, WIND 게이지(세기별 색·변화 시 튐·낭독), 턴 배너, 움직임 줄이기·품질 자동 하향.
- 메인 스크린샷 검토 → 승인 + 수정 6건: ① 모바일에서 적이 화면 밖(가장자리 점뿐) — 자동 프레이밍/큰 화면 밖 칩·둘러보기 ② 탄 추적 카메라가 하늘만 비춤 ③ 탱크가 너무 작음 ④ 폭발 약함 ⑤ 모바일 조작부 약 40%·발사 버튼 중복 → 발사 1개·드래그 조준 ⑥ 구름 탁함. 데스크톱 조작부는 월드 위 오버레이로.
- 프론트 보고: 프론트 포트리스 브랜치가 origin/develop보다 17커밋 뒤, develop의 BattleLobby·battleErrors·battleList 변경이 F3b 공용 파일과 충돌 예정 → 커밋 단계에서 사용자 승인 후 머지(옮겨 적기 목록 보고).
- 미검증: 실기기 60fps(F5 실기기 점검 때).
- F1c 2차 중간 확인(dir4): 조준 시 내 탱크+가장 가까운 적 프레이밍(배율 하한 0.42)·화면 밖 적 칩(이름·HP·거리·방향)·둘러보기+"내 탱크로" · 탄 추적이 탄+땅+쏜 탱크 함께 · 탱크 화면 반지름 15px 이상 · 폭발 강화·그을림·대형 화면 섬광 · 발사 버튼 1개(탭=발사, 250ms 이상=충전)·끌기 조준·조작부 40%→33% · 일러스트 구름 · 데스크톱 오버레이 조작 바. 메인 승인 + 확인 2건(탄 머리 3개 중복 그리기 의심, 모바일 폭발 크기 하한).
- 사용자 버그: "왼쪽으론 가는데 오른쪽으론 안 감" → 프론트 재현·격리 지시(UI 결함 vs 엔진 경사 규칙 — 엔진이면 엔진 불변, UI가 이유 표시).
- 사용자 질문 "포트리스 홈 안 만든 거지?" → 맞다(F8 미착수, `/games/fortress`에 홈 없음). tetris-home 배포(#316) 완료라 선행 조건 충족 → F1c 다음에 사이트 홈과 함께 착수 권장.
- 사용자 보고: 먼 사거리 탄이 화면 밖으로 나가도 카메라가 안 따라감 → 착탄까지 탄 우선 추적·착탄 지점 잠깐 머묾·OUT 표시·회귀 테스트 지시(F1c).
- 이동 버그 원인: UI 입력은 정상(▶·D 실측 x 증가). 엔진 walk(engine/sim.ts:113-131)가 MAX_CLIMB 4px 넘는 비탈·구덩이 벽에서 멈추는데 예전 UI는 이동값·연료 표시를 계속 늘려 "안 간다"로 보였다 → 엔진 불변, UI가 previewShot으로 도달 범위를 재서 자르고 "비탈이 가팔라 더 못 가요/맵 끝" 표시·버튼 비활성(lib/moveReach.ts). 엔진 규칙 변경 근거 없음(시작 상태 120개 중 절반도 못 가는 경우 0).
- 탄 추적: renderer/follow.ts — 앞선 탄 우선·다탄 범위·탄 아래 땅, 착탄 700ms 머묾, 맵 밖 OUT 1.2초, 발사 시 둘러보기 해제. 메인이 far 시트로 확인. 테스트 한계: follow.test는 예전 규칙으로도 통과(맵 밖 장면 재현 아님) — 프론트 자체 보고.
- dev 3217 파일 감시가 dir4 무렵부터 멈춰 있었음 → 프론트가 재기동(사용자 새로고침 필요).
- "← 설정"이 진행 중 경기를 확인 없이 버림 → 경기 중일 때만 확인 모달(메인 결정).

### F1c 최종 (2026-10-30)
- 프론트 보고: `ci:core` EXIT 0(lint·typecheck 0, 테스트 1,918 통과, build 성공) · 두 리뷰어 3차 확정 0(1차 4/4 → 2차 3/5 → 3차 0/0, 3차 공통 의심 1·제안 2 반영) · 새 회귀 테스트(나가기 확인·안내 중 충전 버리기·조작부 여백 카메라)는 고친 줄을 되돌리면 실패함을 확인 · 번들 /games/fortress/play 123→141kB, 새 라이브러리 0 · engine/·골든·매니페스트 불변.
- 1차 ci:core에서 테트리스 BattleMatchViewer.test.tsx:235가 1회 실패(파일 미변경, 단독 실행 변경 트리 1/20·HEAD 0/25, 원인 미확정 — 타이밍성 의심). 재실행 통과. 후속 관찰 항목.
- 메인 스크린샷 검토(모바일·데스크톱 설정·경기·발사 후·결과, far 시트): 조작부 전부 보임·발사 1개·WIND 게이지 상단 중앙·화면 밖 적 칩·탄 추적→OUT→턴 전환·폭발 확인. 승인.
- 미검증: 실기기 60fps·VoiceOver·reduced-motion 실화면(F5 실기기 점검 때).
- develop 머지 충돌 예정 3건(BattleLobby.tsx·battleErrors.ts·battleList.ts) — 커밋 단계 사용자 승인 뒤 머지, 옮겨 적기 방향은 프론트 보고대로(BattleLobbyView 채팅 슬롯·LOBBY_CHAT_NOT_JOINED 공용 후보·상수 shim).
- 다음: 계약 사본 재복사(a691d572…) → 사이트 홈(feat-onam-site-home, 2안 스크린샷부터).

## 2026-10-31 사용자 결정 · develop 반영 · 로컬 정석 포트
- 사용자: 사이트 소개 문구 그대로 · PR 보류("pr 냅둬", 커밋도 미승인으로 취급) · 포트리스 브랜치에 최신 develop 반영 진행 · 로컬 서버 전부 내리고 백·프 정석 포트로.
- 백엔드: origin/develop 2e61fff(#321 의존성 보안 패치 — package.json·lock·docs만)로 `--ff-only`(작업 파일과 겹침 0, 커밋 없음) → `pnpm install` → `ci:core` EXIT 0(lint 0 errors·6 warnings, 90 suites·2,079 tests) · TEMP CORS 3217 줄 되돌림 · `pnpm dev` 3500 재기동(docs-json 200).
- 로컬 서버: 3217·3219(프론트)·3000·3599(다른 프로젝트) 종료 — 사용자 "로컬 프젝 다 죽이고".
- 프론트 지시: 커밋 없이 stash(고유 tag)→ff-only→apply로 develop 반영·충돌 3파일 옮겨 적기·tsc/lint/test/build·로비 채팅 스크린샷 → 포트리스 worktree를 3000으로 기동 → 사이트 홈 구현 → F8(포트리스 홈).
- 프론트 develop 반영: 브랜치 HEAD b4dacaa(main 쪽 머지 커밋, 트리 = develop 조상 a3f14cb)라 ff 불가 → 원격 브랜치 없음(ls-remote 빈 결과) 확인 뒤 A안(stash → `reset --keep origin/develop` → install → apply → 충돌 해결) 메인 승인. 3000 기동은 그 뒤.
- 다음: F8 포트리스 홈 조사·2안(사용자 "포트리스 게임홈은 아직 안보이던데").
- 프론트 develop 반영 완료(2026-10-31): HEAD a9ed08a(origin/develop), 커밋 없음, stash 87c47ced는 검사 통과 뒤 drop · 충돌 3파일 해결 — BattleLobbyView `renderLobbyChat` 슬롯(:60, 렌더 :267-279), 테트리스 BattleLobby가 LobbyChatPanel 주입, battleErrors.ts:11 LOBBY_CHAT_NOT_JOINED, battleList.ts:22-23 상수 · ci:core EXIT 0(2,056 tests) · 로비 채팅 패널·/games/tetris/battle 본문 HTML이 develop과 바이트 동일(모바일·데스크톱) · 3000 기동, 메인 확인 /·/games/fortress/play·/games/tetris/battle 200, 3500 CORS 3000 허용.

## 2026-10-31 F8 포트리스 홈 (D-018)
- 프론트 구현: /games/fortress(서버 컴포넌트, noindex) — 작은 머리 그림(112px, sm 128px)·"▶ AI와 대전"(?vs=ai)·"같은 기기 대전"(?vs=local)·온라인 준비 중 한 줄·조작 접기(<details>, 기본 닫힘)·탱크, lg 2단 · 조작 표 lib/controlGuide.ts로 경기 안내와 공유("발사 N"→"발사 버튼") · /play `?vs` 마운트 1회 적용(auto 우선, 모르는 값은 기본) · 설정 뒤로 링크 "← 포트리스" · 미리보기 경로 삭제 · 사이트 홈·/games 미노출.
- 검증: 프론트 ci:core EXIT 0(2,065 tests) · 두 리뷰어 1회차 확정 0 · vs 적용 줄 제거 시 ?vs=local 테스트 실패 확인 · 모바일 첫 화면 두 타일 아래 끝 296px · BNB 간격 모바일 21px·데스크톱 17px · 메인 스크린샷 검토 승인, 3000에서 /games/fortress·?vs=local 200.
- 알려진 현상(수용): ?vs=local 첫 프레임에 P2가 "AI 중"으로 보였다 바뀜(하이드레이션 뒤 적용). 미검증: 실기기·VoiceOver.
- 사용자 "구현 일단 다 진행"(2026-10-31) → F5(프 온라인 화면 — 중간 보고: 로비·대기실 스크린샷) · F6(백 결과 저장·리플레이 API — 서브에이전트, 설계 초안 DESIGN §12 후 구현, 마이그레이션은 파일만) 병렬 착수. F7은 F6 뒤.
- F5 중간(2026-10-31): 실서버 2탭으로 로비(이름·방 목록·빠른 참가·포트리스 로비 채팅·방 만들기 모드/맵·코드 입장)·대기실(방장 설정·팀/탱크 선택·2:2 시작 조건) 확인, 콘솔 오류 0. 공용화: LobbyChatPanel 등 → _shared/battle-room/lobby-chat(저장 키·소켓 주입, 테트리스 래퍼 유지), BattleRoomView 공용, socketRequest(코드 없는 요청), roomContract에 로비 채팅 이벤트. 메인 승인 + 수정 2건(모바일 이모트 바가 채팅 입력 가림 — 테트리스도 같은지 확인, 준비 버튼 아래 문구 겹침) · F5 끝에 테트리스 대전 2탭 회귀 필수.

## 2026-10-31 F6 백엔드 (서브에이전트) · 메인 재검증
- 구현: 테이블 FORTRESS_MATCHES·FORTRESS_PLAYERS·FORTRESS_REPLAYS(Entity·마이그레이션 3쌍, 미실행) · 리플레이 id = matchId(D-019) · 저장: 끝내는 행동이 CAS 직전 `fortress:pending-saves` 등록 → CAS 승자 즉시 저장(비대기) → 놓친 건 30초 크론(QA·PROD + TASK_SLOT=1)·결과 조회 lazy 저장 회수 · 중복 4중 방지(saved 표시·saving NX 가드·트랜잭션 내 존재 확인·ORA-00001) · 탈퇴 사용자 FK(ORA-02291) 시 USER_ID 비우고 재시도 · F7 원장 자리 주석. REST(무인증, 초당 3/분당 60): GET /fortress/matches(커서) · /fortress/matches/:id · /fortress/matches/:id/replay. 상세 DESIGN §12.
- 메인 재검증: `ci:core` EXIT 0(91 suites·2,096 tests, 경고 6 기준선) · tetris-battle·game-room diff 0 · 로컬 3500에서 GET /fortress/matches → 500 ORA-00942(테이블 없음 — 마이그레이션 미실행이라 예상대로). 서브에이전트 E2E 3 suites·17 tests(Redis 6390).
- 게이트: 마이그레이션 3개(1793404800000·1793404801000·1793404802000) 담당자 실행 = 머지 전 차단. 주의: LOCAL과 PROD가 같은 DB라, 마이그레이션 적용 뒤 로컬에서 경기를 끝내면 상용 DB에 행이 생긴다(테트리스와 같음).
- 후속: FORTRESS_PLAYERS.USER_ID 인덱스("내 경기" 기능 때) · Redis 장애 중 lazy 저장 불가(크론 회수).

## 2026-10-31 F7 백엔드 (서브에이전트) · 메인 재검증
- 구현(DESIGN §13): DB 변경 0 — 원장 REASON `FORTRESS_MATCH`(REF_KEY matchId:playerId), 스킨은 기존 USER_SKIN_EQUIPS·LEVELS에 SLOT `FORTRESS_TANK`(CHECK는 형식만이라 통과 — 메인이 마이그레이션 CHECK 확인), 강화 비용 SKIN_UPGRADE · 적립은 F6 저장 트랜잭션 안(fortress-result.service.ts:267), 엔진 재시뮬레이션은 트랜잭션 밖 · D-006 규칙 fortress-points.rules.ts·fortress-points.service.ts(USERS FOR UPDATE를 userId 오름차순) · 스킨: 게이트웨이 enterIdentity가 장착 조회(게스트 제외·실패해도 입장) → RoomPlayer.extra.skin → 경기 시작 때 slot에 고정 → 리플레이 slots[].skin · 계약 파일 무변경 · 새 REST(로그인 전용): GET /fortress/matches/:id/points · GET/PUT /fortress/skins/me · POST /fortress/skins/me/upgrade · users 공용: UserSkinService에 upgradeItem·equipItem·slotItemsOf 추출(테트리스 upgrade는 같은 본문 호출, 기존 spec 무수정 통과 — 메인 diff 확인).
- 메인 재검증: `ci:core` EXIT 0(94 suites·2,148 tests, 경고 6) · tetris-battle·game-room·games diff 0. 서브에이전트 E2E 4 suites·24 tests.
- 사용자 확인 필요(보수적 기본값 적용 중): ① 감쇠 4~5번째는 승리·KO 몫만 50%, 6번째부터 참가만 ② 같은 조합 = 나를 뺀 로그인 참가자 집합, 무효 경기도 셈 ③ 기권(끊김 30초 초과 포함)자 0 ④ KST 하루 기준 = 저장 시각 ⑤ 적립액은 새 API로만 ⑥ 스킨 카탈로그 default + 무료 desert·arctic·neon(임시 이름) ⑦ 팀전 이긴 팀의 죽은 팀원도 승리 보상.
- 미검증: 실제 Oracle FOR UPDATE·쿼리, 다중 레플리카 동시 저장, 프론트 연동. 로컬 3500은 F7 중간 상태 스냅샷(프론트 F5 E2E 중이라 재기동 보류).

## 2026-11-02 사용자 결정 — 테이블 구조·F7 규칙 유지, 마이그레이션 실행 안내
- 사용자 "일단 그대로 진행": 대전 전용 테이블(FORTRESS_MATCHES/PLAYERS/REPLAYS) 유지, F7 모호 규칙 7개는 보수 기본값 그대로.
- 마이그레이션 사전 확인(`pnpm db:select`): TYPEORM_MIGRATIONS 26건, 마지막 1793060509072 — 파일 29개 중 미적용은 포트리스 3건뿐. 실행은 사용자가 `pnpm db:migrate:up`으로 한다.
- 2026-11-02 사용자가 `pnpm db:migrate:up` 실행 → 포트리스 3건 성공(COMMIT). 메인 확인: USER_TABLES에 FORTRESS_MATCHES/PLAYERS/REPLAYS 존재, TYPEORM_MIGRATIONS 29건, 로컬 3500 `GET /fortress/matches` 200(`items: []`). 이후 로컬 경기 결과는 운영 DB에 저장된다.

## 2026-11-02 F5 프론트 완료 — 메인 검증 · 백엔드 F7 스냅샷 재기동 · F6/F7 프론트 착수
- 프론트 보고: ci:core EXIT 0(2,098 통과/15 skip) · review-front 3→1→0→0 · Opus 3→2→1→0 · 회귀 테스트 15건(되돌리면 실패 확인) · 실서버 E2E 재실행 통과(2탭 ffa 59행동 해시 52지점 불일치 0 · 4탭 팀전 98지점 0 · 재접속 복원 해시 일치 · 테트리스 2탭 회귀). 로그인 사용자·iOS 실기기·끝난 경기 대체 화면 실서버 재현은 미검증.
- 프론트 질의 답(메인): ① 끝난 경기 resync — 방 RESULT 동안 MatchSnapshot(turn null), 방이 벗어났거나 키 TTL(2h) 뒤 MATCH_NOT_FOUND ② 종료 방송 순서 turnResolved → matchEnded → roomState(RESULT), 같은 레플리카 한 경로. 예외: finishMatch 재시도 시 roomState 지연, repairEndedMatch는 matchEnded 없이 roomState만.
- 메인 검증: FORTRESS_MATCHES 3행(kYDnp6WGrJZAlFGf ffa draw 60턴 · zsyeC17SEXu4HCFw team win 120턴 · TtiIcWWhHCXZdPU9 ffa win 8턴), 참가자 2/4/2행, 리플레이 각 1행. 3판 결과·리플레이 API 200, 팀전 값이 team4-r2.log 결과 화면 텍스트와 일치(f5/team4-*-result.png는 10-31 첫 실행분이라 숫자 다름 — 오판 주의).
- 백엔드 3500: 최종 빌드(F7 포함)로 재기동. F6·F7 라우트 매핑 확인, points·skins/me 401(인증 필요) 정상.
- 프론트에 F6/F7 프론트 지시: 리플레이 재생·공유 URL·최근 경기 목록·순위 미수신 대체 연결 · 결과 화면 포인트(로그인 API, 게스트 상수 문구) · 스킨 화면·시각(중간 보고에 4종 시안 → 사용자 확정).

## 2026-11-02 백엔드 몰아서 리뷰 1차 (F4 로비 채팅·F5 백·F6·F7) — 두 리뷰어(Opus)
- 공통: 단위 94 suites / 2,148 통과. 정확히 1번 저장·적립, USERS 오름차순 잠금, 스케줄러 가드, 테트리스 스킨 동작 불변, 소켓 인가, REST userId 비노출은 둘 다 OK.
- 확정·수정 대상(DESIGN 먼저 고침):
  - A1(중) 결과 조회 lazy 저장이 `busy`(다른 레플리카 저장 중)면 404 → 상한 있는 DB 폴링으로 대기
  - A2/B(낮음) ORA-00001을 무조건 "이미 저장"으로 봄 → 경기 행이 있을 때만
  - B1(중) 경기 키·마감을 방 CAS 전에 걸어, 그 사이 레플리카가 죽으면 방 없는 경기가 시간 초과 skip으로 끝까지 가서 공개 저장 → 마감은 방 CAS 뒤 `activate`
  - B2(낮음) 최소 6턴 규칙이 승패를 낸 턴을 빼고 셈(엔진이 그 턴에 turn.no를 안 올림) → `playedTurns`
- 반영 안 함(사유):
  - A3 리플레이 404 Swagger 타입 1개 — 두 코드가 description에 있고 프로젝트에 oneOf 패턴 없음, 테트리스와 같은 방식
  - LOCAL 경기가 운영 DB에 저장·적립 — 테트리스 대전도 같음(PENDING_SAVE_SWEEP_ENVS는 크론만 가드), LOCAL=PROD DB 전제 그대로
  - 경기 마감 스위퍼에 ENV 화이트리스트 없음 — 게임 진행 자체라 모든 환경에서 돌아야 함(TASK_SLOT만), Redis 전용
- 후속:
  - 시작 카운트다운 중 제출 허용(공정성·UX)
  - 같은 userId 두 자리일 때 pointsOf가 다른 자리를 읽을 수 있음(방 서비스가 막음)
  - Redis 미준비 시 lazy 조회가 404
  - FORTRESS_PLAYERS.USER_ID 인덱스
- 1차 수정(서브에이전트) → 메인 diff 확인 · ci:core EXIT 0(94 suites / 2,155, 경고 6). 3500 재기동.
- 2차 리뷰: A1·A2·B2 OK(두 리뷰어). B1 지적 2건 → 메인이 수정:
  - activate가 그 사이 다른 레플리카가 쓴 마감을 덮음(끝난 경기 ZSET 부활) → `MATCH_ACTIVATE_SCRIPT`(버전 1일 때만 ZADD)
  - 방 CAS 뒤 activate 실패 시 방이 PLAYING에 멈춤(repairEndedMatch는 이벤트 때만 돎) → `revertStart`로 WAITING 되돌림 + roomState
  - 회귀 테스트 2건(수정 제거 시 2건 실패 확인). ci:core EXIT 0(94 / 2,157, 경고 6).
- 기록만(의도): 남의 턴 기권으로 끝나면 진행 중 턴도 playedTurns에 셈 · 방 CAS와 activate 사이 프로세스 사망은 방에 붙은 정상 경기로 진행
- D-020 스킨 이름 대안안(모래폭풍·눈보라·네온 라인) · 프론트 `undefined/` 폴더 삭제 승인(사용자) · 프론트 F6/F7 중간 보고 승인(공유 페이지 값 DB 일치, 3판 리플레이 해시 일치)
- 3차 리뷰(두 리뷰어): 확정 결함 0 → 리뷰 루프 종료. 둘이 같은 가장자리(이중 실패 시 경기 키 삭제 순서)를 짚어 반영: 경기 키는 방을 되돌렸을 때만 지운다(`revertStart` → boolean). ci:core EXIT 0(94 / 2,157, 경고 6). 3500 최종 스냅샷 재기동, 결과·리플레이 API 200.
- 후속 기록: 실 Redis E2E에 MATCH_ACTIVATE_SCRIPT v≠1 분기 검사 추가 · awardsOf가 playedTurns를 쓰는지 연결 테스트

## 2026-11-02 사이트 홈을 포트리스 worktree로 가져오기
- 사용자 지시: "사이트홈 코드 여기로 머지받아서 같이 보이도록 하자" → 3000(포트리스 worktree)에서 `/`(사이트 홈)·포트리스를 함께 본다.
- 프론트 지시: F6·F7 마무리(ci:core·리뷰·E2E) 뒤에 feat-onam-site-home 미커밋 변경을 패치로 포트리스 worktree에 적용(커밋·머지 커밋 없음, site-home worktree 원본 유지) → tsc·lint·test·3000 재기동·스크린샷. 포트리스 카드는 넣지 않음(site-home D-001 — 사용자에게 별도 확인).
- 커밋 분리 메모: 가져온 파일 목록을 받아 두고, 나중에 site-home PR을 먼저 낸 뒤 포트리스 브랜치가 그것을 받는 순서로 정리한다.

## 2026-11-02 F6·F7 프론트 최종 보고 · 메인 검증
- 프론트: ci:core EXIT 0(lint 0 · 2,138 통과/15 skip · build 성공, 새 라우트 4개) · 리뷰 review-front 2→1→0 · Opus 2→0→0 · 3차 뒤 저위험 제안 3건 반영(재리뷰 없음, tsc·lint·테스트) · 실서버 E2E: 저장 3판 해시 일치(0be01ce8·e9c726ea·ff1d87b2), 새 경기 PB18N5akGCtMHJqo 방 안 결과·다시 보기·공유 URL 해시 1df9e45b 일치, 콘솔 0.
- 메인: db:select로 PB18N5akGCtMHJqo 확인(ffa·win·TURNS 4·참가 2·리플레이 1·IS_HIDDEN 0) · 스크린샷 확인(final-result-a-saved·skins-mobile·final-share-page).
- 미검증: 로그인 경로 실제 호출(포인트 GET, 스킨 GET·PUT·upgrade) — 단위 테스트(fetch stub)로만. iOS 실기기 캔버스 메모리.
- 프론트 질의 답(fortress-room.service.ts): ① slot = players 배열 index(:653·655·658) ② RESULT 재입장 시 refreshSkin이 새 장착 반영(:455-458) — 프론트 고정이 맞다 ③ leaveRoom은 PLAYING에도 removePlayer(:488-493) → 이탈자 탱크가 새로 연 화면에서 기본 스킨 → 후속(스냅샷 slots에 skin 계약 추가 필요).
- 후속 후보: 게스트 결과 "최대 +50,000 P"가 유효 경기 미달(6턴 미만) 경기에도 뜸 — 프론트 판정 가능 여부 질의 중 · 결과 화면 "카카오로 로그인" 버튼 유지 여부(사용자 결정, 권장 유지).
- 사이트 홈 가져오기 완료(프론트): site-home 미커밋 변경을 패치·복사로 포트리스 worktree에 적용 — 충돌 0, 사이트 홈 몫 4파일(src/app/page.tsx · src/app/games/page.tsx · games/_shared/lib/gameCatalog.ts · src/app/page.test.tsx, 포트리스 변경과 겹침 없음) · tsc·lint 0 · test 2,141 통과 · 3000 재기동, `/`·`/games`·`/games/fortress` 200·콘솔 0 · 포트리스 카드 미포함. 메인 스크린샷 확인(home-m·fortress-m).
- "최대 +P" 유효 경기 판정: 프론트가 리플레이 재적용으로 판정 가능(FortressOnlineStage.tsx:39·141, lib/replay.ts:21·32). 메인이 규칙 정본 전달 — 턴 조건은 playedTurns(:57-59)라 `turn.no >= 6`이 아님. 수정은 사용자 결정 대기.

## 2026-11-02 사용자 결정 반영 — 이탈자 스킨 계약·사이트 홈 포트리스 카드
- 사용자: "사이트 홈이랑 /games 에 포트리스 없음" · "결정해야하는거 다 추천대로 진행하는데 경기중 나간사람 문제 이건 수정하고 다시 리뷰해".
  - 결정: 로그인 버튼 유지 · 게스트 "최대 +P" 유효 경기 판정 반영(프론트) · 사이트 홈·/games에 포트리스 카드 추가(포트리스 브랜치 = site-home D-001과 일치) · 이탈자 스킨 백엔드 수정 + 재리뷰.
- 백엔드 수정: 계약 `MatchSlot.skin`(필수) 추가 — matchStarting.slots(room startMatch)·스냅샷 slots(publicSlots, F7 전 경기는 storedTankSkin default) · 저장 타입은 `Omit<MatchSlot,'skin'>`+선택 skin(StoredMatchSlot·CreateMatchInput·ReplaySlot) · DESIGN §11 L128·§13 L225 갱신.
  - 테스트: 시작 slots skin · 이탈 뒤 resync 스냅샷에 이탈자 skin(새) · 스냅샷 default. 새 테스트는 publicSlots skin을 빼면 실패(변이 확인). 포트리스 233 통과·tsc 0.
  - 계약 파일 sha256 ed146adf…(fortress.events.ts) — 프론트 사본 갱신 필요.
- 재리뷰: 두 리뷰어(Opus 정확성 · review-flow) 확정 0 — 제안 반영 1건(리플레이 slots Swagger description에 스킨 명시), 나머지(시작 직전 재입장 경합 시 직전 skin 고정, create의 skin 조건 spread)는 영향 없음으로 미반영. ci:core EXIT 0(94 suites · 2,158 · 경고 6) · fortress E2E 19 suites 통과 · build · 3500 재기동(replay slots에 skin 확인).
- 프론트 1·2 완료: 사이트 홈·/games 포트리스 카드(gameCatalog 2번째, 💥, 플레이 /games/fortress · 친구와 대전 /games/fortress/battle) · 게스트 "최대 +P"를 유효 경기 판정(lib/points.ts pointsEligibility)으로 사유 문구 대체 · test 2,147. 메인 스크린샷 확인(with-fortress/home-m).
- 출시 전 미노출 장치 현황(프론트 보고, 그대로 둠): 포트리스 페이지 noindex 7곳 · sitemap 미포함 · 제목 "(미리 보기)" 3곳 — 사이트 홈 카드는 노출, 색인은 차단 상태. 사용자 확인 필요.
- 프론트 4번 지시: 계약 사본 재복사(ed146adf…) · slots[].skin으로 그리기 · 회귀 테스트 · 리뷰 · 실서버 E2E(이탈 뒤 새 탭).
- 프론트 4번 완료: 계약 사본 재생성(ed146adf…, 차이 MatchSlot.skin 1줄) · slotSkins = matchStarting·스냅샷 slots[].skin 우선(없으면 extra.skin → default), "처음 본 값 캐시" 제거 · 회귀 2건(되돌리면 실패 확인) · 리뷰 두 명 확정 0 · test 2,150 · 실서버 E2E 2_NbSKGjrbh3GPFE(3인 ffa, C 이탈 뒤 A 새로고침 → rejoin.match slots에 C skin, 해시 일치, 리플레이 해시 match, 게스트 적립 사유 문구 확인).
- 메인: db:select 2_NbSKGjrbh3GPFE(ffa·win·TURNS 3·참가 3·리플레이 1) · replay API slots에 이탈자 skin 확인 · 스크린샷에서 화면 밖 칩 겹침(나갈C·남는B, 왼쪽 가장자리) 발견 → 프론트 수정 지시.
- 미검증: 비-default 스킨의 실서버 표시(게스트 장착 불가 — 단위 테스트만) · 로그인 경로.
- 사용자 결정 대기: 출시 전 미노출 장치(noindex 7·sitemap·"(미리 보기)" 3) 해제 여부 + /games 색인 메타·JSON-LD의 포트리스(두 리뷰어 지적, 풀면 해소).
- 화면 밖 칩 겹침 수정(프론트): drawScene.ts `offscreenChipLayout` 순수 함수 — 같은 쪽 묶음 세로 쌓기·바닥 되밀기·공간 부족 시 균등 분배, 실시간·리플레이 공용 · 회귀 5건(되돌리면 실패) · 리뷰 두 명 확정 0 · 메인 스크린샷 확인(chips-stacked-replay).
- 후속: 실시간 경기 가로 모드 캔버스 높이 실측(리플레이 가로 218px — 198px 미만이면 칩 상자 겹침) · 짧은 화면 칩 한 줄 축약 · 칩 묶기 기준 +12px(리뷰 제안).

## 2026-11-05 사용자 결정 D-021 · 후속 항목 착수
- 백엔드 후속 판정:
  - 고침: ① 시작 카운트다운 중 제출 거부(새 WS 에러 코드 — 계약 변경, 프론트 사본 갱신) ② 실 Redis E2E에 MATCH_ACTIVATE_SCRIPT v≠1 분기 ③ awardsOf↔playedTurns 연결 테스트
  - 안 고침(근거): FORTRESS_PLAYERS.USER_ID 인덱스 — 지금 USER_ID 단독 조건 쿼리가 없다(fortress-points.service.ts:69는 matchId+userId), "내 경기" 기능 때 함께 · Redis 미준비 시 lazy 조회 404 — 테트리스 결과 조회와 같은 동작(tetris-battle-result.service.ts:128·144), 일시 상태이고 크론이 회수 · 같은 userId 두 자리 pointsOf — 방 서비스가 막는다(fortress-room.service.ts:447)
- 프론트: 장치 해제 · 화면 쪽 후속(가로 모드 높이 실측·짧은 화면 칩 축약·칩 묶기 +12px·BattleMatchViewer flake·프론트가 기록한 후속) · 카운트다운 중 발사 입력 확인
- 백엔드 후속 구현(메인):
  - ① `submit`이 `now < startedAt + MATCH_START_DELAY_MS`면 `MATCH_NOT_STARTED`(fortress-match.service.ts:228) · 계약 `FortressErrorCodes.MATCH_NOT_STARTED` + 메시지 · DESIGN §11 L129·L140 · 계약 sha256 852b59bb…(프론트 사본 갱신 지시)
  - 프론트 질의 답: 일반 경로는 이미 막혀 있다(FortressMatch.tsx:448·451·454 canAim). 구멍은 카운트다운 중 받은 스냅샷 하나(matchFeed.ts:97 `startAt: event.now`).
    - 계약 필드는 추가하지 않는다. 대신 seq===0일 때만 `startAt = 수신 now + max(0, remainingMs − turnMs)`로 계산한다.
    - 근거: :184 첫 마감 = 시작 + 지연 + 턴 길이 · :354 remainingMs. 이후 턴은 마감에 연출 시간이 섞여 이 식을 쓰지 않는다.
  - ② 실 Redis E2E `MATCH_ACTIVATE_SCRIPT`: 키 없음 0 · v1 ZADD · v2(끝남) 뒤 늦은 activate 0 · ZSET 비어 있음
  - ③ fortress-result.service.spec.ts — `baseAwards`에 `turns: turn.no + 1`(playedTurns) 전달 단정 — 변이(turn.no로 바꿈) 시 실패 확인
  - 기존 spec·E2E의 시작 직후 제출을 카운트다운 뒤로 옮겼다.
    - spec: STARTED 상수.
    - E2E: gateway에서 소켓으로 MATCH_NOT_STARTED를 확인한 뒤 startAt까지 실제로 대기하고, 두 테스트 타임아웃을 15초로 늘렸다.
  - 새 단위 테스트(카운트다운 거부)는 가드를 지우면 실패한다(변이 확인).
  - 검증: ci:core EXIT 0(94 suites · 2,159 · 경고 6) · E2E sandbox 밖 `FORTRESS_REDIS_TEST_PORT=6390` 332 통과·실패 0. 테트리스 Redis 4 suite는 opt-in 미설정으로 skip.
  - 참고: test:e2e 설정에서 --testPathPatterns가 걸러지지 않아 전체 E2E가 돌았다.
  - 관찰: DB TURNS(fortress-result.service.ts:187 turn.no)는 단위 테스트가 두 값을 구분하지 못한다(:167 단정이 같은 값인 경기). 의도는 turn.no 유지(rules :55 주석) — 기록만
- 리뷰(두 리뷰어 Opus 정확성 · review-flow): 확정 결함 0 → 루프 종료.
  - 경미 지적 2건은 반영하지 않았다.
    - 레플리카 간 시계 오차로 경계가 ms 단위로 흔들림 — 기존 마감 판정과 같은 전제.
    - 카운트다운 중 거부된 제출도 turnSubmit 빈도 제한(:737)을 소비함 — 프론트가 startAt 전 입력을 canAim으로 막는다(FortressMatch.tsx:454, 프론트 답).

## 2026-11-06 프론트 D-021 완료 보고 · 메인 확인
- 프론트: ci:core EXIT 0(lint 0 · test 2,163/15 skip · build) · review-front 확정 0(절전 중단 뒤 재실행) · Opus 확정 0(후속 2건 재확인 0) · 3000 재기동 `/`·`/games`·`/games/fortress` 200·콘솔 0.
- 출시 장치 해제: 색인 = 홈(/games/fortress, sitemap 0.9)·기록 목록(/battle/matches, sitemap 제외). noindex 유지 = 로비·방·play·skins·개별 경기 공유(테트리스·games-growth D-011과 같은 기준, 메인 동의). "(미리 보기)" 제목 제거 · play "(프로토타입)" 제거 · 설정 배지 문구 교체 · sitemap GAMES_UPDATED 2026-11-05.
- 카운트다운: 사본 852b59bb… · 스냅샷 seq 0 startAt = 수신 now + max(0, remainingMs − turnMs) · MATCH_NOT_STARTED → aim 복귀 + 안내 문구.
- 후속 판정:
  - 고침: 가로 모드 조작부 오버레이 — 전장 812×375 28→195px, 568×320 0→140px · 짧은 화면 칩 한 줄 · 칩 묶기 +12 · BattleMatchViewer flake(부하 재현 1~4/12 → 0/12, 정확한 순간 미확정) · 고아 피드 → 결과 화면 · 포인트 캐시 키 userId:matchId · 미리보기 레이어 해제 · /games 하단 여백.
  - 안 고침(근거 보고): F5 resync 간격(상한 3) · 낭독기 타이머(접근성 별 과제) · 리팩터 2건 · 250ms interval.
- 프론트 질의 답(메인): 정상 종료 방송 순서는 turnResolved(next null) → matchEnded → roomState(RESULT)(match.service :400-413 → room :197 → finishMatch :775-779). matchEnded 없는 경우는 repairEndedMatch(:797-804) 하나 = 고아 경로.
- 메인 스크린샷 확인: land/local-568x320 · local-740x360 · chips-812x375-seed3 · final_games_fortress.
  - 568×320에서 파워 슬라이더 폭이 약 76px로 좁다(조작은 가능 — 기록만).
- **출시 위험 발견**: 포트리스 홈 "최근 경기"에 로컬 E2E 경기 5건이 공개로 보인다(LOCAL=PROD DB). db:select 결과 IS_HIDDEN 0:
  - kYDnp6WGrJZAlFGf 완주 2인
  - zsyeC17SEXu4HCFw 팀전 4인
  - TtiIcWWhHCXZdPU9 재접속
  - PB18N5akGCtMHJqo 마무리
  - 2_NbSKGjrbh3GPFE 이탈 스킨
  - 숨김 여부는 사용자 결정. UPDATE는 사용자가 실행한다.
- 미검증: iOS 실기기 가로·안전 영역 · 실서버 카운트다운 중 재접속(seq 0 스냅샷) · 로그인 경로.

## 2026-11-09 사용자 지시 — 직접 확인 · 테스트 경기 유지
- 백(3500, fortress worktree dist)·프(3000, 프론트 fortress worktree) 기동 확인 — 사용자가 직접 플레이하고 수정 요청 예정
- 테스트 경기 5건 숨김 안 함(사용자 "냅둬도 돼") — 공개 최근 경기에 남는다

## 2026-11-09 사용자 플레이 질문 — 프론트 조사 결과(수정 없음)
- 조작(aimKeys.ts:29-41): ←→ 각도 · ↑↓ 파워 · A/D 이동 · Space 길게 충전(CHARGE_MS 1600, 250ms 미만은 탭=맞춘 값 발사). 둘 다 정수 파워 1~100 하나라 결과는 같다 — 방향키는 정밀, Space는 원작식 타이밍
- 조준 보조: 직선 점선(중력·바람 미반영)·각도/파워 숫자·바람 게이지·지난 값 기억(표시 없음). 궤적 미리보기·지난 발 착탄 표시 없음
- 카메라 원인(코드 판단, 미측정): follow.ts:54-55 쏜 탱크 유지 조건(|Δx|×0.3 ≤ 화면폭−112) — 390폭은 약 927px 넘으면 탱크를 놓으며 목표가 탄으로 급전환("마지막에 따라감"), 1280폭은 끝까지 탱크 유지·줌아웃만
- 로비 채팅: /games/fortress/battle에만. 테트리스는 홈 카드 HomeLobbyChat(최근 3줄 + 입력) 있음 — 포트리스 홈엔 없음
- Playwright 미실시: 체감 명중 난이도 · 실기기 · 핀치 줌 · 모바일 길게 누르기 충전 · 태블릿 · 가로 모드 실서버

## 2026-11-09 D-023 수치 확정(프론트 측정 · 메인 승인)
- 선택: 2인 간격 55%(DUEL_SPAN 1126px) + WIND_MAX 6, ENGINE_VERSION 2. 범위(55~65% · 6~7) 안
- 측정(seed 1~30 × hills/canyon, 첫 턴 무이동): 두 각도 모두 0칸 판 v1 11/30·11/30 → 1/30·0/30 · 45° 평균 칸 1.0·1.4 → 2.0·2.8 · 최대 4칸 그대로(8칸 이상 0) — 여전히 파워 ±1 정확도 필요
- AI(프론트 전용 `ai/`, 매니페스트 밖): v2에서 상급 67%로 올라 파워 오차 8·4·1 → 16·9·3, 명중률 하 6% · 중 24% · 상 54%(v1 9·24·50)
- 바람 게이지 색 기준 7·4 → 비율 70%·40%. v1 기록은 "재생할 수 없어요" 안내(테스트 고정), v1 엔진 동결 보관 안 함
- 남은 것: 프론트 최종 매니페스트 sha256·파일 목록 → 메인 사본 복사·golden spec 버전 2·ci:core·E2E

## 2026-11-09 백엔드 엔진 v2 사본 반영(D-023)
- 복사: engine `__fixtures__/golden-matches.json`·`constants.ts`·`state.ts` + `fortress-engine-manifest.json`(프론트 ENGINE_MANIFEST sha 56386ce5… 일치, 엔진 sha 4df48ae4…). 나머지 10개 cmp 동일. 리뷰로 엔진이 또 바뀌면 재복사
- 테스트 수정: golden spec 버전 단정 1 → 2 · room spec engineVersion 하드코딩 → ENGINE_VERSION · result spec F7 골든 경기를 `ffa 2인 canyon AI 하·상`(v2에서 3발로 끝나 "6턴 이상" 전제 깨짐) → `ffa 2인 hills AI 중·중`(25발, slot 0 승)으로, 기대 승자 반대로
- 저장 리플레이·E2E의 engineVersion 1 값은 저장 데이터라 그대로
- ci:core EXIT 0(94 suites · 2,159 tests · 경고 6) · 3500 v2 dist로 재기동 200
- E2E(sandbox 밖, Redis 6390): 332 passed · 0 failed · 58 skipped(테트리스 Redis opt-in) — v1과 같은 수

## 2026-11-09 프론트 D-022·D-023 완료 보고 · 메인 확인
- 프론트 ci:core EXIT 0(2,181 tests · 15 skip) · 리뷰 2명 2차 확정 0 · 회귀 테스트 되돌림 실패 확인 · 3000 200
- 조작: ←→/A·D 이동(반대쪽 첫 입력은 돌아서기) · ↑↓/W·S 포신 높이 0~90 · Q/E 파워 ±1 · Space 충전 · 모바일 ◀▶▲▼
- 카메라: 탄 하강 시 쏜 탱크 해제 + 앞자리 18틱(상한 0.3) — 390에서 탄이 화면 40~70% 유지(전: 오른쪽 끝)
- 조준 보조: 궤적 앞 ⅓(applyAction 미확정 실행 샘플, 엔진 수정 없음) · 지난 발 X·문구·눈금 · 홈 로비 채팅 카드(공용 HomeLobbyChatCard)
- Playwright 9개 크기 AI전 실제 조작 명중 2~7발 · 44px 미만 타깃 0 · 최소 글자 11px · 가로 스크롤 0 · 콘솔 0 · 실서버 2탭(390 세로·812 가로) 통과
- 난이도 봇 모의(1:1 AI 중, 12발 상한): 명중 28% → v2 62% → v2+보조 70%, 3발 안 11% → 28%
- 메인 스크린샷 검토: 승인 + 수정 2건 지시 — ① 568×320 "연료" 라벨 세로 꺾임 남음 ② 왼쪽 볼 때 HUD가 내부 각도(120°) 표시 → 높이 0~90° + 방향 표기
- 미검증: 실기기·핀치 줌·저사양 기기 궤적 재계산 체감

## 2026-11-09 D-024 카메라 — 중간 보고와 턴 대기 결정
- 프론트 중간 보고 (같은 엔진 이벤트를 60fps로 모의, 3크기 × 5발, 수정 전 → 후)
  - 비행 중 줌 목표 변경: 1~76 → 0회
  - 줌 왕복: 1~13 → 0회
  - 가로 반전: 1~9 → 0회
  - 세로 반전: 2~12 → 0회. 예외는 휴대폰 가로에서 높은 탄을 쏠 때 정점의 1회
  - 프레임당 최대 이동: 48~96px → 5~24px
  - 탄이 화면 밖으로 나감: 0
- 연료 줄바꿈과 각도 표시(◀/▶ + 0~90°): 5크기 재측정 결과 이상 없음
- 남은 문제: 리플레이와 AI 연속 턴에서 다음 발이 카메라 도착 전에 나가 화면이 한 번에 넘어감(컷)
  - 리플레이 휴대폰 세로: 43%
  - AI 턴: 16% (AI 지연 450ms가 착탄 후 머무름 700ms보다 짧음)
- 사용자 결정(2026-11-09): "이번에 넣기"
  - 리플레이 턴 사이와 AI 발사가 카메라 도착을 기다리게 함(약 0.5~1초)
  - 움직임 줄이기 설정에서는 대기를 더하지 않음
  - 프론트에 지시 완료

## 2026-11-10 D-024 턴 대기 구현 (프론트 보고)
- AI 발사와 리플레이 자동 재생(둘째 턴부터)은 카메라가 준비되면 바로 쏘고, 늦어도 1초 안에 쏜다.
- 움직임 줄이기·추적 꺼짐·캔버스 없음이면 기다리지 않는다. 사람 차례는 변경 없음.
- 컷 비율 (전→후)

  | 화면 | 리플레이 | AI |
  |---|---|---|
  | 390×844 | 46.4→6.9% | 20.8→3.4% |
  | 812×375 | 8.8→2.4% | 4.8→1.4% |
  | 1280×800 | 25.2→0% | 14.2→0% |

- 대기 시간: 중앙값 0ms, 상위 10%는 0~750ms, 최대 1초.
- 검증과 리뷰
  - lint 0, typecheck 통과, 포트리스 테스트 246개 통과.
  - 4차 리뷰에서 확정된 2건(회전, "내 탱크로" 다시 계획)을 고쳤다.
  - 남은 것: 5차 리뷰 → ci:core → 최종 보고.

## 2026-11-10 D-024 최종 (프론트 보고 + 메인 확인)
- **리뷰**: review-front는 5·6·7차 모두 0건. Opus는 5차 2건, 6차 1건을 고쳤고 7차 0건.
- **검증**
  - ci:core EXIT 0: 2,204 통과, skip 15. lint·typecheck·build 통과.
  - 엔진 폴더 변경 0, 골든 통과.
- **수치**
  - 비행 중 줌 변경과 반전이 0이 됐다.
  - 프레임당 이동이 48~96px에서 5~24px로 줄었다.
  - 컷 비율 표는 위 11-10 절과 같다. 30~240Hz 12종에서 화면 밖 0.
- **회귀 테스트**: follow.test 18개, cameraWait, FortressReplay.wait 5개, FortressMatch.aiwait 5개.
- **메인 캡처 확인**
  - after-max-390x844 0.1초 시트: 비행 중 줌 고정, 방향 반전 없음. 착탄 뒤 머문 다음 P2로 한 번 이동한다.
  - 568x320-aim-assist: 연료 줄바꿈 없음, ▶45°로 표시된다.
  - q2/match-aim-390x844: ▶60°, "제자리 · 남음 100".
- **미검증**: 실기기(iOS·Android), 핀치 줌, 실제 고주사율 화면.
- **남은 한계**
  - 390 리플레이 컷 6.9%
  - 240Hz 극단적 지터에서 1.4px 벗어남
  - 움직임 줄이기 + 812 높은 포물선은 고정 화면이라 탄이 화면 밖으로 나간다(정책).
- **UI 개선 후보 8개**: 캡처는 프론트 scratchpad q2/에 있다. D-025 B로 진행한다.

## 2026-11-10 D-025 A 완료 (프론트 보고)
- **범위**
  - 혼자하기 경기·다시 보기에 내 장착 스킨을 적용한다.
  - #6 홈 상단 내 스킨 버튼(테트리스 MySkinButton과 같은 자리).
  - #7 대기실 탱크 미리보기와 "스킨 바꾸기 ↗"(새 탭).
- **검증**
  - 리뷰: review-front 1→0, Opus 3→0.
  - ci:core EXIT 0, 2,231 통과.
  - 엔진·ReplayData에 스킨이 들어가지 않는다. 해시는 그대로.
- **캡처**: 프론트 scratchpad d025/에 있다. 메인이 home-login-390과 solo-aim-390을 확인했다.
- **메인 답변(백엔드 계약)**
  - slot = 시작 순간의 roomState.players 인덱스(입장 순, 나가면 당겨짐).
  - 스킨 반영: 입장 때와, 같은 계정이 다시 들어올 때(refreshSkin). 진행 중 경기는 고정.
- **미검증**
  - 실제 카카오 로그인 상태
  - 로그인 사용자 스킨이 대기실에 그려지는지
  - 4인 대기실의 이름표 여유
- **다음**: 공용 GamePad 적용 → B 시안.

## 2026-11-10 D-025 보충 2 공용 패드 완료 (프론트 보고 + 메인 확인)
- **변경**
  - 공용 GamePad에 `disabled?`와 `onHoldEnd(press, cancelled?)`를 추가했다. 하위 호환이다.
  - 테트리스 영향 0의 근거: 호출부 2곳이 두 번째 인자를 무시한다. 테트리스 테스트 757개가 통과한다.
  - 포트리스는 터치에서만 패드를 쓰고, 데스크톱 화면은 그대로다.
- **리뷰**
  - review-front: 4 → 1 → 0 → 0 → 0
  - Opus: 3 → 1 → 1 → 0 → 0
  - 고친 결함 8건, 각각 회귀 테스트가 있다.
- **검증**: ci:core EXIT 0(2,255 통과). 엔진과 D-022 키 매핑은 바뀌지 않았다.
- **전장 높이**
  - 390 세로: 497 → 550
  - 360 세로: 393 → 453
  - 812 가로: 195 → 249
  - 568 가로: 140 → 194
- **메인 캡처 확인**
  - weapon-390x844: 무기 순환 표시가 "대형탄"으로 바뀐다.
  - charge-812x375: 충전 표시 "파워 55", 연료 0 문구, 수치 띠 한 줄.
- **미검증**
  - iOS·Android 실기기: 길게 누르기 제스처 차단, :active 표시, inert
  - 812에서 십자 팔이 42px다(판정 영역은 127px 정사각형 전체).
- **다음**: D-025 B 시안

## 2026-11-12 D-025 B — HUD·조작부·결과 단계 (프론트 보고, 메인 리뷰)

- 프론트 구현 (커밋 없음)
  - 톤: 장난감 상자. 남보라 판, 잉크 외곽선 #160b1c, 아래 두께, 노랑·보라 3D 버튼. `fortressVivid.module.css`는 `.vivid` 루트에서만 적용된다.
  - 공용 GamePad와 테트리스는 변경이 없다. 패드는 data-testid로만 고른다.
  - 화면 밖 적 칩: drawScene vivid 분기. 결과 화면: FortressResultVivid.
  - 배너·연기 겹침: 배너 뒤에 짙은 판(#241a4a, 92%)을 깐다. 엔진 틱과 배너 시간은 그대로다.
- 검증 (프론트 보고)
  - typecheck 통과, fortress eslint 0, fortress 테스트 47 files / 308 tests 통과
  - 390·812·1280 경기와 결과 화면에서 브라우저 콘솔 오류 0
  - 그리기 시간: hills 35.1ms, canyon 41.9ms (p95 58.1, 1회 측정)
- 메인 리뷰 (캡처: 프론트 scratchpad b/hud-sheet.png, b/result-sheet.png, b/burst/hills-1280x800-w2-25.png)
  - 방향은 통과다. 모바일 390·812, 결과 390, 배너 판 모두 양호하다.
  - 수정 요청 3건:
    - ① 결과 1280: 열이 약 270px로 너무 작다.
    - ② 데스크톱 1280 아래 조작 띠의 라벨·키 힌트·무기 글자가 작고 대비가 낮다.
    - ③ 구덩이 왼쪽 벽 세로 잉크선. 프론트는 범위 밖으로 미뤘으나 메인 판단으로 이번에 고친다. 그리기에서만 고친다.
- 미검증: iOS Safari 실기기(3D 그림자·accent-color), 온라인 경기 타이머 알약 실화면(로그인 필요)
- 수정 3건 완료, 메인 통과 (전후 캡처: 프론트 scratchpad b/result1280-compare.png, b/deck-compare.png, b/crater-compare.png)
  - ① 결과 1280 → lg에서 두 열(각 약 470px). 1280×800에서 버튼까지 스크롤 없이 보인다. 390은 변화 없다.
    - 정정: 메인이 처음 지적한 "약 270px"는 축소된 시트로 잰 값이다. 실제 열은 448px였다.
  - ② 데스크톱 조작 띠를 판 3개(조준·무기 / 이동·포신 / 파워·발사)로 묶었다.
    - 각도·파워 숫자 26px, 라벨 13px, 키 힌트는 금색이다.
    - ≥1024px이고 높이 >500일 때만 적용한다.
  - ③ 구덩이 벽 세로선
    - 원인: 얇은 지표 밑이 빈 열에서 벽 외곽선을 통째로 그었다.
    - 수정: vividWorld.ts sideWall이 흙 구간과 겹치는 범위만 긋는다. 그리기만 바꿨고 테스트 3개를 추가했다.
  - 검증 (프론트 보고): typecheck 통과, eslint 0, 48 files / 311 tests 통과, 콘솔 오류 0
- 다음: 후처리(three) → 측정 → 리뷰 루프 → ci:core → 최종 룩 리포트

## 2026-11-12 D-025 B — 후처리(glow, three) 단계 (프론트 보고, 메인 리뷰)

- 구현: `?look=glow` = vivid에 빛을 더한 층
  - 구성: 빛(bloom), 충격파 빛, 큰 폭발 섬광
  - three는 renderer/glowPost.ts에서만 동적 import한다. 코어만 쓴다.
  - 1/4 해상도로 샘플링하고, 밝고 채도 높은 곳만 빛을 낸다. 출력은 0.5배 해상도이며 screen 블렌드로 겹친다.
  - 스스로 꺼지는 조건: WebGL 실패, context lost, 후처리 평균 6ms 초과. 꺼지면 vivid 그대로다.
- 실측 (프론트 보고)
  - SwiftShader: 자동으로 꺼지는 것을 확인했다.
  - GPU(ANGLE Metal M2 Pro): 층이 켜지는 것을 확인했다.
  - GlowLayer 테스트 6개. '느리면 꺼짐'은 해당 줄을 빼면 실패하고 되돌리면 통과한다.
  - typecheck 통과, eslint 0
- 메인 리뷰 (캡처: 프론트 scratchpad b/glow-vs-vivid.png)
  - 구조는 통과다.
  - 시각: 정점의 따뜻한 빛은 좋다. 정점 앞 컷은 불덩이 잉크 외곽선이 흐려져 vivid와 차이가 작다.
    - 요청: 세기와 문턱은 한 번만 조정한다.
    - 채택은 사용자 결정이다. 근거는 fps, gzip, 번들 분리 증명, 비교 캡처다.
- 메인 승인: ci:core build 때 dev 3000을 잠시 내렸다가 다시 띄운다. 로컬 dev 서버에만 영향이 있다.

## 2026-11-12 D-025 B — 최종 리포트 (프론트 보고, 메인 리뷰)

- 상태: 리뷰 루프 3차에서 두 리뷰어 모두 0건이다. 1차 20건과 2차 2건은 반영했고, 고친 줄을 되돌리면 실패하는 회귀 테스트를 확인했다.
- ci:core (next-bun): EXIT 0
  - lint 0, typecheck 통과
  - 257 files / 2286 tests 통과 (15 skipped)
  - next build 성공
  - dev 3000은 재기동 후 200
- 측정: CPU 4× 스로틀 + 실제 GPU(M2 Pro)
  - hills·canyon × 390·1280 × classic·vivid·glow 12조합 모두 114.9~118.7fps, p95 약 9.2ms
  - canyon 390을 20×로 올리면 vivid 79fps이고 glow는 스스로 꺼진다.
  - 한계: M2 Pro라 저가 실기기 판정은 미검증이다.
- 자동 품질 하향: jankJudge가 최근 120프레임 간격으로 판정하고, 30Hz 고정 기기는 제외한다. 순서는 glow 끄기 → quality low다. 이 기기에서는 발동하지 않아 단위 테스트로만 확인했다.
- glow 자료
  - fps 차이 -0.8~+0.2로 편차 범위 안이다.
  - three 청크 gzip 118.2KB(raw 488.6KB). 초기 로드 manifest에는 0건이다.
  - /, /games, /games/fortress 청크의 WebGLRenderer는 0건이다.
  - 세기를 1.8→1.2, 흐림을 2→1회로 한 번 조정했고 잉크 외곽선이 유지된다.
- 메인 리뷰 (캡처: 프론트 scratchpad b/final-aim-390.png, b/weapons-ingame.png, b/tanks-vivid/levels-all.png, b/glow-zoom.png)
  - classic 대비 다른 게임 수준으로 바뀌었다.
  - 무기 6종 실경기 연출이 서로 구분된다. 3연발은 파랑, 분열탄은 보라, 메가탄은 충격파·버섯구름, 폭격은 불기둥이다.
  - 스킨 4종 × Lv1~5가 모두 구분된다.
  - 통과.
- 남은 것
  - 1280 원거리 카메라에서는 폭발이 작게 보인다. 최소 34px 보정이 있다.
  - 실기기(저가 안드로이드·iOS Safari·Windows glow)는 미검증이다.
  - 온라인·리플레이·프리뷰 확대는 채택 뒤 작업이다.
- 사용자 결정 대기
  - ① vivid 기본 채택. 프론트 권장: 채택
  - ② glow 유지. 프론트 권장: 보류하고 three를 되돌림(파일 삭제 승인 필요)
- 사용자 결정 (DECISIONS D-025 보충 5)
  - vivid를 기본 화면으로 채택한다.
  - glow는 유지하고 `?look=glow` 선택지로 둔다.
  - 프론트에 기본 전환과 적용 확대를 지시했다.
- 온라인 경기 캡처 승인 (2026-11-12, 사용자 "허용 (기록 남아도 됨)")
  - DB 쓰기 시점: 경기가 ENDED일 때 1회.
    - 근거: fortress-result.service.ts:150·152·273~277
  - 기록되는 것: FORTRESS_MATCH 1행, FORTRESS_PLAYER는 인원수만큼(게스트는 USER_ID null), FORTRESS_REPLAY 1행.
    - 게스트만 있으면 포인트를 쓰지 않는다(fortress-points.service.ts:41).
  - 탭을 닫아도 끊김 유예 뒤 스위퍼가 resign을 넣는다. 그러면 ENDED → 저장된다(fortress-match.service.ts:421~425). 경기를 시작하면 결국 기록이 남는다.
  - 범위: 게스트 2명만, 원칙 1판(재시도 포함 최대 2판). 프론트가 matchId를 보고한다.
- 온라인 경기 캡처 실행 결과
  - 프론트 세션의 auto mode classifier가 막아서, 사용자가 메인 창에서 `! node .../d025b5/online.cjs`로 직접 실행했다. 1판이다.
  - 출력
    - room RFEWKJ, looks vivid×2
    - 타이머 알약 390 "⏱ 21초" / 1280 "⏱ 20초"
    - resultVivid true, errors []
  - matchId: WQdOdZHQtWqAXqWg
    - 메인 db:select 확인: PLAYERS 2, USER_ID 있는 행 0, REPLAYS 1. 승인 범위와 같다.

## 2026-11-12 D-025 보충 5 — vivid 기본 전환 완료 (프론트 보고, 메인 리뷰)

- 동작
  - ?look이 없으면 vivid다.
  - ?look=classic을 쓰면 탭 sessionStorage에 기억해서, 쿼리 없는 링크로 옮겨도 유지된다.
  - ?look=glow는 선택지로 둔다.
  - 전체 되돌리기: lib/look.ts의 DEFAULT_LOOK을 "classic"으로 바꿔 배포한다.
- 적용 범위: 솔로, 온라인 경기·결과, 리플레이, 기록 보기, 스킨·방·홈 미리보기
  - 미뤘던 origTop·tint 초기화를 이번에 처리했다.
- 테스트
  - classic 기본을 가정한 테스트 3개를 고쳤다(FortressPrototype.test, look.test, FortressMatchViewer.test).
  - 새 테스트를 추가했고, 고친 줄을 되돌리면 실패하는 것을 확인했다.
- 리뷰 루프 3차에서 두 리뷰어 0건
  - 2차 지적: CSS 모듈이 Tailwind 클래스 선택자까지 해시해 규칙이 무효였다 → :global로 고쳤고 실브라우저에서 확인했다.
- ci:core (next-bun): EXIT 0
  - 259 files / 2296 tests 통과, build 성공
  - three 청크는 초기 로드에 없다.
  - dev 3000은 재기동 후 200
- 메인 리뷰 (캡처: 프론트 scratchpad d025b5/)
  - 통과. 다만 작은 수정 2건을 요청했다.
    - ① 리플레이 390에서 화면 밖 칩이 가장자리 탱크를 덮는다.
    - ② 온라인 결과 순위 표가 솔로 vivid 카드 행과 다르다.
- 범위 밖, 후속 후보
  - 홈 상단 히어로(밤 배경), 로비 메뉴, 대기실 틀(설정·플레이어 카드)은 아직 기존 스타일이다.
- 미검증
  - iOS Safari 실기기, 저가 실기기 성능
  - 로그인 사용자 화면(장착 스킨·포인트 결과)
  - noopener 새 탭에서 classic 탭 기억이 이어지는지
- 추가 수정 2건 완료, 메인 통과 (전후 캡처: 프론트 scratchpad d025b5/fix2-compare.png)
  - ① drawScene.ts avoidOnscreenTanks
    - 화면 밖 칩이 가장자리 탱크와 겹치면 위·아래로 비키고, 비킬 수 없으면 반투명으로 그린다.
    - vivid에서만 적용하고 classic은 그대로다. 테스트 2건은 가드를 빼면 실패한다.
  - ② FortressResultTable.tsx
    - vivid면 카드 행(순위 배지, 1위 금테, 피해 막대)으로 그린다. 목록은 role=list다.
    - classic은 기존 표 그대로다.
    - 온라인 결과와 기록 보기에 적용한다.
  - 검증 (프론트 보고): typecheck 통과, eslint 0, fortress 54 files / 343 tests 통과
    - 리뷰 1라운드에서 두 리뷰어 결함 0건
    - 재캡처는 기록 보기 GET으로만 했다. 경기는 더 하지 않았다.
  - 메인 요청: 수정이 ci:core 뒤에 들어가서 최종 ci:core를 1회 다시 돌린다.
- 최종 ci:core 재실행 (next-bun): EXIT 0
  - lint 0, typecheck 통과
  - 259 files / 2298 tests 통과 (15 skipped)
  - build 성공
  - dev 3000은 재기동 후 200
  - 로그: 프론트 scratchpad ci-core-s5b.log
- D-025 B와 보충 5는 코드 기준 완료다. 커밋은 하지 않았고, 사용자 지시를 기다린다.

## 2026-11-12 D-025 보충 6 — 사운드 조사 (프론트 보고)

- 테트리스·디펜스는 WebAudio 합성만 쓴다. 음원 파일은 0개(public/ 검색 0건)라 라이선스·새 의존성 이슈가 없다.
- 공용 모듈
  - _shared/lib/webAudio.ts
  - _shared/lib/soundSettings.ts: 'games:sound', 기본 sfx·music 꺼짐
  - _shared/hooks/useSoundSettings.ts
  - _shared/lib/soundUnlock.ts
  - _shared/components/GameSettingsButton.tsx
  - SoundSettingsSection
  - _shared/lib/vibrate.ts
- 테트리스 전용 패턴
  - soundPlayer: voice 상한 24, 중요도, 효과음 버스 0.8 / 배경음 버스 0.35, 25ms 스케줄러
  - 진동 키 tetris:settings.vibration
  - 탭이 숨겨지면 pause와 함께 음악을 끈다.
- 포트리스 현재 상태: 소리 코드 0건
- 계획
  - fortress/lib/sound/(cues·recipes·player)를 테트리스 구조로 만든다.
  - useBattleView에서 onCue를 받는다.
  - 경기 화면·리플레이 머리줄에 GameSettingsButton을 둔다.
  - 진동 키 fortress:settings.vibration, 기본 켜짐
- 메인 추가 조건
  - reduced-motion이면 진동을 끈다.
  - _shared를 고치면 선택 인자만 추가하고, 테트리스·디펜스 동작이 그대로임을 테스트로 보인다.
  - 리플레이 빨리 감기·되감기 때 소리가 몰려 나지 않게 한다.
- 사운드 구현 완료, 메인 통과 (캡처: 프론트 scratchpad d025b6/settings-sheet.png)
  - 구성
    - fortress/lib/sound/(recipes·player·useResultMusic), lib/fortressSettings.ts, FortressSettingsSheet.tsx
    - 공용 _shared는 변경 0
    - 합성만 쓴다(파일·의존성 0).
  - 동작
    - 몰린 신호는 중요도순 4개만 낸다.
    - 탭이 숨겨지면 배경음을 멈추고 효과음은 버린다.
    - 리플레이 goTo는 소리를 내지 않는다.
    - reduced-motion이면 진동을 끈다.
  - 검증 (프론트 보고)
    - games 219 files / 1852 tests 통과(테트리스·디펜스 포함)
    - typecheck 통과, eslint 0
    - 실브라우저: 소리를 끄면 AudioContext 0, 켜면 첫 클릭 뒤 running
  - 미검증: 실제 청취, iOS unlock, 진동 실기기
  - 다음에 고칠 것: 390 머리줄에서 톱니가 늘어 P2 칸이 잘린다. B단계에서 고친다.
- B1 타격감 완료, 메인 통과 (캡처: 프론트 scratchpad d025b6/b1-hit.png, b1-kill.png, b1-kill-after.png)
  - 피해 숫자 4단계
    - 20 미만 22px, 20~29 28px, 30~44 34px + '강타!', 45 이상 40px + '치명타!' + 별빛
    - 겹친 숫자는 쌓아 올린다.
  - 피격: 번쩍임과 피해 비례 흔들림(상한 8px)
  - 격파: 잔해에서 연기가 계속 오른다.
  - reduced-motion이면 튐·별빛·흔들림·번쩍임을 끈다.
  - 성능: canyon 390, CPU 4× 기준 vivid 118.0fps / glow 117.9fps
  - 메인 지적 2건(B2와 함께 처리)
    - ① '치명타!' 문구가 위 숫자(-17)에 붙은 것처럼 읽힌다.
    - ② 화면 밖 칩(P1)이 가장자리 P2 탱크 이름표를 덮는다. avoidOnscreenTanks가 이 경우를 놓친다.
- B2 무기 고르기 + B1 지적 2건 + 390 머리줄: 완료, 메인 통과
  - 캡처: 프론트 scratchpad d025b6/b2-1280-sheet.png, b2-390-sheet.png, header-sheet.png, b2-kill-after.png
  - 지적 ① '치명타!'를 자기 숫자의 부제로 옮겼다.
  - 지적 ② 칩 회피 상자를 실제 이름표 좌표로 계산하도록 고쳤다.
    - 원인: 상자 위쪽 어림이 실제보다 7~10px 낮았다.
    - 회귀 테스트는 위로 비키는 배치에서 zoom 3종을 확인한다.
  - B2
    - WeaponIcon(SVG) 6종을 데스크톱 무기 버튼과 패드 순환 버튼에 넣었다.
    - 대기 턴 배지를 추가했다.
    - 필살기를 고르면 무기·발사 버튼에 금빛 맥박이 돈다.
    - 포구 앞에 고른 무기의 탄을 표시한다(Aim.weaponId, 그리기 전용).
  - 머리줄: 칸을 같은 폭으로 나누고 640px 미만에서는 HP 숫자를 숨긴다. 360·390에서 4명이 스크롤 없이 보인다(실측).
  - 검증 (프론트 보고): fortress 58 files / 370 tests 통과, typecheck 통과, eslint 0
- B3 조준·턴 연출 완료, 메인 통과
  - 캡처: 프론트 scratchpad d025b6/b3-390-sheet.png, b3-charge-crop.png
  - 충전
    - 파워에 비례해 탱크가 움찔한다.
    - 발사 버튼이 0.42초 주기로 맥박친다.
  - 화면 속 바람
    - hills는 나뭇잎, canyon은 모래 알갱이
    - 개수와 속도는 바람 세기에 비례한다. low에서는 절반, reduced-motion에서는 0이다.
  - 내 차례 시작: 금빛 두 겹 고리가 0.9초 동안 퍼진다.
  - D-024 카메라 규칙은 그대로다. 줌과 흔들림은 추가하지 않았다.
  - 데스크톱 무기 아이콘을 26px로 키웠다. 머리줄 HP 숫자는 3명 이상일 때만 숨긴다.
  - 검증 (프론트 보고)
    - fortress 58 files / 371 tests 통과, typecheck 통과, eslint 0
    - CPU 4× 기준 vivid 117.2~118.0fps
- B4 결과 화면 완료, 메인 통과
  - 캡처: 프론트 scratchpad d025b6/b4-390-sheet.png, b4-solo-1280.png, b4-viewer-390.png
  - resultFlair.tsx 공용 조각: 카운트업, 피해 막대, 등급 배지, 꽃가루, 승자 탱크 포즈
    - 등급 점수: 준 피해 + KO×40 + 승리 60
    - 등급 기준: S 200↑ / A 120↑ / B 60↑ / C
  - 솔로·온라인·기록 보기에 공통으로 적용했다.
  - reduced-motion이면 숫자를 바로 최종값으로 보이고, 꽃가루와 포즈는 없다.
  - 검증 (프론트 보고): games 221 files / 1869 tests 통과, typecheck 통과, eslint 0, 실브라우저 콘솔 오류 0
  - 메인 지적 2건
    - ① 카운트업 중 버튼이 흐려 보인다. 비활성이면 바로 누를 수 있게 하고, 페이드인이면 0.4초 안에 끝낸다.
    - ② 기록 보기의 다시 보기·공유 버튼을 3D 톤으로 맞춘다.
  - 다음: 전체 리뷰 루프 → ci:core → 최종 보고

## 2026-11-12 D-025 보충 6 — 최종 (프론트 보고, 메인 리뷰)

- 범위: 사운드와 게임 UI 2차(B1 타격감 / B2 무기 / B3 조준·턴 / B4 결과)
  - 공용 _shared는 변경 0이다.
  - 엔진, 키, 패드 동작, 백엔드 계약은 그대로다.
  - classic 그림은 그대로다. 소리와 설정 버튼만 look과 무관하게 들어간다.
- 리뷰 루프 3차에서 두 리뷰어 0건
  - 1차 차단 2건
    - 설정 시트 뒤에서 Space로 발사됐다 → settingsOpen이면 조준과 AI를 멈춘다.
    - 데스크톱 무기 버튼에 접근 이름이 없었다 → aria-label을 넣었다.
    - 두 건 모두 예전 코드에서 실패하는 회귀 테스트를 넣었다.
  - 메인 지적 2건 반영
    - 결과 버튼 흐림은 opacity 페이드였다. 그동안에도 눌린다. 0.22초로 줄였다.
    - 기록 보기 버튼을 3D로 바꿨다.
- ci:core (next-bun): EXIT 0
  - 264 files / 2333 tests 통과, build 성공
  - dev 3000은 재기동 후 200
  - 로그: 프론트 scratchpad ci-core-s6.log
- 성능: CPU 4× 기준 12조합 109.8~117.8fps, p95 9.2~10.1ms. three 청크는 초기 로드에 없다.
- 메인 리뷰 (캡처: 프론트 scratchpad d025b6/supp6-summary.png, fix-fire.png, fix-css-check.png): 통과
- 미검증
  - 실제 소리 청취와 iOS 자동재생: 사용자 확인
  - 진동 실제 느낌
  - 사람이 이긴 판의 꽃가루
  - 온라인 결과 실화면
  - 저가 기기 성능
- 커밋은 하지 않았다. 사용자 지시를 기다린다.
- 2026-11-12 팀 닉네임 병행 작업 진행 상황 (bun-fd 알림)
  - 사용자 테스트가 끝났다.
  - DB에 마이그레이션 073·074가 적용됐다.
  - develop → main 배포를 진행 중이다(백엔드 먼저).
  - 포트리스 PR 때 develop을 반영한 뒤 확인할 것: app.module.ts, 마이그레이션 순서(D-026)

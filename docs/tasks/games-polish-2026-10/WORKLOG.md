# 게임 출시 후 전수조사 — 작업 기록

> 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 절을 찾는다.

## 2026-10-23 — 착수
- base: `git worktree add .claude/worktrees/games-polish feat-onam-games-polish` (`origin/main` `ef9459b`)
- 조사 분담: 백 A(테트리스 싱글 `src/modules/games/tetris-*` + 대전 `src/modules/tetris-battle/`) · 백 B(디펜스 `src/modules/games/defense-*` + 공용 `games.*`·`game-session`·랭킹·리플레이·공유) · 프 `next-bun-80`
- 제외: `../tetris-audit-2026-10/` 수정 완료분(재지적 금지). 그 문서의 "보류" 항목(BE-11·BE-15~18·BE-21·FE-22)은 재평가 대상

## 2026-10-23 — 백 B 조사(디펜스·공용) 결과 · 메인 재확인
- 범위: `games.service/controller/dto/error.dto`·`game-session.service`·`game-engine.registry`·`ranking-period`·`weekly-board`·`player-name-policy`·`defense-game-engine`·`defense-verify(.worker/.service)`·`verify-worker-pool`·`defense-engine/{replay,game,random,index,combat,state,data/stages,data/rules}`·Entity `GameScore`·`GameReplay`·게임 마이그레이션 5. 미열람: `augment/status/spawn/wavegen/damage.ts`·`data/*`(엔진 규칙 영역)
- H 0건. 재확인 열: ✅ 원본 대조 확정 · ⚪ 미재확인(L)

| ID | 위치 | 요지 | 분류 | 심각도 | 수정안 | 계약 | 재확인 |
|---|---|---|---|---|---|---|---|
| BD-01 | `games.service.ts:177,185` | 세션 소모가 검증 뒤 — 같은 세션 동시 N건이 모두 워커 CPU 사용 후 1건만 성공, 워커(레플리카당 1·대기열 4) 포화로 정상 유저 503 | 성능·버그 | M | 검증 전 Redis `SET NX EX` 검증 락, 못 잡으면 409 | 없음 | ✅ |
| BD-02 | `games.service.ts:178-182` · `verify-worker-pool.ts:226` | 결정적으로 5초 넘는 리플레이는 503+세션 유지 무한 반복. defense DESIGN 배포 직후 조치에 "넘으면 타임아웃 반복 시 소모·422" 조건부 후속 | 버그 | M→L(실측 2초 이내면) | 세션별 타임아웃 횟수 INCR, 2회↑ 소모·422 | additive | ✅ |
| BD-03 | `games.service.ts:185-221` | 세션 소모 후 저장 트랜잭션 실패 시 500, 재시도 409 → 판 기록 유실(순위 계산만 보호) | 버그 | M | 저장 실패 시 세션 복구(`SET NX`, 남은 TTL) + 503 | 500→503 | ✅ |
| BD-04 | `games.service.ts:154-162,170,190` | 409·422가 사유(엔진 버전·만료·시간초과·미시작·재현실패)를 구분 못함 — 배포 직후 옛 탭은 "만료"로만 보임 | 사용성 | M | 에러 `details.reason` additive | additive(프론트 확인) | ✅ |
| BD-05 | `games.service.ts:185-196` | 주간 보드는 seed 동일 → 유효 리플레이 1개를 새 세션으로 반복 제출해 랭킹 도배 가능. games D-004 "1인 최고점 1개 vs 모든 기록" 미확정(DESIGN에도 결정 문구 없음) | 버그(정책) | M | 리플레이 해시 유니크 또는 1인 1기록 | 정책·계약 결정 필요 | ✅ |
| BD-06 | `games.controller.ts:164,181,198` | 공개 GET에 Cache-Control 없음 | 성능 | L | 짧은 max-age | 없음 | ⚪ |
| BD-07 | `games.service.ts:317-319` | 순위 COUNT 3회 순차 await | 성능 | L | Promise.all 또는 단일 쿼리 | 없음 | ⚪ |
| BD-08 | `defense-engine/data/stages.ts:238,247` | 주간 stage를 검증마다 재생성 — 워커 내 캐시 여지(Stage 불변 확인 필요) | 성능 | L | 워커 LRU | 없음 | ⚪ |
| BD-09 | `defense-engine/combat.ts:107-136,309-318` | 핫패스 객체 할당 — 엔진 사본 수정 필요 | 성능 | L | 후순위 | 엔진 사본 동기화 | ⚪ |
| BD-10 | `game-session.service.ts:29,70` · `games.service.ts:173` | `session.userId` 미사용, `boardKey ??` 레거시 폴백 도달 불가 | 리팩토링 | L | 제거 | 없음 | ✅(173) |
| BD-11 | `defense-verify.ts:5-8` 외 3곳 | 보드 키 해석 4곳 분산 — 시즌 올리면 어긋남, 테스트 공백 | 리팩토링 | L | 시즌 키 포함 테스트 + 판정 일원화 | 없음 | ⚪ |
| BD-12 | `tetris-game-engine.ts:48-52` | 테트리스 검증은 메인 루프 동기 실행, 최악 실측 없음 / 워커 풀 디펜스 이름 고정 | 성능·리팩토링 | L | 최악 측정 후 판단 | 없음 | ⚪ |
| BD-13 | `defense-verify.service.ts:10` | 워커가 빌드 `.js`만 — `pnpm dev:tsx`(package.json:69)로 띄우면 디펜스 제출 전부 503 | 버그(개발 환경) | L | 부팅 시 존재 검사·명시 실패 | 없음 | ✅(dev:tsx 존재) |
| BD-14 | `games.controller.ts:117-119` | 풀 비활성(최대 60초)에도 `Retry-After: 2` 고정 | 사용성 | L | 원인별 Retry-After | additive | ⚪ |
| BD-15 | `CreateGameScores.ts:32-33` 외 | 코멘트·Swagger 낡음(DURATION 60fps 가정·DEFENSE 누락·seed 설명) | 문서 | L | 문구 수정 | 없음 | ⚪ |
| BD-16 | 테스트 | BD-01·03 시나리오·워커 스크립트 경로 회귀 테스트 공백 | 테스트 | L | 수정과 함께 | 없음 | ⚪ |

- 문제 없음 확인(재조사 방지): 주간 경계·ISO 주차, 세션 키 TTL·GETDEL, 멀티 레플리카 공유 상태(Redis만), 시간 초과 판정, 워커 풀 생명주기, 인가(공개 설계 D-003), 마이그레이션 멱등·down, `/replay` 공개 시점 Swagger
- 메인 검증 대기: BD-08 Stage 불변 · 최악 리플레이 워커 실측(BD-01·02 크기) · 랭킹 기간 필터 쿼리 플랜(`IS_HIDDEN`·`CRTD_AT` 인덱스 미포함)

## 2026-10-23 — 백 A 조사(테트리스 싱글·대전) 결과 · 메인 재확인
- 범위: `games.service/controller/registry/module`·`game-session.service`·`tetris-game-engine`·`games-error.dto`·`ranking-period`·`tetris-engine/replay` · `tetris-battle/` 서비스·스토어·결과·검증·브라우즈·게이트웨이·DTO·가드·필터·토큰·상수·에러·모듈·해시·`battle-engine/{replay,engine,constants}` · Entity 5 · 인덱스 마이그레이션. 미열람: `tetris-engine/{game,pieces,random,constants}`(골든·해시 보호 사본)
- 확인된 정상: 인메모리 공유 상태 없음, Redis 키 TTL 누락 없음, 시각 컬럼 TZ, 타입 억제 0
- 중복 정리: BT-04 = BD-03 · BT-08 = BD-01 · BT-13 = BD-10 · BT-11(세션 409 부분) ⊂ BD-04 → 계획에서 BD로 통합

| ID | 위치 | 요지 | 분류 | 심각도 | 수정안 | 계약 | 재확인 |
|---|---|---|---|---|---|---|---|
| BT-01 | room.service `:862-865` · gateway.dto `LockDto.sent @Max(MAX_ATTACK)` · match.store Lua `:166-182` | lock의 `sent`는 상한 22만 검사, `lines·tSpin·pc`는 서버가 안 씀(DTO 주석 "형식만 검사") → `lines:0, sent:22` 반복으로 상대 즉시 탑아웃. 사후 검증 INVALID여도 승패·순위는 그대로 | 버그(무결성) | **H** | `lock()`에서 `computeAttack`(battle-engine에 있음)으로 상한 계산, 초과 시 `INVALID_PAYLOAD` — b2b·combo 시점 의미는 프론트 확인 + 골든 sentLog 대조 후 도입 | 정상 클라 무변화 | ✅ (tetris-audit BE-21은 사후 검증 위조 한계 — 실시간 상한은 별건) |
| BT-02 | gateway `:162-172` · constants `RATE_LIMITS` | `listRooms` 레이트리밋 없음 — 호출마다 최대 200 HGET + reconcile. BE-09는 방송 디바운스만 | 성능·보안 | M | 소켓당 1회/초 한도 | 한도 초과 시 `RATE_LIMITED` ack | ✅ |
| BT-03 | ws.guard `:58-66` | `findOne` DB 예외까지 catch → 게스트 강등이 `authResolved`로 소켓 수명 동안 고정 → SEAT_IN_USE·넘겨받기 우회, 결과 USER_ID null | 버그 | M | JWT 검증 오류만 게스트, DB 오류는 미확정(재시도) 또는 에러 | 없음 | ✅ |
| BT-05 | result.service `:91-97` | 저장 깨우기가 메모리 `setTimeout` — 종료 후 60초 내 레플리카 재시작 + 이후 조회 없음 → Redis TTL 2h 뒤 경기 유실 | 버그(신뢰성) | M | 종료 시 Redis ZSET 등록 + `TASK_SLOT=1` 스케줄러 | 없음 | ✅ |
| BT-06 | match.store `:152-154,177` · verify `:85-91` | PIECES·MAX_COMBO·SENT가 보고값 그대로 저장(현재 소비처 없음) | 무결성 | L | VERIFIED 시 시뮬 값으로 저장 | 없음 | ⚪ |
| BT-07 | gateway `:278-282` | heartbeat 빈도 제한 없음 — 호출당 Redis 쓰기 2 | 성능 | L | 소켓 로컬 1초 간격 무시 | 없음 | ⚪ |
| BT-09 | result.service `:195,302-311` | `getMatch`가 저장 완료 후에도 매치 해시 HGETALL | 성능 | L | `HEXISTS saved` 선확인 | 없음 | ⚪ |
| BT-10 | result.service `:383-415` | 참가자·리플레이 건별 `save`(4인 약 20문장) | 성능 | L | 배열 insert | 없음 | ⚪ |
| BT-11 | room.service `:742,848,884-888` | 소켓 상태×이벤트 에러코드가 원인과 어긋남(결과 화면 setReady → "이미 경기 진행 중") | 사용성 | L | 상태 코드 추가 검토 | 신규 코드(additive) | ⚪ |
| BT-12 | `TetrisBattleMatch.ts` 헤더 · browse `:42` · result.service `:60-72` · result.controller `:96-100` | DISPUTED 공개(D-004) 이후 주석 낡음, JSDoc 위치 어긋남, 409 Swagger type 하나 | 문서 | L | 주석·Swagger 정정 | 없음 | ⚪ |
| BT-14 | result.service `:345-347` | 제출 JWT userId가 입장 정체성을 덮음(소비처 없음) | 버그(경계) | L | 입장 userId 우선 | 없음 | ⚪ |
| BT-15 | games.service ↔ result.service gzip 저장·복원 | 중복 약 10줄 — 모듈 경계(tetris-battle D-003)상 유지 | 리팩토링 | L(수용) | 유지 | 없음 | ⚪ |

- 프론트 질의 필요: BT-01(LockDto `b2b`·`combo`·`lines`·`tSpin`·`pc` 송신 시점·의미) · BT-02(`listRooms` 호출 주기) · BT-05(결과 화면이 종료 60초 뒤 `GET matches/:id` 호출하는지) · BD-03/BT-04(503 GAME_VERIFY_BUSY 재시도 처리) · BD-04(`details.reason` 사용 의향)
- 테스트 미실행: 서브에이전트 시점 worktree에 node_modules 없음 — 구현 착수 시 `pnpm install` 필요(Ask 대상 아님: lockfile 그대로 설치)

## 2026-10-23 — 프 조사(next-bun-80) 결과 원문 · 메인 대조
- 메인 대조: 엔진 사본 해시 백↔프 일치(테트리스 백 12개 해시 전부 프 매니페스트에 존재 · 디펜스 매니페스트 동일 JSON) — python 비교
- 프 기준선: ci:core 1345 tests 통과 · lint 경고 0 · 프론트 base `54b8c1d`
- 아래는 프론트 보고 원문(H·M은 프론트 세션이 원본 재확인 ✔, L ○는 구현 착수 시 재확인)

[프론트] games-polish 프론트 전수조사 보고 — H 1 · M 15 · L 다수, 기준선 ci:core 전부 통과, 질의 Q1~Q5 답 포함

#### 0. 기준선 · 브랜치
- base `feat-onam-games-polish` = origin/main `54b8c1d7ea5ab04e2f79ef182560039a529b0dff`, worktree `next-bun/.claude/worktrees/games-polish`, git status clean(코드 수정 0)
- `pnpm ci:core` 단계별: lint ✔ 경고·에러 0 · typecheck ✔ · test:run ✔ **137 files / 1345 tests passed (8 files·11 tests skipped)** · build ✔ (sandbox 밖, Compiled successfully)
- 엔진 사본: `engine-copy-hashes.test.ts`(싱글·대전 엔진 + 골든 fixture) · defense `manifest.test.ts`(ENGINE_MANIFEST) 통과 = 프론트 사본 ↔ 프론트 매니페스트 일치. ENGINE_VERSION 싱글 1 · 대전 1 · 디펜스 3. 디펜스 매니페스트 루트 sha256 `e5564b03197199fd83920326739e02bfbd45ff0acbeef0e3cd4f5e7d1ceeb881`. **백↔프 매니페스트 값 대조는 메인이 해 줘야 함**(프론트 `src/app/games/tetris/engine-copy-hashes.json`, `src/app/games/defense/engine-dev/ENGINE_MANIFEST.json` — 백엔드 파일은 이 세션이 읽지 않음)

#### 1. 조사한 파일
범위: `src/app/games/**`(engine/ 규칙 로직·engine-dev/sim 제외 — 렌더 루프 호출 방식만), `src/services/{gameService,tetrisBattleService,gameServerService}.ts`, `src/types/{game,tetrisBattleSocket}.ts`, `next.config.ts`, `.next` 산출물(번들). 영역별 4개 조사 + 메인 세션 재확인.
- 싱글: TetrisHome, (fullscreen)/play/TetrisPlay, replays/[scoreId]/ReplayPlayer·page·og, rankings/*, components 6(TetrisCanvas·TouchControls·GameOverPanel·SoundToggle·EffectsToggle·SoundSettingsPanel), hooks 4, lib 전부(renderer·effects·effectsRenderer·blockSprites·effectsSettings·storage·controls·fixedStep·replayTimeline·gameSnapshot·share·replayCard·sound/*)
- 대전: battle-ui/contexts/BattleSocketContext, hooks 9(useBattleMatch·useMatchOutbox·useBattlePlay·useBattleMatchReplay·useBoardFocus·useOfflineCountdown·useAttackTrails·usePlayerName·useMatchPublished), components 19, lib 13, (fullscreen)/battle/** 6 page·layout, battle og route, battle-engine index·engine
- 디펜스: components 23(DefensePlay·RankedPlay·RankedResult·RankedCards·PendingSubmitCard·ReplayPlayer·ReplayScreens·Hud·TowerRing·ResultPanel·StageScreen·CampaignMap·Codex·DefenseRankings 등), hooks 4, lib 19, renderer 7, audio/sfx, dev/DevBench·page, engine-versions, 모든 page·og route
- 공용: games/page·layout·gamesPaths, _shared/** 전부(components 5, hooks 1, lib 14), 랭킹 page 2, 리플레이 page 3 generateMetadata
- 테스트 파일은 근거 확인용 grep만

#### 2. 지적 표
재확인 표기: ✔ = 메인 세션 아님(이 프론트 세션)이 원본에서 직접 확인 / ○ = 조사 에이전트 인용 기준(미재확인). H·M은 전부 ✔.
경로 약칭: T=src/app/games/tetris · BU=T/battle-ui · D=src/app/games/defense · S=src/app/games/_shared

##### H
| ID | 파일:라인 + 인용 | 근거/재현 | 분류 | 심각도 | 수정안 | 백엔드 |
|---|---|---|---|---|---|---|
| FE-01 ✔ | BU/components/RoomStage.tsx:58 `<WaitingRoom room={room} connection={connection} onReconnect=…` — MatchScreen·BattleView에는 connection prop·ConnectionBadge 없음(grep) | 경기 중 소켓이 끊기거나 자동 재시도가 끝나 `failed`(BattleSocketContext.tsx:365 `setStatus(s.active ? 'disconnected' : 'failed')`)가 돼도 경기 화면엔 아무 표시·재연결 버튼이 없다. 로컬 판은 계속 진행되고 lock은 outbox에만 쌓임 → 사용자는 이미 서버에서 빠진 "유령 판"을 계속 둔다. 복구는 나가기뿐 | 버그·사용성 | H | MatchScreen/BattleView 헤더에 connection·onReconnect 전달 + 끊김 동안 "다시 연결하는 중" 오버레이 | 아니오 |

##### M
| ID | 파일:라인 + 인용 | 근거/재현 | 분류 | 심각도 | 수정안 | 백엔드 |
|---|---|---|---|---|---|---|
| FE-02 ✔ | src/services/tetrisBattleService.ts:71-76(제출 래퍼)·168·184·209·245 `fetchServiceInstance.backendFetch({…})` signal 없음. FetchService에 기본 timeout 없음 | 이전 FE-08은 gameService만 고침. 망이 멈추면 ①리플레이 제출 "기록 저장 중…" 영구 ②useMatchPublished 폴링 정지("경기 저장 중…") ③useBattleMatchReplay 트랙 settled 안 됨 → 재생 시작 불가 | 버그 | M | gameService의 `timeoutSignal` 패턴 5곳 적용(AbortError는 이미 재시도 대상) | 아니오 |
| FE-03 ✔ | src/services/gameService.ts:230 `getGameBoards`·:251 `getGameRankings` backendFetch signal 없음 | 랭킹 skeleton(RankingsView)·예상 순위 "…"(ScoreSubmitPanel)·TetrisHome·RankedCards·DefenseRankings가 영구 대기 | 버그 | M | 두 함수에 timeoutSignal | 아니오 |
| FE-04 ✔ | D/components/DefenseRankings.tsx:62 `if (!ready) return null;` | /boards 응답 전 레이아웃·제목 없는 빈 화면, FE-03과 겹치면 영구 빈 화면. boardsError는 문구뿐·재시도 없음 | 사용성 | M | !ready면 레이아웃+skeleton | 아니오 |
| FE-05 ✔ | D/components/DefensePlay.tsx:349 `clearResume();`(onOver) · RankedPlay.tsx:141 `setOver({…})` · 보관은 S/components/ScoreSubmitPanel.tsx:157 `storage.savePendingSubmission(…)`(제출 실패 catch 안에서만, 전 레포 유일 호출) | 무한·주간 판이 끝나는 순간 이어하기는 지워지고, 이름 입력·등록 전 새로고침·탭 닫기·뒤로가기면 기록이 사라진다(허브 "등록하지 못한 기록"에도 없음). 테트리스 싱글도 같은 ScoreSubmitPanel 흐름 | 버그(기록 손실) | M | 게임 오버 시점에 pending 선보관 → 등록 성공 시 삭제 | 예(Q-D1) |
| FE-06 ✔ | D/components/DefensePlay.tsx:117 `restoreGame(stage, resumeOffer.seed, resumeOffer.inputs, resumeOffer.tick)` (RankedPlay.tsx:117 동일) | 클릭 핸들러에서 최대 MAX_TICKS(162000)틱 동기 시뮬. engine-dev/perf.test.ts:11 주석상 최대 판 데스크톱 1.5~2.8초, 모바일 미측정. 로딩 표시 없음(리플레이는 replayRunner CHUNK_TICKS로 청크+진행률) | 성능 | M | prepareReplay처럼 청크+진행률, 최소 "불러오는 중" | 아니오 |
| FE-07 ✔ | D/components/RankedCards.tsx:48 `` rankingsHref={`/games/defense/rankings?board=${ENDLESS_BOARD_KEY}`} `` · :37 `bests[ENDLESS_BOARD_KEY]` · lib/rankedBoards.ts:15 `'endless-s1'` | 최고 기록은 서버 세션 boardKey로 저장(RankedPlay.tsx:140 `recordBest(run.boardKey, …)`) → 시즌이 바뀌면 허브 "내 최고"·랭킹 링크가 s1에 고정 | 버그 | M | /boards의 current endless 키 사용, 상수는 폴백 | 예(Q-D2) |
| FE-08 ✔ | D/lib/ringOptions.ts:65 `if (!slotAvailable(state, stage, slot)) return [];` · DefensePlay.tsx:706 `options.length > 0 &&` · renderer/mapLayer.ts:63 모든 슬롯 동일하게 그림 | 잠긴 슬롯도 "빈 자리" 버튼으로 눌리고 링이 안 떠 안내 없음 | 사용성 | M | 잠긴 슬롯 비활성·"잠긴 자리" 라벨·흐리게 | 아니오 |
| FE-09 ✔ | D/renderer/quality.ts:24 `export class QualityController` — 사용처 dev/DevBench.tsx:11,85뿐 · DefensePlay.tsx:47,56 `PARTICLE_CAPACITY = 400` / `DPR_CAP = 2` | 헤더 주석("예산 넘으면 하향")과 달리 운영 플레이에 미연결 → 저사양 모바일도 DPR2·파티클 400 고정, 설정에도 품질 항목 없음 | 성능 | M | PlaySession에 컨트롤러 연결(또는 정리) | 아니오 |
| FE-10 ✔ | BU/hooks/useBattlePlay.ts:184-188 `quiet = clock.acc >= …; while (clock.acc >= FRAME_MS …) tick(bs, recorder)` · useMatchOutbox.ts:79-88 lock 순회 즉시 emit | 이전 FE-05 중 "효과음 억제"만 반영, "송신 묶기" 미반영. 백그라운드 복귀 시 rAF 1회 최대 600틱 → 그 사이 lock 전부 연달아 emit | 버그(경합)·성능 | M(미확정) | catch-up 중 lock은 큐에만, 루프 뒤 간격 두고 전송 | 예(Q-B3) |
| FE-11 ✔ | BU/components/BattleView.tsx:175 `{isCoarse && play.status === "playing" && (<TouchControls` | 카운트다운 동안 없다가 GO 순간 생김 → 판 높이 줄며 TetrisCanvas resize(백버퍼 재할당), 시작 프레임 레이아웃 튐 | 사용성·성능 | M | countdown에도 자리 확보 렌더 | 아니오 |
| FE-12 ✔ | T/(fullscreen)/play/TetrisPlay.tsx:131 `if (sessionState.status === "loading") return;` · :237 `disabled={sessionState.status === "loading"}` | 백엔드가 느리거나 죽으면 SESSION_TIMEOUT_MS(10초)까지 시작 불가, 처음부터·다시 하기마다 반복. 실패 시 로컬 seed 플레이 경로는 이미 있음 | 사용성 | M | 3초 넘으면 "등록 없이 시작" 보조 버튼 | 아니오 |
| FE-13 ✔ | T/(fullscreen)/replays/[scoreId]/ReplayPlayer.tsx:152 `while (stateRef.current.frame < clamped && advance())` + :324 `onChange={(e) => seek(Number(e.target.value))}` · BU/lib/battleReplayRunner.ts:128 `while (frame < target && advanceRunner(…))`(최대 4판) | 앞으로 크게 끌면 미방문 구간 전체를 input 이벤트마다 메인 스레드 동기 시뮬(싱글 최악 216,000프레임). 이전 FE-22 "미방문 구간 동기 시뮬" → 유효 | 성능 | M(미확정 — 브라우저 실측 없음) | 드래그 중엔 목표만 보관·rAF당 예산만 진행, 또는 놓을 때 seek | 아니오 |
| FE-14 ✔ | S/components/RankingTable.tsx:27 `const highlighted = item.scoreId === highlightId;` — scrollIntoView 0건 · RankingsView 상위 50 | 등록 직후 "랭킹 보기"(?highlight=)로 가도 스크롤이 없어 모바일 화면 밖, 50위 밖이면 표시·안내 없음 | 사용성 | M | 강조 행 scrollIntoView + "상위 50위 밖" 안내 | 예(Q-S4) |
| FE-15 ✔(코드) | BU/hooks/useBattleMatch.ts:461 `} else if (room.status === "PLAYING" && current.kind === "idle") {` → unavailable | roomState(PLAYING)가 matchStarting보다 먼저 오면 대기실이 "진행 중인 게임이에요"로 깜빡인 뒤 카운트다운 | 경합 | M(미확정 — 서버 순서 의존) | 순서 미보장이면 idle→unavailable에 짧은 유예 | 예(Q-B1) |
| FE-16 ✔(build 실측) | D/engine/index.ts가 WEEKLY_COMBOS(2079줄 생성 데이터) export → `.next/static/chunks/5751-*.js`(106KB raw)에 포함, 이 청크를 /play/stage(캠페인)·/play/endless·/play/weekly·/replays/[scoreId]·/replays/local·/dev 전부가 로드(app-build-manifest) | 캠페인·무한에도 주간 조합표가 실린다. engine-versions의 동적 import도 lib/fx·toRenderView가 ../engine 정적 import라 분할 효과 없음. 참고: First Load endless 255kB vs stage 167kB(차이는 RankedPlay 쪽 next-auth·ScoreSubmitPanel·ShareMenu 등 청크 12개) | 성능(번들) | M | 엔진은 해시 고정이라 엔진 밖에서: 주간 데이터를 쓰는 경로만 지연 로드 가능한지 검토(엔진 수정 필요 시 별도 결정) | 아니오 |

##### L (요약 — 수정안 한 줄)
| ID | 파일:라인 + 인용 | 근거 | 분류 | 수정안 | 백엔드 |
|---|---|---|---|---|---|
| FE-17 ○ | T/…/ReplayPlayer.tsx:183-185 재생 중 setPlayback({frame}) ↔ :323 `value={playback.frame}` | 드래그 중 재생이 이어져 썸이 되돌아감(이전 FE-22 "재생 슬라이더 충돌" 싱글 유효 / 대전 BattleMatchViewer는 무효) | 버그 | pointerdown 일시정지·up 복귀 | 아니오 |
| FE-18 ✔ | T/lib/sound/soundPlayer.ts:288 `lastPlayedAt.set(cue.kind, ms);` → :290 `if (sfxVoiceEnds.length >= MAX_SFX_VOICES) return;` | 상한으로 안 울린 소리도 쓰로틀 시각 갱신 → 다음 같은 소리 최대 1초 막힘(FE-22 sound voice throttle 유효) | 버그 | set을 실제 voice 시작 뒤로 | 아니오 |
| FE-19 ○ | T/components/TetrisCanvas.tsx:106 `const dpr = window.devicePixelRatio`(resize 안에서만) · :117 ResizeObserver | DPR만 바뀌는 모니터 이동 시 흐림(FE-22 dpr 유효). D/hooks/useDefenseCanvas.ts:65 `(resolution: Ndppx)` 패턴 있음 | 버그 | 같은 matchMedia 구독 | 아니오 |
| FE-20 ✔ | T/lib/effectsSettings.ts:85 `if (e.key !== REDUCED_EFFECTS_KEY) return;` vs sound/soundSettings.ts:68 `&& e.key !== null` | storage.clear() 이벤트 무시(FE-22 storage clear 유효) | 버그 | key===null 허용 | 아니오 |
| FE-21 ○ | T/components/TetrisCanvas.tsx:29 모듈 전역 `let sessionQuality` → :66 lite 고착 | 일시 부하로 새로고침 전까지 저품질(싱글·대전 공유). 주석상 의도 | 성능 | 일정 시간 뒤 재측정 | 아니오 |
| FE-22 ○ | T/lib/blockSprites.ts:93 `` const key = `${cell}:${px}`; `` | drawBlock마다 문자열 키 생성 + CACHE_LIMIT 96 초과 시 clear() 전체(FE-22 sprite 키 유효) | 성능 | 숫자 키/크기별 배열 | 아니오 |
| FE-23 ○ | BU/hooks/useBattleMatchReplay.ts:105-126 판당 400ms 순차 조회 | 4인 1.6초+, settled 전 재생 불가, 트랙별 재시도 없음(FE-22 트랙 순차 조회 유효·의도) | 사용성 | 트랙별 재시도 버튼 | 예(Q-B6) |
| FE-24 ○ | BU/components/MatchScreen.tsx:307 `(submitStatus === "saved" \|\| submitStatus === "invalid") && matchId && <MatchRecordLinks` | 제출 못 한 참가자(끊김·failed·expired)는 공개돼도 링크 없음(FE-22 기록 링크 조건 유효) | 사용성 | matchId만 있으면 노출 | 예(Q-B5) |
| FE-25 ○ | T/…/ReplayPlayer.tsx:228-244 · D/components/ReplayScreens.tsx:108-129 오류 시 "랭킹으로"만 | 일시 오류에도 재시도 없음(loadReplay는 실패 미캐시라 쉬움) | 사용성 | 404 아니면 "다시 시도" | 아니오 |
| FE-26 ○ | T/…/ReplayPlayer.tsx:319-327 · BU/components/BattleMatchViewer.tsx:244-252 `aria-label="재생 위치"` | aria-valuetext 없음 → 프레임 수 낭독 | 접근성 | aria-valuetext={formatFrames} | 아니오 |
| FE-27 ○ | T/(fullscreen)/play/TetrisPlay.tsx:255 `onClick={restart}` · :280 | 일시정지 "처음부터"·미등록 게임오버 "다시 하기"가 확인 없이 판 폐기 | 사용성 | ConfirmModal | 아니오 |
| FE-28 ○ | T/components/SoundToggle.tsx:30-31 `aria-pressed={on}` + `aria-label={on ? "소리 끄기" : "소리 켜기"}` | 상태·동작 라벨 모순 낭독 | 접근성 | 라벨 고정 | 아니오 |
| FE-29 ○ | T/components/TouchControls.tsx:84-91 이동 버튼 pointer 이벤트만 | 이전 FE-10은 즉시 버튼만 → 좌·우·소프트드롭은 스크린리더·스위치 불가 | 접근성 | click(detail 0) → press+release | 아니오 |
| FE-30 ○ | S/components/ScoreSubmitPanel.tsx:221-223 이름 오류 `<p>` role 없음 · :217 disabled로 포커스 상실 | 오류 미낭독·포커스 미복귀 | 접근성 | role=alert + focus() | 아니오 |
| FE-31 ○ | BU/components/BattleView.tsx:130-150 이모트 팝오버 | Esc·바깥 클릭 닫기·포커스 이동 없음, 판 가림 | 접근성 | 바깥/Esc 닫기 | 아니오 |
| FE-32 ○ | BU 전체 — 키 안내 없음(CONTROL_GUIDE는 TetrisHome·TetrisPlay만) | 데스크톱 대전 키 설명 없음(Esc·P 일시정지 빼야 함) | 사용성 | 대기실에 대전용 안내 | 아니오 |
| FE-33 ○ | BU/components/BattleRoom.tsx:178-184 `aria-label="입장하는 중"` · BattleLobby.tsx:220 스피너 | failed/disconnected면 자동 입장이 :88 가드로 안 도는데 스피너만 영구 | 사용성 | 연결 안 됨 문구+다시 연결 | 아니오 |
| FE-34 ○ | BU/components/WaitingRoom.tsx:59-64 `setStarting(true); await startMatch(); setStarting(false)` | ack~matchStarting 틈에 재클릭 → MATCH_ALREADY_STARTED 문구 번쩍 | 경합(미확정) | 성공 시 starting 유지 | 예(Q-B1) |
| FE-35 ○ | T/(fullscreen)/battle/(live)/[code]/page.tsx:29 `<BattleRoom code={normalized}` key 없음 | 방→방 직행 시 autoTriedRef 등 유지(현재 UI 경로 없음) | 버그(미확정) | key={normalized} | 아니오 |
| FE-36 ○ | BU/hooks/useBattlePlay.ts:208-214 Space preventDefault · BattleMatchViewer.tsx:281 같은 회피 주석 | 헤더 버튼 포커스 잔류 시 Space가 click과 겹칠 수 있음 | 버그(미확정) | 클릭 후 blur | 아니오 |
| FE-37 ○ | BU/contexts/BattleSocketContext.tsx:624-675 value에 rooms·room·chat·emotes 전부 | roomState·채팅마다 MatchScreen 트리 리렌더(opponentViews 재생성) | 성능(미확정) | 상태/액션 컨텍스트 분리 | 아니오 |
| FE-38 ○ | D/components/ReplayPlayer.tsx:146 재생 분기 안에서만 :175 `setPlaying(false)` | 재생 중 끝으로 seek하면 "Ⅱ" 상태로 멈춤 | 버그 | seek에서 끝이면 정지 | 아니오 |
| FE-39 ○ | D/components/ReplayPlayer.tsx:346-354 `replay.commands.map((c, i) => (<li key={i}>` | 목록 열면 매초 수천 li 재생성 | 성능 | memo 분리 | 아니오 |
| FE-40 ○ | D/components/DefensePlay.tsx:311-323 onFrame | 대기·일시정지 중에도 매 프레임 재그리기, 파티클·적 흔들림 진행 | 성능·사용성 | 정지 시 변경 때만 그림 | 아니오 |
| FE-41 ○ | D/components/ReplayPlayer.tsx:260,267 `{state.lives}` `{state.wavesStarted}` | 초 단위 setTick 때만 갱신 → 최대 1초 지연 | 버그 | 변경 시 갱신 | 아니오 |
| FE-42 ○ | D/components/ResultPanel.tsx:41-45 `aria-modal="true"` · RankedResult.tsx:57 | 포커스 트랩·Esc 없음, ResultPanel 스크롤 없어 가로·소화면 잘림 | 접근성 | useDialog + overflow-y-auto | 아니오 |
| FE-43 ○ | D/components/Hud.tsx:83,89,100 `min-w-10` · TowerRing.tsx:82,93 `text-[10px]`·`[11px]` · DefensePlay.tsx:618 슬롯 버튼 축소 · :735-742 설정은 일시정지 안에만 | 터치 44px 미달·작은 글자·설정 접근 | 사용성 | 실기기 확인 후 조정 | 아니오 |
| FE-44 ○ | D/components/CampaignMap.tsx:13-14·Codex.tsx:15-16·StageScreen.tsx:16-21·RankedCards.tsx:29·RankedPlay.tsx:70 `useState(emptyProgress)` + effect load | 첫 렌더 "전부 잠김" 깜빡임, storage 이벤트 미구독 — 5곳 중복 | 사용성·리팩토링 | useProgress() 훅 | 아니오 |
| FE-45 ○ | D/components/DefensePlay.tsx:102,104 `return null` · RankedPlay.tsx:160-182 RankedResult에 requesting 미전달 | 빈 화면·다시 하기 대기 표시 없음 | 사용성 | 로딩 상태 | 아니오 |
| FE-46 ○ | S/lib/storage.ts:133-142 savePendingSubmission void · D/components/DefensePlay.tsx:378 `saveResume({…})` 반환 무시 | 저장 실패(용량·비공개 모드) 무안내 → 새로고침 시 기록 소실 | 버그 | 실패 시 1회 안내 | 아니오 |
| FE-47 ○ | S/lib/ogCard.tsx:13-14 · BU/lib/battleOgCard.tsx:11-12 `"public, max-age=600"` | s-maxage 없음 → 크롤러마다 satori 렌더(CDN 유무 미확정) | 성능 | s-maxage+swr, 상수 통합 | 아니오 |
| FE-48 ○ | src/app/games/layout.tsx:4 description에 디펜스 없음 | 카피 | 카피 | 디펜스 추가 | 아니오 |
| FE-49 ○ | S/hooks/useKakaoReady.tsx:22 `onError={() => setKakaoReady(false)}` · ShareMenu.tsx:94 | SDK 실패·지연 시 버튼 무안내 소멸/뒤늦게 등장 | 사용성 | 자리 확보·실패 문구 | 아니오 |
| FE-50 ○ | src/services/gameService.ts:206-212 + :103-107 | 401 재시도와 VERIFY_BUSY 재시도 겹치면 대기 누적·취소 수단 없음(드묾) | 경합(미확정) | 전체 deadline | 예(Q-S1) |
| FE-51 ○ | T/…/ReplayPlayer.tsx:121-135 rAF마다 객체·배열 · D/renderer/sceneLayer.ts:488,530,600 프레임당 배열·문자열 · T/lib/effectsRenderer.ts:107 `ctx.shadowBlur = reduced ? 4 : 14` 매 프레임 | 소규모 할당/모바일 Safari shadowBlur 비용(미측정) | 성능(미확정) | 상수화·오프스크린 캐시 | 아니오 |
| FE-52 ○ | T/TetrisHome.tsx:74-80 setSettings updater 안 `saveSettings(next)` | 업데이터 부수효과(StrictMode 2회) | 리팩토링 | 핸들러에서 저장 | 아니오 |

##### 리팩토링(공용화·죽은 코드)
| ID | 위치 | 내용 | 수정안 |
|---|---|---|---|
| FE-53 ○ | D/hooks/useDefensePlay.ts:229-263 · D/components/ReplayPlayer.tsx:146-170 · D/dev/DevBench.tsx:115-124 vs T/lib/fixedStep.ts | 고정 스텝 누산기를 디펜스가 3번 직접 구현(상한 100), 대전 useBattlePlay.ts:28 상한 10_000 — 이전 FE-23 잔여 | fixedStep을 _shared로 승격 |
| FE-54 ○ | T/hooks/useTetrisPlay.ts:106-127 · BU/hooks/useBattlePlay.ts:117-130,203-205 · vibrate: useTetrisPlay.ts:32·DefensePlay.tsx:234-236 | 입력 큐 press/release/instant/releaseAll 2벌, vibrate 2벌 | useHeldInput·vibrate 공용 |
| FE-55 ○ | T/(fullscreen)/play/TetrisPlay.tsx:76-83 · BU/components/BattleView.tsx:37-48,95-101 | matchMedia 구독 3벌, coarse 초기 false라 터치 기기 첫 렌더 키보드 안내 깜빡 | useMediaQuery(lazy 초기값) |
| FE-56 ○ | D/audio/sfx.ts:58-213 · T/lib/sound/soundPlayer.ts:66,102 | WebAudio 컨텍스트 생성·unlock·suspend 2벌 | 컨텍스트 수명만 _shared |
| FE-57 ○ | T/lib/effects.ts:3 `import { isPerfectClear } from '../battle-engine/battle'` · T/lib/blockSprites.ts:7 | 싱글 렌더가 대전 엔진에 역의존 | 공용 lib로 이동 |
| FE-58 ○ | 소중복: OG CACHE 상수 2벌(ogCard·battleOgCard) · 디펜스 랭킹 링크 직조립 ReplayScreens.tsx:108(공용 rankingsHref 미사용, board 미인코딩) · highlight 정규식 2벌(tetris/defense rankings page) · formatTicks 3벌(RankedResult:36·ResultPanel:26·ReplayPlayer:40, 공용 formatDurationMs 있음) · worstEnemy 2벌 · sleep 4벌(BattleSocketContext:70·useBattleMatchReplay:58·replaySubmit:54·battleMatchLoader:60) · ACK 8000 2벌(BattleSocketContext:37·useMatchOutbox:14) · MatchScreen.tsx:57 inPlay = :63 inGame 동일식 · not-found 판정 2방식(ReplayScreens:98 status===404 vs ReplayPlayer:91 isNotFoundError) · BattleMatchViewer.tsx:6 팀 도메인 taskUtils.formatFullDateTime(규약은 dateUtils) | 공용 헬퍼로 통합 |
| FE-59 ○ | 죽은 코드: T/lib/controls.ts:54 RELEASE_OF(참조 0) · BU/components/WaitingRoom.tsx:17 BATTLE_MATCH_AVAILABLE=true · D/lib/defenseGame.ts:12 REPLAY_PLAYER_READY=true · BU/lib/roomForm.ts:43 isValidMaxPlayers(테스트 전용) · useMatchPublished `enabled`(항상 true) · types/tetrisBattleSocket.ts:40,366 ServerEvents.ERROR 미구독 · boardCodec.ts:10 visibleCells · D/lib/toRenderView.ts:24 `item.effects = statusBits(enemy)` 렌더러 미사용(틱마다 헛계산)+renderView.ts:65 EFFECT_BIT · useDefensePlay.ts:37 hud.tick · useDefenseSettings.ts:11 loaded · defenseGame.ts:69 loadBest(테스트 전용) | 삭제 |
| FE-60 ✔ | D/hooks/useDefensePlay.ts:135-136 `useRef<GameState>(null as unknown as GameState)` | 게임 범위 유일한 타입 우회(아래 지표) | 지연 초기화 헬퍼 |

참고(지적 아님): dev 라우트 /games/defense/dev·/games/tetris/battle/preview는 운영 notFound()(devGate·NODE_ENV), DevBench 청크는 라우트 번들에만. /games 목록·랭킹 페이지 번들엔 엔진·sound 없음(.next 확인). 이전 FE-06·09·10·11·20·21·01·03·04·12~19·24~28 반영 확인(재지적 안 함).

#### 3. 이전 FE-22(보류 9건) 재평가
sound voice throttle 유효(FE-18) · dpr 미감지 유효(FE-19, MiniBoard는 자동 보정) · storage clear 유효(FE-20) · 재생 슬라이더 충돌 싱글 유효(FE-17)/대전 무효(BattleMatchViewer.tsx:59-66 frameRef로 정상) · 미방문 구간 동기 시뮬 유효(FE-13) · sessionQuality 고착 유효·의도됨(FE-21) · 트랙 순차 조회 유효·의도(FE-23) · 기록 링크 조건 유효(FE-24) · sprite 문자열 키 유효(FE-22)

#### 4. 코드품질 지표(게임 범위, 측정값)
범위: src/app/games/** + services 3 + types 2, *.ts/tsx/css. prod/test 분리(*.test.*).
| 영역 | 구분 | prod 파일/LOC | test 파일/LOC |
|---|---|---|---|
| 싱글 | 앱 | 37 / 4,278 | 19 / 1,567 |
| 싱글 | 엔진 사본 | 6 / 1,030 | 2 / 476 |
| 싱글 | dev(engine-dev) | 3 / 486 | 2 / 112 |
| 대전 | 앱(+service·socket 타입) | 55 / 6,459 | 24 / 3,405 |
| 대전 | 엔진 사본 | 5 / 537 | 2 / 297 |
| 대전 | dev | 1 / 332 | 1 / 18 |
| 디펜스 | 앱 | 70 / 6,837 | 32 / 2,734 |
| 디펜스 | 엔진 사본 | 22 / 6,653 | 7 / 2,105 |
| 디펜스 | dev(engine-dev·sim·dev 라우트) | 19 / 2,450 | 9 / 580 |
| 공용 | 앱(_shared·목록·gameService·game 타입) | 25 / 1,848 | 10 / 601 |
앱 코드 합계 prod 19,422 / test 8,307 (test:prod 0.43). 엔진 사본 합계 prod 8,220 / test 2,878.

프로덕션 파일 크기 상위 15(줄): 2079 D/engine/data/weeklyCombos.ts **(생성 데이터 — sim이 생성, 손 수정 금지)** · 793 D/components/DefensePlay.tsx · 746 D/engine/combat.ts(엔진) · 701 BU/contexts/BattleSocketContext.tsx · 603 D/renderer/sceneLayer.ts · 597 T/engine/game.ts(엔진) · 485 BU/hooks/useBattleMatch.ts · 472 T/lib/effectsRenderer.ts · 458 D/engine/game.ts(엔진) · 407 BU/components/BattleMatchViewer.tsx · 398 T/(fullscreen)/replays/[scoreId]/ReplayPlayer.tsx · 394 T/lib/sound/soundPlayer.ts · 394 src/types/tetrisBattleSocket.ts(타입 정의) · 375 D/dev/DevBench.tsx(dev 전용) · 360 D/components/ReplayPlayer.tsx

타입 억제·TODO(prod / test): `as any` 0/0 · `: any` 0 · `@ts-ignore` 0 · `@ts-expect-error` 0/0 · `eslint-disable` 0/0 · TODO/FIXME 0 · `as unknown as` 3(prod: D/hooks/useDefensePlay.ts:135,136 null 단정 — FE-60 / D/audio/sfx.ts:217 webkitAudioContext — 정당)

책임 과다(300줄↑ 또는 useEffect 5↑) — 줄 / useEffect / useState / useRef:
- D/components/DefensePlay.tsx 793 / 13 / 15 / 20 ← 최우선 분해 후보(세션·입력·렌더·결과·이어하기가 한 컴포넌트)
- BU/contexts/BattleSocketContext.tsx 701 / 3 / 9 / 14 (상태+액션 단일 context — FE-37)
- BU/hooks/useBattleMatch.ts 485 / 4 / 6 / 18 (이전 FE-24로 outbox 분리 후에도 ref 18)
- BU/components/BattleMatchViewer.tsx 407 / 2 / 3 / 3
- T/…/ReplayPlayer.tsx 398 / 3 / 5 / 11
- D/dev/DevBench.tsx 375 / 4 / 11 / 6 (dev 전용)
- D/components/ReplayPlayer.tsx 360 / 2 / 7 / 10
- BU/components/MatchScreen.tsx 326 / 2 / 7 / 0
- T/(fullscreen)/play/TetrisPlay.tsx 312 / 4 / 6 / 5

게임 간 중복(같은 로직이 따로): ①리플레이 재생기 3벌(싱글 ReplayPlayer · 대전 BattleMatchViewer+battleReplayRunner · 디펜스 ReplayPlayer+replayRunner) — 스냅샷·seek·슬라이더·재생 속도·오류 화면이 각자, FE-13·17·25·26·38이 여기서 파생 ②고정 스텝 루프 싱글·대전 fixedStep vs 디펜스 자체 3벌(FE-53) ③입력 큐 싱글·대전 2벌, vibrate 2벌(FE-54) ④WebAudio 컨텍스트 관리 2벌(FE-56) ⑤matchMedia 구독 3벌(FE-55) ⑥설정 저장: 싱글 useSyncExternalStore vs 디펜스 useState+effect(useDefenseSettings — loaded 미사용) ⑦DPR 감지: 디펜스만 matchMedia, 싱글 없음(FE-19) ⑧fetch timeout: gameService만, tetrisBattleService 없음(FE-02) ⑨OG 카드 캐시 상수 2벌·formatTicks 3벌·sleep 4벌(FE-58)
lint 경고 수(게임 경로): 0 (`pnpm lint` 전체 "No ESLint warnings or errors")

#### 5. 메인 질의 답(Q1~Q5)
**Q1(BT-01) lock 값** — 한 tick 안에서 동기: BU/hooks/useBattlePlay.ts:157 `const { applied, lock } = stepBattle(bs, actions, actions.length);` → :171 `if (lock) optionsRef.current.onLock?.(lock, bs);` → BU/hooks/useBattleMatch.ts:149 `const engineLock = bs.game.lastLock;` → :155-161 `frame: engineLock.frame, sent, combo: engineLock.combo, b2b: engineLock.backToBack, tSpin: engineLock.tSpin, lines: engineLock.lines, pc: perfectClear`(sent·pc는 battle lock의 `lock.sent`·`lock.perfectClear`, :176).
- combo = **갱신 후 값**: T/engine/game.ts:383 `state.combo++;` 뒤 :403 `combo: lines > 0 ? state.combo : -1`(첫 클리어 0, 미클리어 -1)
- b2b = **"이번 고정이 B2B 보너스를 받았나"**(갱신 전 상태로 판정): game.ts:372 `let backToBack = false;` · :375-377 `if (state.backToBack) { … backToBack = true; }` · :379 `state.backToBack = true;` → :402 `backToBack,`. 즉 state.backToBack(갱신 후 플래그)가 아니라 직전이 difficult였고 이번도 difficult일 때만 true. 첫 테트리스는 false
- sent = 상쇄 후: T/battle-engine/battle.ts:224 `const perfectClear = isPerfectClear(game.board, lock.rows);` · :225 `const attack = computeAttack(lock, perfectClear);` · :231 `sent: attack - cancelled,`. computeAttack(:84-94)의 입력은 정확히 lock.lines·tSpin·backToBack·combo + pc
- 결론: 서버가 DTO의 lines·tSpin·b2b·combo·pc로 computeAttack을 돌리면 클라 attack과 같고 **sent ≤ attack**(대기열 상쇄만큼 작음). 검증은 `sent <= computeAttack(dto)` 상한이어야 정상 거부 0 — `sent == attack` 등치면 상쇄가 있는 정상 판이 거부된다. board(:162)는 줄 제거·가비지 삽입 후, pending(:163)은 상쇄 후 값

**Q2(BT-02) listRooms** — 폴링 없음. ① BU/components/BattleLobby.tsx:52-62 `useEffect(() => { if (status !== "connected") return; … listRooms() … }, [status, listRooms]);` — 연결될 때마다(최초·재연결) 1회(개발 StrictMode는 2회) ② :204 "새로고침" `onClick={() => listRooms().then(…)}` — 진행 중 disabled·디바운스 없음 ③ 그 외 갱신은 서버 push `ROOMS_CHANGED`(BattleSocketContext.tsx:370). 1회/초 한도: 정상 흐름은 안 걸림, 연결 직후 새로고침 클릭·버튼 연타는 걸림(오류 시 battleErrorMessage(code)로 목록 아래 문구). 한도를 걸면 프론트는 새로고침 버튼 in-flight 비활성화를 같이 하는 게 좋다(소규모)

**Q3(BT-05) GET /tetris-battle/matches/:matchId** — BU/components/MatchScreen.tsx:307 `{(submitStatus === "saved" || submitStatus === "invalid") && matchId && <MatchRecordLinks matchId={matchId} />}` → BU/hooks/useMatchPublished.ts: 마운트(=내 리플레이 제출 결과 확정 직후)부터 `PUBLISH_POLL_MS = 3000`(:9) 간격, 200이면 중지, 404·429·5xx·네트워크면 계속, `PUBLISH_POLL_LIMIT_MS = 75_000`(:10) 한도 → **참가자당 최대 약 25회**. 종료 60초 뒤에도 의도적으로 호출(:8 주석 "종료 후 60초 마감 뒤 첫 조회 때" 저장 트리거 전제). 같은 matchId 동시 요청은 battleMatchLoader.ts:30 shareInflight로 합침. 기록 페이지(useBattleMatchReplay.ts:91)는 1회. 주의: 현재 이 GET은 timeout이 없어(FE-02) 응답이 멈추면 폴링도 멈춘다

**Q4(BD-03) 503 GAME_VERIFY_BUSY** — src/services/gameService.ts:206-212 `let response = await post(); if (await isVerifyBusy(response)) { const waitMs = verifyBusyWaitMs(response); if (waitMs !== null) { await wait(waitMs); response = await post(); } }` — code가 GAME_VERIFY_BUSY인 503만, Retry-After(정수 초, 최소 1.1초, 없거나 못 읽으면 2초, 10초 초과면 자동 재시도 안 함 — :127-155) 뒤 **같은 sessionId로 1회 자동 재전송**. 그래도 실패 → S/lib/submitError.ts:30 `return { kind: 'retry', message };` → ScoreSubmitPanel.tsx:155-157 보관 + "다시 등록하기"(같은 세션 수동). **500은 자동 재전송 없이 바로 같은 'retry' 처리**(보관·수동 재시도). 차이는 자동 1회뿐. 수동 재시도에서 409면 submitError.ts:21-26 "이미 등록됐거나 세션이 만료됐어요. 랭킹에서 확인해 주세요." 참고: Retry-After가 CORS Access-Control-Expose-Headers에 없으면 항상 2초

**Q5(BD-04) 409·422 표시** — S/lib/submitError.ts:21 `if (err.status === 409 || err.code === 'GAME_SESSION_INVALID') {` → kind 'final', 서버 message 그대로(재시도 중이면 위 고정 문구) · :29 `if (err.status === 413 || err.status === 415 || err.status === 422) return { kind: 'final', message };` → ScoreSubmitPanel.tsx:149-152 오류 문구 + isFinalError + 보관 삭제. **details는 현재 버려진다**: src/types/api.ts:15-19 `ApiErrorResponse = { code; message; timestamp }`, ApiError(:138~) 필드 code·status·timestamp뿐. details.reason을 추가하면 쓸 수 있다 — 프론트에 ApiErrorResponse·ApiError `details` 추가 + classifySubmitError 분기(ENGINE_VERSION → "새 버전이 나왔어요. 새로고침해 주세요"(+버튼), EXPIRED → 새 판 안내, TIME/NOT_STARTED/MISMATCH → 현재 final 유지) 소규모 변경. 공용 api.ts 타입 변경이라 다른 서비스엔 영향 없음(선택 필드)

**Q6 리플레이 하이라이트 마커 (구현 안 함, 조사만)**
① 싱글 재생기 구조 — 전체 미리 시뮬 없이 재생하면서 진행한다. T/(fullscreen)/replays/[scoreId]/ReplayPlayer.tsx:79 `timelineRef.current = buildTimeline(data.inputs);` → :103-118 `advance()`가 한 프레임 `stepFrame(state, bufferRef.current, …)` 하고 :114-116 `if (state.frame % SNAPSHOT_INTERVAL === 0 && !snapshotsRef.current.has(state.frame)) snapshotsRef.current.set(…cloneGameState(state)…)` — 스냅샷은 **지나간 구간에만** 10초 간격(:33 `SNAPSHOT_INTERVAL = 10 * FRAMES_PER_SECOND`). seek(:140-158): 뒤로면 가장 가까운 스냅샷부터 재시뮬, 앞으로면 :152 `while (stateRef.current.frame < clamped && advance())` 동기 진행. 미리 시뮬 비용: 엔진 simulateReplay 최악(216,000프레임·입력 40,000)이 Node 200ms 이하 목표(T/engine-dev/perf.test.ts:62). 일반 판(수 분)은 수십 ms 이하로 추정(브라우저 미측정). 미리 시뮬 1회에서 `state.lastLock`이 바뀔 때(pieces 증가) LockEvent(frame·lines·tSpin·backToBack·combo)를 모으면 되고, 같은 패스에서 스냅샷도 전 구간 만들 수 있어 **FE-13(앞으로 탐색 동기 시뮬)도 같이 해결**된다. 메인 스레드 정지를 피하려면 디펜스 prepareReplay처럼 청크로 쉬거나(아래) 진행률 표시
② 마커 자리 — 싱글은 :318-327 `<span>{formatFrames(playback.frame)}</span><input type="range" … value={playback.frame} …/>` 한 줄뿐(마커 없음) → range를 relative 래퍼로 감싸 절대 위치 마커를 얹는 구조. 대전 BU/components/BattleMatchViewer.tsx:244-252 같은 range. **디펜스는 이미 같은 패턴이 있다**: D/components/ReplayPlayer.tsx:229-240 `const marks = useMemo(() => (<div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-2">{replay.waveTicks.map(…)}{replay.commands.map(…)}…` — 웨이브 시작 눈금 + 명령 점을 range(:290) 위에 그린다. 이 컴포넌트를 공용화해 세 재생기가 쓰면 된다. "그 지점으로 이동"은 마커가 aria-hidden·pointer-events-none이라 별도 버튼 목록(이전/다음 하이라이트, 키보드 접근)이 필요
③ 다른 재생기 적용성 — 디펜스: 가능, 가장 쉽다. D/lib/replayRunner.ts:97 `prepareReplay(…, onProgress)`가 이미 재생 전 전체를 `CHUNK_TICKS = 4000`(:38) 청크로 미리 시뮬하며 :135-137 이벤트를 훑어 waveTicks·commands를 모으고 스냅샷도 만든다 → 같은 콜백에서 engine `EVENT.LEAK`(목숨 깎임=위기)·`WAVE_CLEAR`·`DEATH`(+적 종류로 보스 판별) 수집만 추가. 대전: 구조상 가능하나 현재 미리 시뮬이 없다. BU/lib/battleReplayRunner.ts:69 `advanceRunner`·:114 `seekRunner`(방문 구간 스냅샷)로 싱글과 같은 방식 → 판(최대 4)마다 미리 시뮬 패스 추가 필요. 수집 재료: `bs.sentLog`(BattleLock: frame·attack·sent·perfectClear — battle.ts:238 `if (attack > 0) bs.sentLog.push(result)`) = 큰 공격, 판 `game.endFrame` = KO 시점, 받은 가비지 로그. 4판 × 판 길이라 비용이 싱글의 최대 4배 → 청크 필수
④ 프론트 단독 가능 — 마커는 이미 받는 리플레이(입력 로그)를 엔진 사본으로 재시뮬해 얻으므로 **API·DB 변경 불필요**. 엔진 파일도 안 고친다(lastLock·sentLog·EVENT는 기존 공개 상태). 서버 저장이 필요한 경우는 선택 사항뿐: 리플레이를 열지 않고 랭킹 목록·OG 카드·공유 문구에 "T-스핀 3회·최대 콤보 7" 같은 하이라이트 요약을 보이고 싶을 때(서버가 검증 시뮬 때 이미 같은 값을 계산하므로 점수 detail에 넣는 형태 — 계약 추가). 권장: 공용 마커 레일 + 디펜스 먼저(재료 다 있음) → 싱글(미리 시뮬+스냅샷, FE-13 동시 해결) → 대전 순

#### 6. 백엔드 계약 질문(새로 나온 것)
- Q-B1 roomState(PLAYING/RESULT)와 matchStarting·matchEnded·startMatch ack의 발행 순서가 계약으로 고정인가? (FE-15·FE-34)
- Q-B2 joinRoom ack의 rejoin은 WAITING·RESULT·재대결 직후에도 오나, status 'ENDED'와의 대응은? (useBattleMatch.ts:389-393)
- Q-B3 LOCK 거절 코드·속도 기준: ①백그라운드 복귀 시 연달아 오는 lock(벽시계 기준 LOCK_TOO_FAST?) ②타임아웃 재전송으로 seq N이 N+1보다 늦게 도착 시 처리 ③같은 seq 중복은 무시인가 오류인가 — 프론트는 SERVICE_UNAVAILABLE 외 거절을 영구 폐기(useMatchOutbox.ts:18,66) (FE-10)
- Q-B4 서버 이벤트 `error`(TetrisBattleServerEvents.ERROR)는 언제 발행? 프론트 미구독(FE-59)
- Q-B5 아무도 리플레이를 안 낸 경기도 GET 200 공개되나? 되면 FE-24 링크를 전원 노출 가능
- Q-B6 조회 스로틀(IP당 초당 3)이 목록·경기·리플레이 GET 공통인가? 프론트 리플레이 400ms 간격 + 경기 GET 겹침(FE-23)
- Q-D1 세션 1회용 조건: 첫 제출이 네트워크·429·503으로 실패해도 세션 유효? 게임 오버 후 이름 입력 전 이탈 → 4시간 안 보관 제출 가능? 세션이 발급 시 토큰에 묶이나(발급·제출 토큰이 다를 수 있음)? (FE-05 선보관 가부)
- Q-D2 무한 시즌(endless-sN) 교체 시점·방식, /boards current가 항상 단일 endless인가, 프론트 weeklyBoardKeyAt(KST 월 00:00, ISO 주차 — rankedBoards.ts:26)이 서버 계산과 같은가 (FE-07)
- Q-D3 세션 발급 오류 중 GAME_SESSION_UNAVAILABLE·GAME_WEEKLY_UNAVAILABLE 외에 프론트가 구분할 코드(점검 등)?
- Q-D4 /boards에 주간 보드가 없으면 정상인가(RankedCards.tsx:40 주간 시작 차단), 목록 실패 시 주간 미차단이 의도인가?
- Q-S1 토큰으로 발급한 세션을 401 뒤 토큰 없이 제출하면 익명 수락인가 소유 불일치 거절인가 (FE-50)
- Q-S2 SubmitScoreResponse에 서버 정규화 playerName을 넣을 수 있나(공유 카드 이름과 랭킹 이름 불일치 방지)
- Q-S3 Retry-After가 CORS Expose-Headers에 노출되나 (Q4 답 참고)
- Q-S4 랭킹에 scoreId 주변 조회(around=)·단건 순위 조회가 있나 (FE-14)
- Q-S5 OG·메타 요약 조회가 Next 서버 IP 하나로 전역 스로틀에 집계 — 크롤러 몰림 시 429 폴백 카드 완화책?
- Q-T1 TetrisPlay.tsx:32 `SESSION_REFRESH_AFTER_MS = (120 - 61) * 60 * 1000` — 세션 TTL 2시간 하드코딩 의존. GameSession 응답에 TTL/expiresAt 추가 계획?

#### 7. 메모
- 조사 중 코드·태스크 문서 수정 0. 리뷰 루프 미실행(지시대로 조사만)
- 실측 필요(브라우저·실기기): FE-06 모바일 이어하기 지연, FE-13 슬라이더 점프 지연, FE-37 리렌더 비용, FE-43 슬롯 버튼 실제 크기, FE-51
- L 항목(○)은 조사 에이전트 인용 기준이고 H·M(✔)만 원본 재확인 — 묶음 구현 착수 시 해당 항목 원본 재확인 후 진행

## 2026-10-23 — P1 `battle` 백엔드 구현 (브랜치 `feat-onam-games-polish-battle`)
- 재부팅 후 재개: 프론트 세션 이름 `next-bun-80` → `next-bun-35`(같은 세션 resume, 사용자 확인). worktree 의존성은 `pnpm install --frozen-lockfile`(sandbox가 패키지 내부 `.vscode/` 쓰기를 막아 sandbox 밖)
- 기준선: base에서 `pnpm ci:core` — 단위 1545 중 `verify-worker-pool.spec`이 전체 실행 때만 간헐 실패(1회차 6건·2회차 1건·이후 4회 통과, 단독 16/16 통과). 실패 메시지는 아직 못 잡음 → **BD-17(L, 테스트 불안정)로 P2에서 원인 확인**(lessons 2026-10-22 "간헐 실패를 환경 탓으로 넘기지 않는다")

| ID | 변경 | 회귀 테스트 |
|---|---|---|
| BT-01 | `room.service.lock()` 입력에 `tSpin·lines·pc` 추가, `assertAttack` — `sent > computeAttack(lines,tSpin,b2b,combo,pc)`면 `INVALID_PAYLOAD`(저장소 호출 전). DTO 주석 갱신 | match.spec 거부 5(줄 없이 공격·싱글·테트리스 초과·TSD 초과·PC만) + 허용 5(상쇄·B2B·TSD·PC·콤보). E2E 호출처 3파일에 `LOCK_ATTACK_ROOM`(공격표 14) — 골든 최대 per-lock sent 5 |
| BT-02 | `listRooms`에 `consumeOrThrow('listRoomsSocket'(5/5초), 'listRoomsIp'(30/5초))` | gateway.spec 한도 초과 시 RATE_LIMITED·목록·로비 구독 없음 |
| BT-03 | WS 가드: JWT 검증 오류만 게스트, 유저 DB 조회 오류는 `SERVICE_UNAVAILABLE`(authResolved 미설정 → 다음 이벤트 재조회) | guard.spec DB 오류 → 거절 후 재조회 성공 |
| BT-05 | 종료 시 Redis ZSET `tetris-battle:pending-saves`(점수=마감 시각, 키 TTL 2h) 등록 + `@Cron` 30초 스윕(ENV QA/PROD + TASK_SLOT 1 2단 가드, 1회 20개) → `finalizeIfDue` 후 저장됐거나 매치가 사라졌으면 ZREM. 메모리 깨우기는 유지 | result.spec 등록·저장 후 제거·실패 시 유지·매치 소멸 시 제거·LOCAL/TASK_SLOT 2 스킵 |
| BT-07 | heartbeat 소켓 로컬 최소 간격 1초(`client.data.lastHeartbeatAt`) | gateway.spec 1초 안 재송신 무시 |

- 보류(근거): **BT-06**(보고 통계 대조) — 소비처 없음 + `pieces`(=seq)·`maxCombo` 정의가 시뮬과 같은지 미확인이라 거짓 INVALID 위험 → 통계를 쓰는 기능이 생길 때 · **BT-14**(USER_ID 우선순위) — 기존 테스트(result.spec "전원 제출하면 바로 저장")가 제출자 userId 우선을 의도로 고정하고 소비처 없음 → 정책 결정 시
- 검증: `pnpm ci:core` lint 0 errors·경고 6(기준선 동일) · 단위 **1564/1564**(+19) · build ✅ · E2E `--testPathPatterns tetris-battle`(sandbox 밖) 49 통과·56 skip — Redis 스펙은 `TETRIS_BATTLE_REDIS_TEST_PORT` 없어 **미실행(컴파일만 확인)**
- 교훈: 호출처 grep을 `head`로 잘라 E2E 호출처 누락 → `docs/lessons.md` 2026-10-23

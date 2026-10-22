# 테트리스 멀티(대전) — 작업 기록

> append-only. 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 절을 찾는다.

## 2026-10-22 — 착수: 브랜치·worktree·충돌 협의
- 백: `git worktree add -b feat-onam-tetris-battle .claude/worktrees/tetris-battle origin/main --no-track` → `ce438d0`. 로컬 `main`(`e295de5`, origin보다 뒤)은 건드리지 않음.
- 프: `next-bun-bd`에 같은 이름 worktree 생성 지시(base `d189ae6`).
- `bun-62`(디펜스 메인) 회신 요지:
  - 백 `feat-onam-defense` 13커밋 미푸시. 변경: `src/modules/games/` 거의 전부 · `GameScore.ts`(BOARD_KEY·DEFENSE) · `main.ts`(CORS exposedHeaders) · `app.constants.ts` · 마이그레이션 `179259142{0,1,2}000-*`(운영 DB 실행됨, 구 코드 호환) · E2E 헬퍼(`listen(0,'127.0.0.1')`) · README·eslint 등. **테트리스 엔진 사본은 무변경.**
  - 테트리스 API는 추가만(세션 응답 `boardKey`·`mode`, 503 `GAME_VERIFY_BUSY`, 세션 소모 시점이 검증 확정 뒤로, `?board=`, `GET /boards`).
  - 프론트(`next-bun-1b`)는 리플레이·랭킹·공유를 `_shared`로 공용화(테트리스 동작 불변) + `games/defense/` 신규. 머지 예정일 없음.
  - 요청: `src/modules/games/` 등 수정 회피, 엔진 변경 시 재협의, 마이그레이션 번호 `1792591422000` 이후. → D-003

## 2026-10-22 — 백엔드 엔진·소켓 기반 조사 (메인)
- 엔진은 고정 60fps 결정적 틱 `stepFrame(state, actions, count)` (`src/modules/games/tetris-engine/game.ts:566`). 실시간·리플레이 공용.
- 줄 삭제 결과가 `state.lastLock: LockEvent`로 노출된다 — `lines`·`tSpin('none'|'mini'|'full')`·`backToBack`·`combo`(0=첫 삭제) (`game.ts:46-57`, 설정 `game.ts:396-405`). → **공격량 계산에 필요한 판정은 엔진에 이미 있다.**
- 가비지 줄 삽입 기능은 엔진에 없다(`grep -i garbage` 0건). 판은 `state.board: Uint8Array`(10×40, 위 20줄 숨김, `constants.ts:13-17`), 줄 삭제 후 다음 블록 생성 전 지연 구간(`!state.active`, `game.ts:569-578`)이 있다 → 엔진 수정 없이 대전 래퍼가 이 구간에 판을 밀어올려 가비지를 넣는 방식이 가능(D-004 후보).
- 소켓: `/fishing` namespace가 인증·게스트 모두 접속 허용(`src/modules/fishing/fishing.gateway.ts:50-62`) — 비로그인 대전 namespace의 선례. 멀티 레플리카 브로드캐스트는 `RedisIoAdapter`, 공유 상태는 Redis(`realtime-ws.md`).

## 2026-10-22 — 프론트 조사 결과 (`next-bun-bd`, 조사만, worktree tetris-battle @ d189ae6)
경로 접두는 `next-bun/src/app/games/tetris/`.
- **엔진**: 공개 API `engine/index.ts:6-31`. mulberry32(`random.ts:7`) + 7-bag(`random.ts:15`) — **같은 seed = 같은 블록 순서**, 전원 같은 seed 즉시 가능. `LockEvent`(`game.ts:46-57`)에 lines·tSpin·B2B·combo. **퍼펙트 클리어 판정 없음**, **가비지 삽입 없음**(판 변경은 lockPiece·removeRows `game.ts:418-427`뿐). 엔진 원본은 프론트, 백은 사본 — 규칙 변경 시 ENGINE_VERSION·골든 재생성(`constants.ts:4-6`).
- **실시간 루프**: `hooks/useTetrisPlay.ts:152-176` rAF + 60Hz 고정 누산기, `MAX_CATCH_UP_MS=100`(`:24`). blur·visibilitychange 시 자동 일시정지(`:209-215`) → 대전은 별도 훅 필요.
- **렌더러**: Canvas 2D 전체 재그리기 `lib/renderer.ts:80`, 레이아웃 [홀드3][판10][NEXT3] 17칸(`:34-44`, 최소 셀 8px). 판만 그리는 옵션 없음(`DrawOptions`는 showGhost만 `:76-78`), `TetrisCanvas.tsx` draw 슬롯 1개(`:14`,`:50`) → 미니보드는 렌더러 확장 필요(난이도 중). 상대 2~3판 렌더 성능 우려 낮음(미측정).
- **모바일**(`(fullscreen)/play/TetrisPlay.tsx`): header → 판 flex-1(`:201`) → TouchControls(`:270`, `components/TouchControls.tsx:36-75`). 390×844 추정: 셀 22px, 판 220×440, 폭 374/390 사용, 세로 여유 ≈90px(실측 아님). → **옆 배치 불가, 상단 띠 미니보드(셀 4~5px)면 메인 판 ≈20% 축소**.
- **소켓**: 공용 연결 유틸 없음, 컨텍스트마다 `io()` 직접(`fishing/contexts/FishingSocketContext.tsx:122`, `teams/[teamId]/contexts/TeamSocketContext.tsx:125`). fishing은 비로그인 토큰 없이 연결(`:120`, `:289`). 대전은 새 namespace 컨텍스트 + `src/types/<x>Socket.ts`.
- **리플레이**: `(fullscreen)/replays/[scoreId]/ReplayPlayer.tsx`(createGame+stepFrame 재시뮬 `:70`,`:100`, 스냅샷 탐색 `:26`). 형식이 단일 플레이어라 대전은 새 형식 필요.
- **식별**: 비로그인은 이름 입력뿐(`lib/playerName.ts:22`, 12자), 지속 게스트 ID 없음. 서버 fishing 게스트 ID는 socket.id 해시(`bun/src/modules/fishing/fishing-ws.guard.ts:75-79,118-120`) — 재연결 시 바뀜 → 대전은 방 단위 `playerToken` 필요.
- **디펜스 공용화와 충돌**(`87110e1`): 높음 — `TetrisPlay.tsx`·`(fullscreen)/layout.tsx`·`gamesPaths.ts`·`types/game.ts`·`services/gameService.ts`·`TetrisHome.tsx`·`eslint.config.mjs`. 중간 — playerName·format·storage(`_shared`로 이동). 무변경 — `engine/`·`renderer.ts`·`TetrisCanvas`·`TouchControls`·`useTetrisPlay`. → 대전은 새 경로(`tetris/(fullscreen)/battle/*` 등), 공용 파일 수정은 디펜스 머지 후.

## 2026-10-22 — P1 방·로비 구현 (서브에이전트, 메인 검증)
- 신규 `src/modules/tetris-battle/`: events(216, 계약 정본)·errors·constants·ws.guard·ws-exception.filter(ack 반환)·gateway.dto·gateway(226)·room.service(642)·module + spec 3개. 신규 `test/tetris-battle-gateway.e2e-spec.ts`(소켓, 서비스 경계 mock)·`test/tetris-battle-room.redis.e2e-spec.ts`(opt-in `TETRIS_BATTLE_REDIS_TEST_PORT`). 수정 `src/app.module.ts` +2 · `src/main.ts` +4. 금지 파일 무변경(`git diff --stat` 확인)
- Redis 키: `tetris-battle:room:{code}` Hash{v,json} 2h · `tetris-battle:rooms` ZSET 2h · `tetris-battle:rl:{action}:{subject}` · `tetris-battle:pwfail:{code}:{socketId}` 60s — 전부 TTL
- 보고 수치: lint 0 errors/6 warnings(기준선 동일) · unit 1055/1055(+83) · build ✅ · E2E 179 통과 6 skip(sandbox 밖) · 실제 Redis 6380 19/19(두 레플리카 동시 10명 → 정원 4 정확, CAS 제거 시 3건 실패로 반증)
- 메인 재현: `pnpm lint` 0/6 · `pnpm test` 50 스위트 1055 통과 · `pnpm build` ✅
- 함정: `--testPathPatterns tetris-battle`은 worktree 경로(`.claude/worktrees/tetris-battle`)에 걸려 전체 스위트가 매칭 → `'test/tetris-battle-'`로 좁힌다
- 메인 판단: `socketsLeave`는 `@socket.io/redis-adapter`가 원격 노드에도 전달(어댑터 기능) — 실환경 확인은 배포 후 2레플리카에서

## 2026-10-22 — P1 리뷰 R1 (review-flow · Opus 독립)
| # | 지적 | review-flow | Opus | 메인 교차검증 | 조치 |
|---|---|---|---|---|---|
| F1 | 비밀번호 잠금 동시 요청 우회(mget→scrypt→incr 비원자, `service.ts:640-658`) | 확정 중간 | 확정 높음 | 코드 대조 확정 | 시도 선예약 INCR + joinRoom 빈도 제한 |
| F2 | 같은 소켓 요청 비직렬화(동시 두 방·이름 검증 우회·채널 잔류) + 입장 중 끊김 유령(`gateway.ts:56-58,176-187`) | 확정(유령) | 확정 중간 | 확정 | 소켓별 직렬화 큐, disconnect도 큐 |
| F3 | connected=true 유령 정리 수단 없음(DESIGN §8 주기 정리 누락) | 확정 중간 | (F2에 포함) | 확정 | 방 단위 생존 확인(D-015) |
| F4 | 타인 토큰 재입장 시 한 소켓 두 playerId · 낡은 isSameSocket | 의심 | 확정 낮음 | 확정(`service.ts:255-290`) | 거부 |
| F5 | 채팅·이모트 빈도 제한 소켓 키 → 재연결 우회 | 확정 낮음 | — | 확정 | `{code}:{playerId}` |
| F6 | leavePrevious 오류 삼킴·커밋 후 ack 실패 | 의심 | 의심 | 확정 | 이전 방 이탈 선행 |
| F7 | prune·전원 정리 경로 로비 미방송 | — | 의심 | 확정 | 방송 |
| F8 | 채팅 `\p{C}` 미검사(bidi) | — | 의심 | 확정 | `CHAT_FORBIDDEN` |
- 보류: Redis 명령 무한 대기 · XFF 신뢰 구성(D-015 후속)
- review-flow 실행: `pnpm ci:core` EXIT 0(lint 0/6·unit 1058·build), E2E 180 통과 6 skip(sandbox 밖). 계약 events.ts ↔ DESIGN §16 일치. 전역 APP_PIPE는 WS 게이트웨이에 적용되지 않음(`@nestjs/websockets/socket-module.js:81`)

## 2026-10-22 — P1 리뷰 R2
- R1 F1~F8: 두 리뷰어 모두 원인 제거 확인. 메인 재현 `pnpm ci:core` EXIT 0(unit 1083). review-flow가 실제 Redis 6380 `--testPathPatterns 'test/tetris-battle-'` 21/21(skip 0) 실행 — CAS·TTL·두 레플리카 정원·동시 비밀번호 잠금 실증
| # | 지적 | review-flow | Opus | 메인 교차검증 | 조치 |
|---|---|---|---|---|---|
| G1 | probe `.timeout(2000)`을 redis-adapter가 무시(requestsTimeout 5000) → 소켓 큐 5초 지연 | — | 확정 중간 | 확인(`@socket.io/redis-adapter` dist/index.js:571) | 자체 Promise.race + 백그라운드 실행 |
| G2 | 끊긴 소켓에 client.join → 어댑터 room 잔존 | — | 확정 낮음 | 확정 | 끊김 검사를 join 앞으로 |
| G3 | null 결과 + 정리 변경 미방송(F7 잔여) | 확정 낮음 | 확정 낮음 | 확정 | mutateRoom 단 방송 |
| G4 | setReady 빈도 제한 없음 | 확정 낮음 | — | 확정 | 10/10s |
| G5 | `\p{C}`가 ZWJ 이모지 거부 | 확정 낮음 | — | 확정 | 범주 축소 |
| G6 | 다른 방 입장 실패 시 현재 방 이탈 | 의심 | — | 메인 판단 개선 | 사전 검증 후 이탈 |
| G7 | 정답 입장도 잠금 카운터 누적 | 의심 | — | 메인 판단 개선 | 성공 시 DECR |
| G8 | listRooms 큐 밖 → 로비 재구독 경합 | — | 의심 | 확정 | 큐에 포함 |
- R2 수정 G1~G8 반영(반증 9/9 보고). 메인 재현: `pnpm ci:core` lint 0/6 · unit 1103 ✅. 전체 E2E(sandbox 밖) 7회 중 1회 `test/games.e2e-spec.ts` 1건 실패 → 같은 스위트 단독 4회·전체 4회 재실행 통과
  - 판정: 디펜스 브랜치가 찾은 기존 간헐 실패(E2E 서버 `listen(0)`이 `::`에 열려 로컬 프록시가 점유한 127.0.0.1 포트와 충돌 → 407/404, `feat-onam-defense` `e5e607c`·`docs/lessons.md` 2026-10-22). 실패 스위트가 대전과 무관(`games`)하고 이 브랜치엔 그 수정이 없다(`test/helpers/*` 수정 금지 — D-003). 디펜스 머지 시 해소. 이 브랜치 판정은 `--testPathPatterns 'test/tetris-battle-'` + 전체 반복으로 한다

## 2026-10-22 — 프론트 P-V1(연출)·P0(대전 래퍼) 완료 보고 (`next-bun-bd`, 미커밋)
- P-V1 수정: `lib/renderer.ts` +72/−31 · `components/TetrisCanvas.tsx` +15/−3 · `hooks/useTetrisPlay.ts` +10/−1 · 디펜스 충돌 파일 `(fullscreen)/play/TetrisPlay.tsx` +4/−1 · `replays/[scoreId]/ReplayPlayer.tsx` +9/−2. 신규 `lib/effects.ts`(stepFrame 전후 관찰, 연출 전용 난수)·`effectsRenderer.ts`·`blockSprites.ts`(베벨·광택, 8=회색)·`effectsSettings.ts`(키 `tetris:reducedEffects`, 기본 prefers-reduced-motion)·`hooks/useReducedEffects.ts`·`components/EffectsToggle.tsx`. `lib/storage.ts`·`engine/` 0줄
- P0 신규 `battle-engine/`(engine.ts 26 — 엔진 import 단일 지점 · constants 50 · battle 240 · replay 191 · index 30 · 테스트 2 · 골든 19) + `battle-engine-dev/`(생성기). 공개 API: computeAttack·isPerfectClear·isValidGarbageEvent·createBattle·receiveGarbage·stepBattle·pendingGarbageLines·simulateBattleReplay·buildBattleReplay·encodeGarbageLog. 거절 이유: INVALID_HEADER·INVALID_INPUT·INVALID_GARBAGE·INPUT_AFTER_END·GARBAGE_AFTER_END·FRAMES_MISMATCH. 수신 필터: 게임 오버 뒤·3600건 초과·id 비증가·lines 1~22 밖·hole 0~9 밖 거부
- 검증(프론트 보고): lint 0 · typecheck ✅ · test 558 통과 3 skip(+51) · build ✅ · 순도 테스트(연출 유무로 boardHash·frame·score·rng 동일) · 골든 재생성 바이트 동일 · Playwright 20장(데스크톱·모바일 × 연출 on/off × 5장면). 리뷰: P-V1 R3·P0 R3 두 리뷰어 확정 0
- 메인 확인: 스크린샷 `replay-tetris-b2b-mobile-full.png`(베벨 블록·줄 삭제 파티클·"TETRIS BACK-TO-BACK" 텍스트)·`play-harddrop-mobile-full.png`(하드 드롭 잔상) 육안 확인. 실기기 fps 미검증(사용자)
- 발견: 가비지 탈락은 대개 엔진 블록 아웃(toppedOut=false) → KO는 `game.over`로

## 2026-10-22 — P1 리뷰 R3 종료 · P0b 래퍼 사본
- P1 R3: review-flow 확정 0(6380 실제 Redis 21/21, `pnpm ci:core` EXIT 0 unit 1103) · Opus 확정 0(R2 확정 3건 원인 제거, 백그라운드 reconcile·CAS 경합·DECR·타이머 누수 점검). 의심 1(참고): `\p{Cn}`은 Node ICU 버전 기준이라 런타임보다 새 이모지가 거부될 수 있음 — 수용(운영 Node 업데이트로 해소)
- **P1 종료**: R1 확정 8 → R2 확정 8 → R3 두 리뷰어 0
- P0b: 프론트 `battle-engine/`을 `src/modules/tetris-battle/battle-engine/`으로 복사 — `battle.ts`·`constants.ts`·`index.ts`·`replay.ts`·골든 픽스처 `cmp` 바이트 동일, `engine.ts`만 import 경로(`../../games/tetris-engine`). 테스트는 `battle.spec.ts`·`replay.spec.ts`(원본 `*.test.ts`와 1행 vitest import만 다름). 엔진 사본 6파일도 프론트 원본과 `cmp` 동일 확인
  - `npx jest src/modules/tetris-battle/battle-engine` 38/38 · lint 0/6 · build ✅. prettier 불일치는 기존 엔진 사본과 같은 상태(포맷 강제 없음, 바이트 동일이 우선)

## 2026-10-22 — P2 매치 구현 (서브에이전트)
- 신규 `tetris-battle-match.store.ts`(403, Lua 2개: lock·KO) · `tetris-battle-room.service.match.spec.ts`(414, 31건) · `__spec__/redis-mock.ts`(공용 추출) · `test/tetris-battle-match.redis.e2e-spec.ts`(opt-in 10건 — Lua 규칙 정본). 수정: room.service(1232)·gateway(440)·dto·events·constants·errors·spec·E2E 2개. battle-engine 무수정(import만), main.ts·app.module.ts P1 이후 무변경
- 보고 수치: `pnpm ci:core` lint 0/6 · unit 1181(53 스위트) · build ✅ · E2E tetris-battle 23 통과 · 6380 39/39 · 전체 E2E 187 통과 18 skip · 반증 11/11
- 부하(6380): 4인 × 두 레플리카 × 60 lock 동시 → 오류 0, 수신 id 1..n 연속, 송신 합 = 수신 합
- 후속 지시: lock 상한(D-017 ⑧)

## 2026-10-22 — P2 리뷰 R1
- review-flow: `pnpm ci:core` EXIT 0(unit 1182) · 6380 61/61 · 확정 3(낮음) 의심 3 — 확정1은 6380 직접 재현(우승자 KO: S1 `kos=[p1 place2 disconnect, p2 place1 topout]`)
- Opus: unit 210 ✅ · 확정 4(중간 2·낮음 2) 의심 4
| # | 지적 | review-flow | Opus | 메인 | 조치 |
|---|---|---|---|---|---|
| H1 | 시작과 동시 이탈 → 매치에 살아 있는 유령(`service.ts:462-477`) | — | 확정 중간 | 확정(CAS 밖 status 판정) | CAS 안에서 기권 판정 |
| H2 | 재연결 순간 가비지 유실(Lua 전 읽은 socketId로 emit) | 의심 | 확정 중간 | 확정 | 플레이어 채널 + 채널 입장 후 조회(D-018) |
| H3 | Lua `ko()` 종료 후에도 실행 → 우승자 KO | 확정(재현) | 확정 | 확정 | status 가드 |
| H4 | matchEnded 중복 방송 | 확정 | 확정 | 확정 | 전이시킨 쪽만 |
| H5 | 방 CAS 실패 시 KO 이벤트 유실 | — | 의심 | 수용 | 무조건 방송 |
| H6 | 끊김 시각 HSET 경합·TTL 없는 키 | 의심 2 | 의심 | 수용 | Lua 조건부 + 재확인 |
| H7 | 승자 동시 topOut이 오류 ack | — | 의심 | 수용 | 직전 매치면 무시 |
| — | DESIGN §16에 PLAYER_NOT_ALIVE·rejoin.alive 누락 | 확정 | — | 확정 | 메인이 §16 갱신 |

## 2026-10-22 — 프론트 P3 완료 보고 (`next-bun-bd`, 미커밋)
- 신규: 계약 사본 `src/types/tetrisBattleSocket.ts`(354) · `src/app/games/tetris/battle-ui/`(BattleSocketContext — 게스트 연결·sessionStorage playerToken 복귀·화면별 입장 범위 / 로비·방·대기실·이모트·미니보드·BattleView / useBattlePlay 60Hz 무일시정지·백그라운드 따라잡기 10초 / boardCodec·battleErrors 등) · 라우트 `tetris/(fullscreen)/battle/`(로비·`[code]`·운영 404인 preview)
- 디펜스 충돌 파일: `gamesPaths.ts` +2/−1 · `gamesPaths.test.ts` +2/−2 · `TetrisHome.tsx` +3/−0. 기타 `renderer.ts` +33(가비지 게이지) · `TetrisCanvas.tsx` +5/−1
- 검증(프론트 보고): lint 0 · typecheck 0 · test 584 통과(+30) · build ✅ · Playwright 15장(가짜 socket.io 서버 — **실제 백엔드 연동 미검증**) · 리뷰 R3 두 리뷰어 0
- 질의 회신: 토큰 재입장은 비번 생략·나중 소켓이 자리 인계 · 같은 소켓 요청은 도착순 직렬 · 준비 조건 D-019 · 따라잡기 10초 OK · 실연동은 메인이 DB 없는 로컬 대전 서버(Redis 6380) 준비 후

## 2026-10-22 — 로컬 실서버 스모크 (사용자 지시 "로컬서버 띄워서 테스트", bun-62 통보 후)
- 디펜스 백엔드 :3500(PID 74105, `node dist/main`, cwd defense worktree) 종료 → 이 worktree `pnpm build` 후 `REDIS_HOST=127.0.0.1 REDIS_PORT=6380 node dist/main`(cwd = defense worktree — `.env`를 그대로 쓰기 위해, 이 worktree엔 `.env` 없음). Redis PING→PONG, TetrisBattleGateway 이벤트 구독 로그 확인. 로그 `scratchpad/battle-server.log`
- 3클라이언트 스모크(`scratchpad/smoke.js`, socket.io-client, 실서버): listRooms · 비번 방 생성 · 오답 `ROOM_WRONG_PASSWORD` · 정답 입장 2명 · 채팅(ZWJ 이모지 포함) 수신 · 미준비 시작 `NOT_ALL_READY` · 시작 → `matchStarting`(seed·startInMs 3000·players) · lock sent 4 → 대상 p3, sent 2 → 대상 p2(공격자별 순환) · 각자 `garbage` id 1 수신(hole 서버 난수) · 같은 seq 재전송 ok · 과속 seq `INVALID_PAYLOAD` · topOut → `playerKO{by p1, place 3, reason topout}` · 마지막 topOut → `matchEnded`(p1 1위 kos 2 sent 6) · `attack` 2건 · rematch ok — **전부 기대대로**

## 2026-10-22 — P2 리뷰 R2
- 두 리뷰어: R1 H1~H8 원인 제거 확인. review-flow `pnpm ci:core` EXIT 0(1190) · 6380 66/66 · R1 재현 스크립트 S1·S2 재실행 → 우승자 KO 사라짐. Opus unit 218 ✅
| # | 지적 | review-flow | Opus | 메인 | 조치 |
|---|---|---|---|---|---|
| J1 | 재연결 처리 중 끊김 → recoverMatch가 discAt 무조건 해제 → 영구 생존 | 확정 중간 | 확정 중간 | 확정(두 리뷰어 동일 경로) | 해제 전 방 재확인 |
| J2 | 경기 중 이탈 커밋 후 KO 실패 → 유령 + 채널 잔류 | — | 확정 낮음 | 확정 | finally 채널 이탈 + discAt 기록 |
| J3 | 종료 반영 실패 후 회복이 생존 확인 경로뿐 | 의심 | — | 수용 | MATCH_ENDED·rematch 경로에서 반영 시도 |
| — | recoverMatch throw 시 커밋 후 오류 ack | 의심 | — | 보류(Redis 장애 전제, D-015 보류와 같은 범주) | — |

## 2026-10-22 — P2 리뷰 R3
- J1~J3 반영(반증 8/8). 메인 재현 `pnpm ci:core` lint 0/6 · unit 1198 ✅
- review-flow: **확정 0** — 6380 67/67, lint·test 1198·`tsc --noEmit`(실행 중 :3500 보호로 build 대체). J2 finally 부작용은 생존 확인·재시도로 회수된다고 판단
- Opus: 확정 1(낮음) K1 — leaveRoom이 **커밋 전** 실패해도 finally가 채널·data.room을 지워 멤버 소켓 고립(경기 중 생존 확인은 lock 경로에서 안 돌아 회수 지연). 메인: 두 리뷰어 판단이 갈림 → Opus 쪽 수용(수정 비용 작고, 회수가 로비 조회에 의존하는 건 약함). 커밋됐을 때만 정리로 좁힘 → R4

## 2026-10-22 — P2 리뷰 R4 종료 · 실서버 재스모크
- K1 반영(handleLeaveRoom 커밋된 경우에만 채널 정리, 회귀 5·반증). review-flow **확정 0**(6380 67/67 · lint 0/6 · unit 1202 · tsc ✅) · Opus **확정 0**(unit 230). 의심(공통): Redis EVAL 반영 후 응답 유실 시 이탈 분류 오차 — Redis 연결 장애 전제, D-015 보류 범주
- **P2 종료**: R1 확정 7 → R2 3 → R3 1 → R4 두 리뷰어 0
- 최신 빌드로 :3500 재시작(같은 방식, Redis 6380) → `smoke.js` 재실행 전 항목 기대대로(이전 절과 같은 결과)

## 2026-10-22 — 프론트 P2 연동 중간 보고 (`next-bun-bd`, 사용량 한도로 중단 → 사용자가 세션 초기화)
- 완료: useBattleMatch·MatchScreen(카운트다운·관전·결과·재대결·기권 확인·KO 배지)·RoomStage · `BATTLE_MATCH_AVAILABLE=true` · 재연결 복구(실시간 garbage 보류 → missed와 id 순 병합, 카운트다운 중 보류) · D-020(그 매치를 모를 때만 topOut frame 0) · 놓친 matchEnded는 RESULT로 · lock·topOut 송신함(확인까지 보관, 1.5초·재입장 뒤 재전송, 이전 매치 늦은 응답 무시) · 토큰 재입장 최대 2회 재시도 · 뒤로가기 기권 토스트. 계약 사본 차이 0
- 검증(보고): lint 0 · typecheck 0 · test 609 통과 · 2탭 E2E(가짜 서버) 통과 — **송신함 재작성·재시도 이후 E2E 미재실행**
- 리뷰: R1~R3, R3 review-front 0 · Opus 1 → 반영 후 **R4 미실시**(대상 `useBattleMatch.ts`·`BattleSocketContext.tsx`·`BattleLobby.tsx`)
- 실행: `NEXT_PUBLIC_API=http://localhost:3500 pnpm dev`(next-bun tetris-battle worktree, :3000), 게스트 대전은 NextAuth env 불필요

## 2026-10-22 — 프론트 P2 연동 완료 · 실서버 2탭 실연동 (메인)
- 프론트 보고: P2 연동 R4·R5 두 리뷰어 0 · lint 0 · typecheck 0 · test 609 · build ✅ · 가짜 서버 2탭 E2E 통과. 디펜스 충돌 파일 누적 `gamesPaths.ts` +2/−1 · `gamesPaths.test.ts` +2/−2 · `TetrisHome.tsx` +3/−0 · `TetrisPlay.tsx` +4/−1
- 사고: 프론트가 같은 worktree에서 `pnpm build`를 돌려 메인 `next dev`의 `.next`를 덮어 500(ENOENT) → 규칙 합의: 프론트 build·dev는 메인에 시작/끝 통보 후, lint·typecheck·test만 자유
- 실연동: :3000 디펜스 프론트(PID 1487) 종료 → 이 worktree `NEXT_PUBLIC_API=http://localhost:3500 pnpm dev`. Playwright(크롬 headless, 390×844 두 컨텍스트, `scratchpad/live/flow.js`)
  - A 방 만들기(이름·비번 1234·2명) → URL `/games/tetris/battle/{code}` · B 링크 진입 → 이름 → 비번 입력칸 등장 → 오답 "비밀번호가 맞지 않아요." → 정답 입장 → 대기실(준비·초대 링크·채팅·이모트) · B 준비 → A "게임 시작" → 카운트다운 → 플레이(하드 드롭 연타) → B 탑아웃 → A "1위!"·B "2위" 결과표(순위·KO·보낸 줄·최대 콤보) · 상대 미니보드 탈락 ✕ · A 재대결 → 대기실(B 대기 중) — **전 단계 통과**. 스크린샷 `scratchpad/live/1~9-*.png`
  - UI 상의 가비지 송수신 표시는 이 시나리오에서 줄 삭제가 없어 미확인(서버 라우팅은 smoke.js로 확인, 프론트 가비지 표시는 가짜 서버 E2E로 확인)

## 2026-10-22 — P5 경기 후 검증·결과 저장 구현 (서브에이전트)
- 신규: Entity `TetrisBattleMatch`·`TetrisBattlePlayer`·`TetrisBattleReplay` · 마이그레이션 `1792591423000-CreateTetrisBattleMatches`·`1792591424000-CreateTetrisBattlePlayers`·`1792591425000-CreateTetrisBattleReplays`(존재 확인 멱등·1파일 1테이블·down() DROP PURGE·COMMENT, tsc --strict 0) · `tetris-battle-verify.ts`(순수 검증) · result.service/controller/dto/error.dto · 테스트(단위 verify 30+·service 20+, HTTP E2E 15, 6380 opt-in). 수정: match.store(토큰 해시·roomName 복사, lock Lua `(seq,sent)` 로그·가비지 `at`·`koClock`·`endedClock`, HSETNX 제출, SET NX 저장 가드) · `database.config.ts` 엔티티 3개
- 스키마(사용자 확정 Q7): MATCHES PK MATCH_ID·CK SEED/COUNT 2~4/STATUS/HIDDEN·IDX CRTD_AT · PLAYERS PK(MATCH_ID,PLAYER_ID)·FK MATCHES CASCADE·FK USER_ID→USERS SET NULL·CK PLACE/KO_REASON/VERDICT · REPLAYS PK·FK PLAYERS CASCADE·BLOB gzip
- 마무리(D-022 ②④): 가비지 필수 경계 = 탈락/종료 Redis 시각 − 1초, 예상 제출자 = 생존자 + topout 탈락자. 반증 6/6
- 보고 수치: `pnpm ci:core` unit 1258 · E2E tetris-battle 38 · 6380 88/88 · 전체 E2E 202(프록시 변수 비우고) — 프록시 그대로면 407 무작위 실패(기존 바인딩 문제, 디펜스 `e5e607c`)
- 메인 재현: lint 0 errors · unit 1258 · `tsc -p tsconfig.build.json --noEmit` ✅(:3500 보호로 build 생략)
- `pnpm db:select` 스키마 조회는 이 worktree에 `.env`가 없어 실패(DB 연결 시도 없음) — NCHAR 문자셋 미확인, VARCHAR2(BYTE)로 선례 따름

## 2026-10-22 — P5 리뷰 R1
- review-flow: 6380 88/88 · lint 0/6 · unit 1258 · tsc ✅ · 마이그레이션 멱등·down()·TSTZ·제약·Entity 일치 확인 · 확정 1(낮음) 의심 4. Opus: unit 286 ✅ · 확정 3 의심 4
| # | 지적 | review-flow | Opus | 메인 | 조치 |
|---|---|---|---|---|---|
| L1 | battleEngineVersion 범위 없음 → NUMBER(5) 초과로 경기 저장 영구 실패 | — | 확정 중간 | 확정 | DTO 고정값 검증, 저장은 서버 상수 |
| L2 | 저장 후 제출 201인데 DB 미반영(INVALID면 DISPUTED 누락) | 확정 낮음 | 확정 | 확정 | 원자적 닫힘 표시 + Lua 제출 기록 |
| L3 | 마감 경계: 시뮬 중 finalize → 받아 준 제출 유실 | — | 확정 낮음 | 확정 | L2와 같은 해결 |
| L4 | topout 탈락자 가비지 경계 1초가 모바일 왕복 지연에 짧음 | 의심 | — | 수용 | 3초 |
| L5 | 생존자 frames 상한 여유 2초 | — | 의심 | 수용 | 5초 |
| L6 | USER_ID FK 위반 시 저장 반복 실패 | 의심 | — | 수용 | null로 1회 재시도 |
| L7 | 경기 중 토큰 재발급 → 제출 403 | 의심 | — | 수용 | 매치 Hash 토큰 해시 갱신 |
| L8 | 저장 가드 2시간 — 프로세스 사망 시 미저장 | — | 의심 | 수용 | 가드 TTL 단축 |
| — | 끊김 중 lock 유실 → SENT_MISMATCH | 의심 | 의심 | 프론트 재전송 방식 질의 중 | 대기 |
| — | subs Redis 용량 | — | 의심 | 수용(512MB) | — |
- 프론트 회신(lock 재전송): 미확인 lock 전부를 보낸 그대로(sent 포함) seq 순 재전송, 끊긴 동안·재입장 응답 전 송신 안 함, 서버 응답(ok·거절) 받은 항목만 제거(`next-bun` `battle-ui/hooks/useBattleMatch.ts:136,147-160,190,449`) → **끊김 중 lock 유실 SENT_MISMATCH 의심 해소**. 남는 경우: 재입장 실패로 방에서 빠짐 → 리플레이도 제출 안 함(MISSING)

## 2026-10-22 — 프론트 P5 리플레이 제출 완료 보고 (`next-bun-bd`, 미커밋)
- 신규 `src/services/tetrisBattleService.ts`(submitBattleReplay — 선택 인증, 401이면 토큰 없이 1회) · `battle-ui/lib/replaySubmit.ts`(code 기준: ALREADY_SUBMITTED=저장됨 · SUBMISSION_CLOSED=마감 · MATCH_NOT_ENDED·UNAVAILABLE·429·5xx·네트워크 = 1.5s·3s 재시도 · 나머지 실패). 수정 `useBattleMatch.ts`(종료 시 매치당 1회 백그라운드 제출, 서버 KO(topout 아님)·rejoin alive=false면 미제출, 재대결 뒤에도 이전 제출 지속) · `RoomStage.tsx` · `MatchScreen.tsx`(결과 화면 제출 상태 1줄). 디펜스 충돌 파일 변경 0
- 검증(보고): lint 0 · typecheck 0 · test 621 · build ✅(통보 후 1회). 리뷰 R3 두 리뷰어 0
- 메인 추가 지시: 스스로 탑아웃한 매치는 이후 rejoin(alive=false)이 제출을 막지 않게(topout 탈락자 = 예상 제출자)

## 2026-10-22 — 마이그레이션 실행(담당자=사용자) · 스키마 확인
- 사용자가 `pnpm db:migrate:list`(미적용 = TetrisBattle 3개만 확인) → `pnpm db:migrate:up` 실행: `CreateTetrisBattleMatches1792591423000`·`CreateTetrisBattlePlayers1792591424000`·`CreateTetrisBattleReplays1792591425000` 성공(TYPEORM_MIGRATIONS id 101~103). 이 worktree `.env`는 디펜스 worktree에서 복사(gitignore)
- 메인 `pnpm db:select` 확인: 컬럼 27개 타입·길이(BYTE)·NULL 허용이 DESIGN §17-2·D-022와 일치(USER_ID·KO_REASON만 NULL) · 제약 13개(PK 3 · CHECK 7 · FK 3: PLAYERS→MATCHES CASCADE, PLAYERS.USER_ID→USERS SET NULL, REPLAYS→PLAYERS CASCADE) · 인덱스 `IDX_TB_MATCHES_CRTD` + PK + BLOB LOB 인덱스

## 2026-10-22 — P5 리뷰 R2(review-flow 0) · 실서버 P5 end-to-end (메인)
- L1~L8 반영(반증 9/9). review-flow R2 **확정 0**(6380 93/93 · lint 0/6 · unit 1267 · tsc ✅). Opus R2 대기
- :3500을 최신 dist로 재시작(이제 cwd = 이 worktree, `.env` 있음 · `REDIS_PORT=6380`) → Playwright 2탭(`scratchpad/live/flow-p5.js`): 방→입장→시작→플레이→B 탑아웃→결과 화면 양쪽 **"기록 저장됨"**(role=status) → 재대결 OK
- DB(`pnpm db:select`): `TETRIS_BATTLE_MATCHES` 1행 `oFDKsz2Gf-rpDFBa` STATUS VERIFIED·PLAYER_COUNT 2 · PLAYERS p1(1위, KO_REASON null, VERIFIED)·p2(2위, topout, VERIFIED) · REPLAYS 2행(BATTLE_ENGINE_VERSION 1). `GET /api/v1/tetris-battle/matches/oFDKsz2Gf-rpDFBa` 200(roomName·players·verdict) · `…/replays/p1` 200
- 주의: 이 검증으로 상용 DB에 테스트 경기 1건(2행+리플레이 2행)이 남음 — 정리 여부 사용자 확인
- Opus R2 **확정 0**(unit 295) — 닫은 뒤 저장 실패·`__saved` 실패·가드 만료 동시 저장·예약 필드 모두 문제 없음. 의심 1(낮음): 재대결 뒤 같은 소켓 토큰 없는 재입장으로 재발급되면 직전 경기 Hash 토큰 해시 미갱신 → 직전 경기 제출 403 — 후속으로 기록
- **P5 종료**: R1 확정 8 → R2 두 리뷰어 0 · 실서버 end-to-end(제출 → VERIFIED → DB 저장 → 조회 API) 통과

## 2026-10-22 — P6 대전 기록 재생·공유 (프론트, `feat-onam-tetris-battle-share`) · 메인 실서버 검증
- 프론트 보고: 24파일 +1718/−9 — 경기 페이지 `(fullscreen)/battle/matches/[matchId]`(결과표·2~4판 동기 재생·배속·탐색·가비지·KO·"기록 없음") · OG route(group 밖) · 결과 화면 "기록 보기(새 탭)·공유"(GET match 3초 폴링 최대 75초) · 로비·방은 `(live)` route group으로 이동(소켓은 live만) · `_shared` 수정 0줄 · 디펜스 충돌 파일 0줄. lint 0 · typecheck 0 · test 689 · build ✅. 재생 정합: 골든 VERIFIED 13건 끝까지 재생 = simulateBattleReplay 결과. 리뷰 R3 두 리뷰어 0
- 메인 실서버: 백(이 worktree `feat-onam-tetris-battle-share` dist, :3500, Redis 6380) + 프(:3000 dev) → Playwright 2탭(`scratchpad/live/flow-p6.js`): 대전 → 결과 "기록 저장됨" → "기록 보기(새 탭)·공유" 활성 → 경기 페이지(실연동 방 · 2인전 · 결과표 · 1위 "우승"/2위 "KO" 재생) → `…/og` 200. 스크린샷 `scratchpad/live/p6-viewer.png`. 콘솔 404 1건은 저장 전 GET match 폴링 응답(정상 흐름)
- 미검증(실기): 카톡 인앱·iOS 홈 앱에서 새 탭 열 때 방 유지 · 실기기 2×2 성능
- 상용 DB 테스트 경기 1건 추가(`IWq5cJJZVkE4BFmz`) — D-023 ②와 같이 둠

## 2026-10-22 — P7 대전 입구·최근 대전 목록
- 백(서브에이전트): `GET /api/v1/tetris-battle/lobby`(`{waitingRooms, playingRooms}`, `scanLobby` 분리·Redis 2초 공유 캐시) · `GET /api/v1/tetris-battle/matches?limit&cursor`(VERIFIED·비숨김, CRTD_AT DESC·MATCH_ID DESC 키셋, base64url 커서, 1위 없는 경기 제외 — winnerName 항상 문자열, 한 페이지가 limit보다 적을 수 있음). ci:core unit 1307 · E2E 225 · 6380 104/104
- 프(`next-bun-bd`): `/games` 카드 "친구와 대전"+NEW(`page.tsx` +12) · 테트리스 홈 2열 주요 버튼 + "지금 열린 방 N개" + 최근 대전 5(`TetrisHome.tsx` +10/−6) · 전체 목록 `/games/tetris/battle/matches`(nextCursor로 더 보기, 422면 처음부터). test 705, 리뷰 R3 두 리뷰어 0
- 백 리뷰 R1: review-flow 확정 0(CRTD_AT 실데이터 ms 정밀도 확인) · Opus 확정 1(위조 커서 t 범위 → 500) 의심 3(NLS 정렬 — **메인 `pnpm db:select` NLS_SORT·NLS_COMP = BINARY 확인, 해소** · P5 재저장 CRTD_AT 덮어쓰기 · lobbyCounts Redis 오류 500) → N1~N3 수정 지시

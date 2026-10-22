# 디펜스 게임 — 작업 기록

> append-only. 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 목차를 본 뒤 필요한 절만 읽는다.

## 2026-10-21 — 착수: 브랜치·worktree · 기존 게임 구조 파악
- 백엔드: `git worktree add -b feat-onam-defense .claude/worktrees/defense origin/main --no-track` → `65e1e03`(Merge #274, 테트리스 포함). 원래 작업 트리(로컬 `main` `e295de5`)·기타 로컬 브랜치 무변경
- `git fetch origin` 실패 — `hostkeys_find_by_key_hostfile: ... ~/.ssh/known_hosts: Operation not permitted`(sandbox가 `~/.ssh` 읽기 차단). 자격 경로라 우회하지 않고 받아 둔 `origin/main` 사용. 원격 최신 여부는 사용자 확인 필요(STATUS 위험 절)
- 프론트: `next-bun-1b`에 같은 이름 worktree 생성 + 게임 구조 조사 지시(결과는 다음 절)
- 재사용 대상(백엔드, 읽은 근거):
  - `docs/tasks/games/DESIGN.md` — `GAME_SCORES`(§1, `GAME_TYPE` CHECK IN `'TETRIS'`, `DETAIL` CLOB IS JSON) · `GAME_REPLAYS`(§1-2, gzip BLOB, 복합 FK) · Redis 세션 `game:session:{id}` GETDEL 1회(§2) · REST 4종(§3) · 리플레이 검증 절차(§4-2) · 엔진 원본=프론트/사본=백엔드 + 골든 픽스처(§4-3)
  - `src/modules/games/game-engine.registry.ts:11-17` — `ReplayInput { seed, das, arr, frames, inputs }` — `das`·`arr`는 테트리스 고유 필드라 디펜스 추가 시 인터페이스 일반화 필요
  - `src/entities/GameScore.ts:5` — `GAME_TYPES = ['TETRIS']` — 새 게임은 CHECK 교체 마이그레이션 + 상수 확장
  - DESIGN §4-2 시간 검사 `frames / 60초 ≤ 경과 + 5초` — 디펜스에서 배속(2·3×)을 허용하면 검사 방식 재설계 필요
- 조사 위임(백그라운드, 결과는 `research/`에 파일로): 01 게임 사례 · 02 난이도·레벨링 · 03 전투 시스템 · 04 결정성·리플레이·랭킹 기술

## 2026-10-21 — 프론트 조사 결과 (`next-bun-1b`, 조사만, worktree defense @ `f2e66ff`)
- worktree: `next-bun/.claude/worktrees/defense` · `feat-onam-defense` · base `origin/main` `f2e66ff`(프론트는 fetch 성공). 로컬 main 무변경. sandbox가 worktree 안 `.claude/agents`·`.claude/commands` 쓰기를 막아 sandbox 밖에서 checkout 재실행 — 이후 worktree `.claude/**` 수정도 막힐 수 있음
- a. 카드 추가 `src/app/games/page.tsx:14 GAMES` 배열 1항목 · BNB 활성 `gamesPaths.ts:10 isGamesPath`(자동) · 전체화면 숨김 `gamesPaths.ts:15-20 isFullscreenGamePath`가 테트리스 경로 하드코딩 → 디펜스 경로 추가 필요 · 메타 문구 `games/layout.tsx:4`
- b. 테트리스: 엔진 순수 TS(`engine/index.ts` createGame·stepFrame·simulateReplay…) · 렌더 **Canvas 2D 직접, 라이브러리 없음**(`lib/renderer.ts`, `TetrisCanvas.tsx` DPR·ResizeObserver) · 루프 rAF + 누산기 고정 60Hz(`useTetrisPlay.ts:127-179`, catch-up 100ms) · 재생기 10초 스냅샷 + seek 재시뮬, 배속 0.5~4×(`ReplayPlayer.tsx:17,23,93-127`)
- 재사용 후보(전부 tetris 폴더 안, "tetris" 하드코딩 → 공용화 필요): `services/gameService.ts`(이미 gameType 파라미터화) · `types/game.ts:6 GameType='tetris'`·`:20 TetrisScoreDetail` 고정 · `playerName.ts`·`submitError.ts`·`format.ts`(게임 무관) · `storage.ts:9-14` 키 prefix 고정 · `RankingsView`·`RankingTable`·`GameOverPanel`(구조 재사용, 상세 컬럼은 게임별) · 재생 컨트롤 UI는 `ReplayPlayer.tsx`에 엔진 호출과 섞여 분리 리팩터 필요
- c. 골든 픽스처 생성 `engine-dev/golden.generate.test.ts`(env 플래그) · 성능 `engine-dev/perf.test.ts:62`(200ms) · **엔진 동기화 자동 검사 없음**(프론트). 백엔드도 없음 — 메인 확인: `grep -rn "sha256\|createHash" src/modules/games`는 IP 해시뿐, 테트리스는 수동 복사 + 골든 픽스처 sha 수동 대조(games WORKLOG S3a 절)
- d. 의존성에 게임/렌더/애니메이션 라이브러리 0, 이미지·사운드 에셋 0(Canvas 도형 + 진동만)
- e. 위험 의견: 정적 맵 오프스크린 캐시 · Pixi 등 추가는 번들·의존성 승인 이슈라 비권장 · 틱 비용이 커서 판 길이·틱 수·perf 예산을 설계에서 먼저 · 배속은 "틱당 여러 스텝"으로 · 터치 배치 정밀도(셀 ≥40px, 미리보기+확인) · 입력 좌표는 격자 정수 · 공통부 `_shared` 공용화는 테트리스 회귀 위험 → 별도 슬라이스 권장
- f. 원본=프론트/사본=백엔드 방식 문제: 동기화 검사 부재 · 부동소수 유혹(거리·궤적·감속%) → 정수/고정소수점·거리 제곱·sqrt/삼각함수 금지 명문화 · 서버 CPU DoS → 판 길이·적/투사체 상한을 계약 상수로 · 밸런스 수치가 엔진에 들어가면 조정마다 `ENGINE_VERSION` 상승 → 구버전 리플레이 정책 · mulberry32·fnv1a 공용 core 여부
- 메인 판단 대상 → STATUS 체크리스트 D3·D5·D6과 Q8~Q9로 반영

## 2026-10-21 — 레벨링 설계(D1) 수치 모델
- 사용자 지시 "레벨링 설계 진행하고 보여줘" → DESIGN §L 초안 + `tools/leveling_model.py`
- 모델 v1(리서치 02 예산식 `B(n)` × 톱니, 고정 간격 스폰): 웨이브 여유도 M이 예산과 거의 무관 — 예산↑ → 마리 수·스폰 시간 동반 증가 → `M ≈ P × 간격 / 단위HP`. 톱니가 러시(간격 단축)에서만 나타나고 보스·휴식이 체감 차이 없음 → 기준축을 압력으로 교체(D-010)
- 모델 v2(역산): `Π = P·η/M`. 8스테이지 출력에서 미사용 골드 0~25%·동시 적 최대 약 80(S8 러시 78)·기준 봇 화력 S1 42 → S8 782 DPS
- 무한 모드: 킬 보상 G=110이면 기준 봇이 웨이브 약 17에 화력 상한 → 18~30 정체. G=45로 내려 상한 도달을 웨이브 약 30으로(0.06·0.05·0.045 비교). 램프 후 기준 봇 M<1은 웨이브 33, 상위(η 0.95) 상한 M<1은 40·43·45 부근, 숙련·3× 누적 18.8~20.9분
- 한계: 사거리·경로 커버·상성·상태효과·범위 공격 미반영 근사 — 시뮬레이터(§S)로 재조정 전제

## 2026-10-21 — 전투 설계(D2) 초안
- DESIGN §C 작성: 피해 2축 + 확장 구조(D-012) · 이동·타게팅·유도 투사체 · 상태효과 6종 · 타워 6종 42단계 · 적 11종 · 효과 엔진 · 증강 24 · 규칙 변형 15
- 타워 곡선 확인 `tools/tower_curve_check.py`: 42단계 모두 기준 곡선(§L4) ±15% — 최소 0.88(궁수 5B 역병, 전염 효과 별도) · 최대 1.10(궁수 5A 헤드샷), 범위 밖 0
- 역할 계수(범위 1.6·제어 2.8~3.0·대공 전용 0.65·연쇄 1.6/2.1 등)는 해석 추정 — 시뮬레이터에서 실측 환산 DPS로 재보정 필요
- 1차 제외(스키마 예약): 은신·잠행·도약·보호막·재생, 전역 액티브 스킬, 넉백류

## 2026-10-21 — D2 승인 · 엔진 계약(D3) 초안
- 사용자 "전투 설계 승인, D3 진행하고 보여줘" → DESIGN §C ✅, §E 초안(D-013 🟡)
- 테트리스 계약 확인: `src/modules/games/tetris-engine/replay.ts:19-40`(ReplayInput·실패 사유 4종·성공 필드) — 디펜스는 사유 6종(INVALID_COMMAND·LIMIT_EXCEEDED 추가)
- §L10/§L11 증강 보장 규칙 충돌 발견·정리: "보유 타워 관련 1장 보장"은 플레이 상태 의존이라 주간 "전원 동일 후보"와 모순 → 주간에서 끔
- 프론트(`next-bun-1b`)에 §E 실현 가능성 검토 요청(엔진 원본 소유 쪽)

## 2026-10-21 — 프론트 §E 검토 회신 반영 (`next-bun-1b`, 읽기만)
- 결론: 전부 실현 가능, 수정 4건 + 보완 다수 → DESIGN §E 본문 수정 + §E8(다른 절로 넘김)
  - ① 배속: "렌더 프레임당 N틱"은 120Hz에서 2배속 → 실시간 1초당 30×배속 틱(누산기, `useTetrisPlay.ts:157-159`)
  - ② 구버전 엔진 위치: `engine/versions/` → `engine-versions/v{N}/`(엔진 폴더 밖 — 매니페스트·복사·lint 대상 분리), 명시 맵 동적 import
  - ③ 명령 즉시 적용·일시정지 중 명령 허용·증강 대기 중 PICK만
  - ④ 성능: 상한 엔티티 90분 유효 로그 생성 불가 → (a) 실제 최장 판 ≤300ms · (b) 상한 엔티티 step 단가 × MAX_TICKS ≤2s, 수동 실측 DoD
  - 보완: 매니페스트 해시 범위·파일 위치·생성 패턴(`DEFENSE_MANIFEST_WRITE`) · 프론트 ESLint 폴더 한정 규칙 실측(금지 15종 검출·오검출 0, `eslint.config.mjs:12-14` flat config) · `collectEvents` 옵션·버퍼 재사용 · ES2020 · 비트 연산 제한 · 음수 클램프
- 메인 확인(백엔드):
  - 테트리스 사본 구성 `src/modules/games/tetris-engine/` = `constants·game·index·pieces·random·replay.ts` + `__fixtures__/golden-replays.json` — 테스트 파일 없음 → 디펜스 해시 범위 = `*.ts`(테스트 제외) + `__fixtures__/**`
  - `package.json:66-67` `lint`·`lint:fix`가 `eslint src/` — 사본도 fix 대상 · `eslint.config.mjs:32` ignores에 사본 없음 · `.prettierrc` 존재 → 사본 폴더를 eslint ignores·`.prettierignore`에 추가(구현 시)
  - `tsconfig.json:3` target ES2020

## 2026-10-21 — D3 승인 · Q9 · 시뮬레이터(D4) 초안
- 사용자 "권장대로 승인, D4 진행하고 보여줘" → D-013 ✅, D-014(시즌 분리, 무한 보드 키 `endless-s1`부터) ✅, DESIGN §S 초안(D-015 🟡)
- §S 핵심 판단: 해석 모델의 η(0.75) 가정을 버리고 **임계 배율 이분 탐색**(누수 0 최대 HP 배율 = 실측 여유도)으로 웨이브를 역산 — 모델은 초기값·검산용
- 매트릭스 시간은 판당 0.05초(캠페인)·0.3초(무한) 가정 추정 약 40분 — 엔진 구현 후 실측 갱신

## 2026-10-21 — D4 승인 · 백엔드 일반화(D5) 초안
- 사용자 "승인, D5 진행하고 보여줘" → D-015 ✅, DESIGN §B 초안(D-016 🟡)
- 읽은 현행 코드(끝까지): `games.service.ts`(1-262) · `game-session.service.ts`(1-90) · `games.controller.ts`(1-128) · `games.dto.ts`(1-183) · `ranking-period.ts` · `games.module.ts` · `GameReplay.ts` · `migrations/1792564226000-CreateGameScores.ts`(CHECK `:60`, 인덱스 `:70`·`:75`)
- 사실: 제출이 GETDEL 먼저(`games.service.ts:113`) · 정렬 `SCORE DESC, SCORE_ID ASC`(`:186`)인데 인덱스는 `(GAME_TYPE, SCORE DESC, CRTD_AT)` · TTL `app.constants.ts:48` 2시간 · 시간 허용 오차 5초(`:55`) · 레플리카 3·CPU 제한 없음·env는 서버 `.env`(`infra/docker-stack.app.yml`) · 백엔드에 worker_threads 사용처 없음
- 정정: 이전 문서의 `app.constants.ts:47` 인용은 주석 줄 — 실제 상수는 `:48`(DESIGN §E8 수정)
- 프론트에 §B6 API 계약 변경 확인 요청(CLAUDE.md Ask: API 계약 변경)

## 2026-10-21 — 프론트 §B API 영향 확인 회신 (`next-bun-1b`, 읽기만)
- 테트리스 영향 없음: 세션 추가 필드는 캐스팅만(`gameService.ts:109`) · 422는 상태코드로 final(`submitError.ts:29`) · 503은 retry → 보관·재제출(`GameOverPanel.tsx:136-139`, `TetrisHome.tsx:78-112`) · 409/422 후 세션 재발급 없음(`TetrisPlay.tsx:140-145`) · 랭킹 board 생략 = 현행(`gameService.ts:160`)
- I0 프론트 공용화 항목: GameSession 필드·GameType 유니온·detail 제네릭·storage prefix·submit body 게임별 빌더·replayLoader 파라미터화·ErrorCode 문구
- 반영(D-018): durationMs TPS 기준 · Retry-After 2 · §E3 제출 본문 정의 통일 · 디펜스 das/arr 미전송
- D6로 넘김: 세션 발급은 "모드 선택 → 세션 → 시작"·만료 판정은 기기 경과시간 + visibilitychange 재판정·주간 보드 표기·**판 이어하기**(모바일 백그라운드 탭 폐기 대비)

## 2026-10-21 — D6 UX 승인 · 프론트 기술 설계 회신 · 리플레이 공유 공용화
- 사용자 "승인"(§F0~§F9b) → D-017 ✅ · 사용자 질문 "테트리스 리플레이 공유를 공통으로" → D-019(§F11)
- 공유 확인(백엔드): `origin/feat-onam-game-share` = `ae82cac`(기록 요약 API `GET /games/:gameType/scores/:scoreId`, `findVisibleScore` 공용화, 단위·E2E) + `1e59568`(태스크 문서·CLAUDE.md 라우팅 1줄) — **우리 base `65e1e03`에 없음**. 원격 main 머지 여부는 fetch 불가로 미확인(사용자는 main에 있다고 함). base 갱신 시 CLAUDE.md 라우팅 줄이 우리 추가 줄과 인접 — 충돌 수동 정리 예정
- 프론트 D6 기술 회신(`next-bun-1b`, 읽기만): 라우트·폴더 · I0 순서 6단계 · useDefensePlay · 렌더러 2캔버스·toRenderView·예산 · 링 터치(슬롯 간격 ≥1.1칸) · 화면 방향 비교(세로 9×15 권장) · 재생기 스냅샷 웨이브+30초·최대 120 · 사운드 · 저장 키 · 테스트 → DESIGN §F10
- 프론트 결정 요청 처리: 2·3·4·5·7 메인 판단(D-020), 1(화면 방향)·6(측정 기기)은 사용자 질의(Q11·Q12)
- 프론트 언급 "Playwright 레포 없음" — 메인 최종 검증 Playwright(테트리스 S4·공유 S3 방식)로 해결, 레포 의존성 추가 없음

## 2026-10-21 — 사용자 fetch 결과 (base 갱신 전)
- 사용자 `git fetch origin`: `origin/main` `65e1e03..ce438d0` · `origin/develop` `592387d..7c898dd`
- `65e1e03..origin/main` = `ae82cac`(공유 요약 API) · `1e59568`(공유 문서·CLAUDE.md 라우팅) · `7c898dd`·`ce438d0`(머지) — `git merge-base --is-ancestor ae82cac origin/main` 참 → **공유가 main에 있음 확인**
- 우리 브랜치는 커밋 0(미커밋: `CLAUDE.md` 라우팅 1줄 + `docs/tasks/defense/`) → fast-forward 가능. `CLAUDE.md`는 공유 커밋이 같은 위치에 1줄 추가 → 내 줄을 잠시 빼고 FF 후 다시 넣는 방식(파괴적 명령 없이)

## 2026-10-21 — 프론트 공유 코드 확인 회신 (`next-bun-1b`, origin/main `d189ae6` 읽기만)
- 프론트 origin/main `f2e66ff → d189ae6`(#357 공유 메뉴·미리보기·카카오 키 빌드 주입, 18파일 +916)
- 테트리스 종속: `tetris/lib/share.ts:13·22·32·42·47` · `replayCard.ts:2·27·35-42` · `og/route.tsx:28·63` · `replays/[scoreId]/page.tsx:8·15·26-51` · `ShareMenu.tsx:19·41·47-48` · `ReplayPlayer.tsx`(SDK 로더·공유 버튼). 게임 무관: `gameServerService.ts:21`·`kakao.ts`·`ogFont.ts`·`share.ts` 유틸·`next.config.ts:13`
- §F11 보완 6건 반영(문구 4종 사양·카드 한글/ASCII·ShareMenu props·SDK 훅·formatDurationMs·카드 글자 제약) + 결과 화면 공유 진입점
- 프론트 worktree: `merge-base --is-ancestor HEAD origin/main` 참, 변경 0 → `git merge --ff-only origin/main` 가능(미실행, 사용자 승인 대기)

## 2026-10-21 — I0-B1 백엔드 공용화 구현·검증·리뷰
- 변경(미커밋): `game-engine.registry.ts`(ReplayInput `params`·엔진 `ticksPerSecond·maxSpeed·maxFrames·maxInputLength·sessionTtlSeconds·isValidParams`·async `verify`) · `tetris-game-engine.ts` · `game-session.service.ts`(`getSession` GET 추가, TTL 인자) · `games.service.ts`(형식 → GET → 시간(×maxSpeed) → verify → 확정 시 GETDEL, verify 예외 503 + 세션 유지, `toReplayParams` 예약 키 거부, 저장 `{...params, frames, inputs}` = 테트리스 기존 형식, 리플레이 응답 `params` 추가) · `games.dto.ts`(das/arr 선택·params) · `games.controller.ts`(BUSY 시 `Retry-After: 2`) · `games-error.dto.ts`(GAME_VERIFY_BUSY·GAME_WEEKLY_UNAVAILABLE) · `app.constants.ts` · `main.ts`(CORS `exposedHeaders: ['Retry-After']` — 프론트 요청) · 테스트 3파일 · games DESIGN §2·§4-2 정본 링크
- 검증: 단위 **989/989**(기준선 972, +17) · E2E **168 통과·2 skip**(기준선 164, +4, sandbox 밖) · lint `src/` 0 errors·경고 6(기준선 동일) · build(tsc tsconfig.build) 통과 · stubs 0 · 변경 심볼 grep 전수(createSession·getSession·consumeSession·verify·ReplayInput·isValidParams·ticksPerSecond·sessionTtlSeconds·GAME_SESSION_TTL_SECONDS) — 호출처 모두 반영
- 변이 검사: `getSession` → `consumeSession`(옛 순서)으로 바꾸면 단위 6건 실패 → 원복
- E2E 간헐 실패 1건: `auth.e2e-spec.ts:82` 카카오 가입 201 기대 → **407 Proxy Authentication Required**(sandbox 밖 실행 환경의 HTTP_PROXY 계열 env — auth 코드 무변경, 8회 중 1회). 코드 회귀 아님
- 리뷰(review-flow 메인 / Opus 서브에이전트):
  | 라운드 | review-flow | Opus | 조치 |
  |---|---|---|---|
  | R1 | 2(params 예약 키 · games DESIGN 옛 GETDEL 서술) | 1중간(시간 초과 세션 미소모 — §B4와 불일치) + 2낮음(§B4 순서·§B6 표 · BUSY error 로그 중복) | 전부 반영: 시간 초과도 소모, 문서 정정, 서비스 로그 warn |
  | R2 | 1(warn 로그에 JSON.stringify 중복) | 0 (낮음 2: 같은 로그 지적 · 시간 초과 분기 Redis 예외 시 503 — 수용) | 로그 수정 |
  | R3 | 0 | 0 | **루프 종료 — 두 리뷰어 확정 0** |
- 프론트 I0-F1 build(메인, sandbox 밖) exit 0

## 2026-10-21 — I0-F2 완료 보고 · I0 통합 실검증 (실API · Playwright)
- 프론트 I0-F2(`next-bun-1b`): 화면·공유 공용화(RankingTable·ShareMenu·ScoreSubmitPanel·RankingsView·FullscreenGameLayout·useKakaoReady·gameConfig·shareSpec·replayCard·replayMetadata·ogCard) · lint 0 · typecheck 0 · test 55파일/529 · 리뷰 R2 두 리뷰어 0 · 변경 전후 골든 16항목 비교(14 동일, 2는 mock 인자 `board=undefined`만) · rename 스테이징이 `git add -N`·`reset`로 내려갔다가 재스테이징(작업 트리 무변경)
- 프론트 build(메인, sandbox 밖): I0-F1·I0-F2 모두 exit 0 — 서버/클라이언트 경계 오류 없음. 경고 "workspace root 추론"(worktree 안 lockfile — 기존)
- 서버 기동: 백엔드 worktree `REDIS_PORT=6380`(bun-redis) `dist/main.js` 3500 · 프론트 `next start` 3000. **worktree에 `.env` 없음** → 백엔드 env 검증 실패·프론트 next-auth `NO_SECRET` 500 → 사용자가 두 레포 `.env`를 worktree로 복사(메인은 시크릿 파일 접근 권한 거부 — 우회 안 함). 두 `.env` 모두 gitignore 확인. 프론트는 env 반영 위해 재빌드
- **실API 22/23**(`scratchpad/e2e/games-api.ts`, 이전 테트리스 스크립트 재사용): 로그인 토큰 없음 1건만 생략(로그인 경로 무변경). 추가 확인 4: 리플레이 응답 `params {das,arr}` + 최상위 das·arr 유지 · 기록 요약 200 · 빨리 감기 422 후 같은 세션 409(시간 초과 세션 소모) · `Access-Control-Expose-Headers: Retry-After`
- **Playwright**: 게임 UI **29/29**(env 없을 때 7건 실패 → env 반영 후 전부 통과) · 공유 UI **14/14**(데스크톱·모바일, 카카오 SDK·복사·토스트·Esc) · 공유 추가 **4/4**(더보기·취소·없는 기록) · `/og` 200 `image/png` · 리플레이 메타 og:title·description·image 정상
- 미검증: 로그인 사용자 등록(토큰 없음) · 503 BUSY 실브라우저 재시도(단위·E2E로만) · DAS/ARR 설정 유지는 프론트 storage 키 호환 단위 테스트로 대체
- 검증 서버 종료(3000·3500 LISTEN 0)

## 2026-10-21 — I0-B2 마이그레이션 작성·실행(담당자)·확인
- 사전 조회(`pnpm db:select`, 읽기 전용): 두 TYPE_CK `"GAME_TYPE" IN ('TETRIS')` · 인덱스 `IDX_GAME_SCORES_TYPE_SCORE`·`_TYPE_CRTD` · GAME_SCORES 27행 전부 TETRIS
- 파일: `migrations/1792591420000-AlterGameTypeCheckAddDefense.ts` · `1792591421000-AddGameScoresBoardKey.ts` · `1792591422000-ReplaceGameScoresIndexesWithBoard.ts` — tsc 통과, 가짜 queryRunner로 생성 SQL 출력·따옴표 확인(DB 미접속)
- **사용자 실행**(2026-10-21, worktree에서 `tsx ../../../node_modules/typeorm/cli.js migration:run` — worktree에 node_modules가 없어 `pnpm db:migrate:up` 대신, 메인 레포 작업 트리에는 새 파일이 없음): 3개 "executed successfully" + COMMIT
- 사후 조회: 두 TYPE_CK `IN ('TETRIS', 'DEFENSE')` · `GAME_SCORES_BOARD_CK` `REGEXP_LIKE("BOARD_KEY", '^[a-z0-9-]{1,40}$')` · `BOARD_KEY VARCHAR2(40) NOT NULL DEFAULT 'default'` · 인덱스 `IDX_GAME_SCORES_BOARD_SCORE(GAME_TYPE, BOARD_KEY, SCORE DESC, SCORE_ID)`·`IDX_GAME_SCORES_BOARD_CRTD(GAME_TYPE, BOARD_KEY, CRTD_AT)`만(옛 2개 삭제) · 27행 전부 `TETRIS/default`
- → §B8 "머지 전 차단: M1~M3 실행" **해소**. 운영 코드는 BOARD_KEY를 읽지 않아 DB 선행 상태는 안전

## 2026-10-21 — I0-B2 코드 (보드)
- 사용자 "커밋 전에 다음 구현 작업 진행" → I0-B2 코드 + 프론트 E1 지시(`next-bun-1b`)
- 변경: Entity `GameScore.boardKey` · 레지스트리 `GameBoard`·`SessionBoard`·`defaultBoardKey`·`resolveSessionBoard`·`isRankingBoard`·`listBoards` · 테트리스 `default` 보드 · 세션 `boardKey` + 보드가 정한 seed(null이면 무작위) · `POST sessions` 본문 `CreateGameSessionDto{board?}`(테트리스는 보내면 422) · 제출 시 `session.boardKey ?? defaultBoardKey`로 저장(배포 전 발급 세션 호환) · 순위·랭킹은 보드 안에서만(`s.boardKey = :boardKey`) · `GET rankings?board=`(모르는 보드 422) · 응답 `boardKey`(세션·랭킹 목록·항목·요약·리플레이) · `GET /games/:gameType/boards`(D-024) · 조회 컬럼 상수 `RANKING_ITEM_SELECT`
- 검증: 단위 **995/995**(+6) · E2E **176 통과·2 skip**(+8, sandbox 밖) · lint 0 errors·경고 6 · build · stubs 0 · grep 전수(createSession·resolveSessionBoard·isRankingBoard·listBoards·defaultBoardKey·GameScore 사용처)
- 리뷰(review-flow 메인 / Opus): R1 0 / 중간 1(`ReplayInput`에 boardKey 없음 — §B2와 불일치, 주간 규칙 재현에 필요)·낮음 4 → boardKey 추가(verify·저장·순위 같은 값)·비기본 보드 테스트 단정·Entity 주석·§B2 블록 정정 반영, 주간 period 무시·getReplay TETRIS 분기는 B1으로(§B2 기록) · R2 0 / 0 → **종료**
- 실API(운영 DB, 마이그레이션 후 — 백엔드 `nest build` 후 `dist/main.js` 3500·Redis 6380): 기존 스크립트 22/23(로그인 생략) — BOARD_KEY 저장·조회 경로 포함 · `/boards` `[{default,null,true,null,null}]` · 세션 응답 `boardKey: default, mode: null` · 테트리스 `{board:'weekly'}` 422 · `rankings?board=default` 항목마다 `boardKey` · `board=endless-s1` 422 · 요약(scoreId 28, 방금 등록) `boardKey: default` — 새 행이 DB DEFAULT가 아닌 서비스 값으로 저장
- 스크립트가 끝난 뒤 tsx 프로세스가 종료되지 않아 300초 타임아웃(결과 출력은 완료) → 프로세스 종료 후 curl 분리 실행. 검증 서버 종료(3500 LISTEN 0)

## 2026-10-21 — B1 선행: 주간 보드 계산 (엔진 무관)
- `src/modules/games/weekly-board.ts`: `weeklyBoardAt(now)` → `{ boardKey: 'weekly-{ISO 연도}-w{2자리}', startsAt, endsAt }`(주 경계 = `rankingPeriodStart('weekly')` KST 월요일 00:00, 주차 = ISO 8601 목요일 규칙) · `weeklySeed(secret, boardKey)` = HMAC-SHA256(`defense-weekly:` + 키) 앞 4바이트(BE)
- 테스트 12: 주 경계(일 23:59 / 월 00:00 KST, UTC 일요일 = KST 월요일) · ISO 연말연초(2026-12-31·2027-01-01 → w53, 2027-01-04 → 2027-w01, 2025-12-29 → 2026-w01 — Python `isocalendar()`로 기대값 확인) · 기간 · DB CHECK 형식 · seed 결정성·범위·HMAC 정의
- 아직 호출처 없음 — B1(디펜스 엔진 레지스트리 `resolveSessionBoard('weekly')`·`listBoards`)에서 사용

## 2026-10-21 — B1 선행: 검증 워커 풀 (엔진 무관)
- `src/modules/games/verify-worker-pool.ts`: `VerifyWorkerPool<I, O>(createWorker, { size, queueLimit, timeoutMs })` — 슬롯당 1건 · FIFO 대기열 · 대기열 초과 `VerifyQueueFullError` · 시간 초과 `VerifyTimeoutError`(워커 terminate 후 같은 자리 재생성, 늦은 답은 작업 id로 무시) · 워커 실패 답·크래시 `VerifyWorkerError`(크래시는 재생성) · `close()`(대기·진행 작업 거절, 이후 요청 거절). 모든 실패는 예외 → 서비스가 503 GAME_VERIFY_BUSY + 세션 유지(I0-B1)
- 테스트 7(실제 worker_threads, eval 워커): 결과 · 동시성 1 + 순서 · 대기열 초과 · 시간 초과 후 새 워커로 다음 작업 · 실패 답 후 워커 재사용 · 크래시 후 재생성 · close — 3회 연속 통과. 첫 실행 1건은 테스트가 close 전에 거절 핸들러를 안 붙인 탓(코드 아님) → 수정
- 아직 호출처 없음 — B1에서 디펜스 엔진 워커 엔트리(`dist` JS)·모듈 등록·env `GAME_VERIFY_WORKERS`와 연결

## 2026-10-21 — E1 수신 · D-025 · B1-a 엔진 사본·동기화 장치
- 프론트 E1(`next-bun-1b`): 엔진 v1(맵 9×15·궁수탑·졸개·명령 로그·simulateReplay·골든 28·매니페스트 `0d53defc…`) · lint·typecheck·test 623 · 리뷰 R3 두 리뷰어 0 · perf (a) 0.52ms (b) 1.5~1.66초(plain Node, 부하 낮음 — 겹치면 1.9~2.3초) — 결정 요청 4건 → D-025
- 백엔드 사본: `src/modules/games/defense-engine/`(엔진 .ts 10 + `__fixtures__/golden-replays.json`, `*.test.ts`·숨김 제외, rsync — 수정 없음) + `defense-engine-manifest.json`(프론트 ENGINE_MANIFEST.json 그대로)
- 동기화 spec(사본 밖): `defense-engine.manifest.spec.ts`(D-025 계산식 그대로 — 버전·파일별 해시·전체 해시·대상 밖 파일 0) · `defense-engine.golden.spec.ts`(28케이스 백엔드 재현 + 실패 사유 6종 존재) → **34/34**. 변이 검사: 사본 `constants.ts` 끝에 줄바꿈 1개 추가 → 2건 실패 → 원복(해시 `137f4c7b…` 일치)
- 사본 보호: `eslint.config.mjs` ignores에 사본 폴더 · `.prettierignore`(신규) · `.gitattributes`(신규, `-text` — `git check-attr` 확인)
- 검증: 단위 **1048/1048**(+53: 엔진 34·주간 12·워커 풀 7) · lint 0 errors·경고 6 · build(사본 포함 컴파일) · stubs 0
- 참고: 프론트 원본 엔진 폴더 안에 숨김 폴더 `.claude`가 있음(매니페스트·복사 대상 밖) — 프론트에 확인 요청

## 2026-10-22 — B1-a 리뷰 루프 (review-flow 메인 / Opus)
| 라운드 | review-flow | Opus | 조치 |
|---|---|---|---|
| R1 | 0 | 중간 1(기동 실패 워커 무한 재생성) · 낮음 4(exit·messageerror 미감지 · postMessage·createWorker 동기 예외 · 매니페스트 대상 밖 검사의 숨김 파일 · 윤년 케이스) | 전부 반영: 연속 크래시 카운트·지수 백오프·3회면 자리 끔·로그, 리스너 추가, try, 숨김 건너뜀, 윤년 2건 |
| R2 | 0 | 중간 1(작업 중 크래시도 세서 독성 입력 3회로 자리가 꺼지고 영구 미복구 — DoS) | 작업 중 크래시는 세지 않고 즉시 재생성 + 꺼진 자리 60초 재시도 |
| R3 | 0 | 낮음 1(기동 즉시 죽는 워커가 작업을 받는 바람에 "작업 중"으로 분류돼 요청마다 재생성) | ready 핸드셰이크 — ready 전엔 작업을 맡기지 않음 |
| R4 | 1(ready로 카운트 리셋 → ready 직후 죽는 워커 무한 재생성) | 낮음 1(ready 안 보내는 워커에 대기 작업 영구 매달림) | 카운트는 작업 답에서만 리셋 · ready 시간 상한 |
| R5 | 1(두 번째 ready가 진행 작업을 지움) | 낮음 1(같은 지적) | 이미 ready면 무시 |
| R6 | 0 | 0 | **종료** |
- 최종: `verify-worker-pool` 16 테스트(3회 연속 통과) · 변이 확인 4종(상한 99·작업 중 크래시 세기·ready 조건 제거·중복 ready 가드 제거 — 각 실패 확인 후 원복) · R6 첫 실행 1건 실패는 메인 변이 검사 중 파일을 리뷰어가 본 오탐 → `docs/lessons.md` 2026-10-22 항목

## 2026-10-22 — R1 수신 · 메인 검증 (build · 운영 404 · Playwright)
- 프론트 R1(`next-bun-1b`): `renderer/`(palette·viewport·interpolate·particles·quality·mapLayer·sceneLayer) · `useDefenseCanvas` · `lib/{benchScene,frameStats,devGate}` · `/games/defense/dev`(측정 화면) · lint·typecheck·test 639 · 리뷰 R4 두 리뷰어 0 · 엔진 폴더 무변경(매니페스트 `0d53defc…`), 엔진 폴더 `.gitattributes` 추가(숨김 — 재복사 불필요)
- 프론트 `pnpm build`(sandbox 밖) exit 0 — `/games/defense/dev` 11.7kB
- **운영 차단 확인**: `next start` 운영 서버에서 `/games/defense/dev` → **404**(제목 "게임 | FiveSouth", 측정 화면 문구 0). worktree `.env`로 빌드한 결과라 그 파일에 `NEXT_PUBLIC_DEFENSE_DEV` 없음도 간접 확인(프론트 리뷰어: CI·Dockerfile에도 없음)
- **Playwright**(개발 서버, 시스템 Chrome headless, 360·390px, DPR 2): 캔버스 2장 · 콘솔·페이지 오류 0 · 오버레이 1초 간격 갱신 · 합성(적 200·탄 400·입자 400) desktop headless FPS 56·그리기 avg 0.37 / p95 0.70ms · 저밀도(30) 장면에서 흙길·돌 받침·궁수탑(지붕·포신·레벨 점)·원형 지상 적·삼각 공중 적+그림자·체력바·데미지 숫자 확인 · 엔진 구동 장면 동작(투사체는 엔진이 결정) · "10초 측정" → "결과 JSON 복사" 버튼과 결과 JSON(모드·요청/실제 수·품질 시작/끝·캔버스·DPR) 출력. 스크린샷 `scratchpad/e2e/shots/defense-dev-*.png`
- 관찰(프론트 전달, 차단 아님): 측정 화면은 BNB가 하단 컨트롤 일부를 덮는다(측정 화면 전용) · 적 실루엣이 모두 흰색(종류별 형태·색은 E2·F)
- **남은 것**: 사용자 실기기 측정(아이폰·저사양 안드로이드 — 프론트 보고의 절차 a~d) → 결과 JSON을 이 WORKLOG에
- 검증 서버 종료(3000 LISTEN 0)

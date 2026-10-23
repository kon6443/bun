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

## 2026-10-22 — 브랜치 최종 리뷰 (백엔드 `origin/main..HEAD`, 사용자 "리뷰 내가 하던대로 + API·Playwright")
- 커밋 5개(`8b7c5ce` I0 · `0dcbf4d` 엔진 사본 · `d2be5ce` 주간 보드·워커 풀 · `3b95832` 문서 · `a066aaf` lessons) 후 브랜치 전체를 두 리뷰어로
- R1 review-flow(Opus 서브에이전트, 스킬 절차): 코드 결함 0 · 문서 2(주간 seed "하위 32비트" ↔ 코드 앞 4바이트 · games DESIGN 세션 스키마에 boardKey·게임별 TTL 없음) · Info 1(동기 검증기의 결정적 예외도 503)
- R1 Opus 독립(1차 API 시간 초과로 종료 → 재실행): 코드 결함 0 · 중간·추정 1(워커 풀이 `{ok:false}` 답과 크래시를 같은 오류로 — B1에서 재현 실패가 503 무한 재시도) · 낮음·추정 1(`search_condition_vc` 12.2+ — **해당 없음**: I0-B2 사전 조회에서 이 컬럼을 실제로 조회해 값 확인, 운영 19c, 마이그레이션 성공)
- 반영: 문서 2건 · DESIGN §B2 B1 넘김 ③(엔진 예외 = 재현 실패, 인프라만 503) + **워커 답 규약**(재현 실패·엔진 예외는 `{ok:true, result:{ok:false}}`, `{ok:false}`는 워커 처리 실패 전용) · 워커 풀 머리 주석 — 로직 변경 없음
- R2 review-flow 0(낮음 1: DESIGN `'weekly-YYYY-Www'` 대문자) / Opus 0(낮음 1: 워커 풀 테스트 픽스처 `ok:false`가 'bad replay' — 규약과 어긋남) → `76c1bd1`
- R3 review-flow 0 + games 단위 15회 중 1회 실패(이름 미확보) / Opus 0 → 재현 시도: 워커 풀 6병렬×5회 30/30·games 15회 0실패 — 재현 안 됨. 의심 지점(고정 800·1200ms 대기 후 생성 수 단정)을 `waitUntil` 폴링으로 → `14084b6`
- R4 review-flow 0 / Opus 0(낮음 2: 느린 환경에서 "ready로 카운트 리셋" 회귀를 놓칠 수 있음 · waitUntil 상한 = jest 기본 5초) → exit 수 기준 대기·상한 3초, 변이(ready에서 카운트 리셋) 3회 실패 확인 → `2339af8`
- R5 review-flow 0 / Opus 0 → **종료**
- **통합 검증**(백엔드 브랜치 dist 3500·Redis 6380·운영 DB + 프론트 최종 커밋 `cacfca0` 운영 빌드 3000): 프론트 build exit 0 · 실API 회귀 22/23(로그인 생략) · 새 동작 — `/boards` · 세션 `boardKey: default, mode: null` · 테트리스 `board` 422 · `rankings` 보드 기본·`board=default&period=weekly` 200·`endless-s1`/`Bad_Key` 422 · 리플레이 `params {das,arr}`+최상위 das·arr · 요약 `boardKey` · 형식 혼합 422 · CORS `Expose-Headers: Retry-After` · 빨리 감기 422 `GAME_REPLAY_INVALID` → 같은 세션 409 `GAME_SESSION_INVALID`(1차는 세션 발급 스로틀 20/분에 걸려 65초 뒤 재실행) · Playwright 게임 **29/29** · 공유 **14/14** + 추가 **4/4** · `/og` 200 `image/png` · 운영 `/games/defense/dev` 404 · 개발 서버 측정 화면 하단(360·390px) "10초 측정" 버튼 하단 691px < BNB 상단 709~710px(겹침 없음)·오류 0
- 최종: 단위 **1059/1059**(51) · E2E **176·2 skip** · lint 0 errors·경고 6 · build · stubs 0 · 검증 서버 종료(LISTEN 0)
- 프론트(`next-bun-1b`): 브랜치 최종 리뷰 R1 두 리뷰어 0 → 커밋 3개 `87110e1`(I0-F1+F2 — 같은 테트리스 파일을 겹쳐 고쳐 합침)·`07035eb`(E1)·`cacfca0`(R1), 커밋마다 그 시점 트리로 lint·typecheck·test 단독 검증

## 2026-10-22 — E2 지시 · B1-b 디펜스 레지스트리 연결 (사용자 "구현 남은 것 진행")
- 프론트(`next-bun-1b`)에 E2 지시(범위·계약 고정: simulateReplay 시그니처·실패 사유 유지, 무한·주간 헤더 `{mode:'endless'|'weekly', boardKey, seed, ticks, inputs}`) → 질의 2건 답 = D-026(무한·주간 데이터는 S1 · 결과 `wavesStarted` 추가). 커밋은 사용자 승인 후로 정정 전달
- 백엔드 B1-b(미커밋):
  - `defense-game-engine.ts` — 보드(endless-s{시즌}·weekly-YYYY-wNN, 본문 없음 = 무한) · 주간 seed HMAC · 비밀값 없으면 weekly만 503 `GAME_WEEKLY_UNAVAILABLE`·/boards에서 빠짐 · 미래 주·없는 시즌 422 · params `{}`만 · 30틱·3배속·162,000틱·20,000·TTL 4시간
  - `defense-verify.ts`(엔진 래핑 — 예외 = `ENGINE_ERROR` 확정 결과 · NOT_STARTED 추정, D-026에서 `wavesStarted`로 교체 예정) · `defense-verify.worker.ts`(풀 규약) · `defense-verify.service.ts`(첫 검증 때 풀 지연 생성 · `GAME_VERIFY_WORKERS` 1~8 · 종료 가드)
  - 레지스트리 `isPeriodRanking`(주간은 period 무시 — getRankings·등록 직후 순위) · `topLevelReplayParams`(getReplay의 `TETRIS` 분기 제거) · `GAME_TYPES`에 DEFENSE · 모듈 factory 배선 · Swagger · README env
- 리뷰 루프:
| 라운드 | review-flow | Opus | 조치 |
|---|---|---|---|
| R1 | 0(의심 2: 서비스 테스트 공백·주간 리플레이 복제) | 0(의심 6: 주간 리플레이 복제·결정적 타임아웃 반복·배선 테스트 공백·종료 뒤 풀 재생성·NOT_STARTED 목숨 5 규칙·Swagger) | 서비스 spec(가짜 Worker)·모듈 spec·`destroyed` 가드·GameRanksDto 설명 · 복제·타임아웃은 DESIGN §B8 게이트(복제는 사용자 결정 대기) |
| R2 | **0**(의심 1: Swagger 문구) | **0**(낮음 2: 모듈 spec이 셸 env에 깨짐·verify 배선 단정 없음) | 셋 다 반영(테스트·문구만) → **종료** |
- 변이 확인: 종료 가드 제거·워커 상한 9·env 키 오타·verify 배선 교체 → 각각 실패 후 원복(sha 일치) · 셸에 `GAME_WEEKLY_SEED_SECRET=x`여도 모듈 spec 통과
- 실제 워커(dist 빌드): `DefenseVerifyService` 워커 2개 기동 → 3건 왕복 20ms(`INVALID_HEADER` — S1 전 의도) → 정상 종료 (메인·리뷰어 각각 재현)
- 검증: 단위 **1110/1110**(54) · E2E **190·2 skip**(+14 디펜스) 3회 중 2회 전부 통과, 1회 `file-share` 401 케이스 1건 실패(이번 변경 밖 모듈, 단독 5회 재실행 모두 통과 — 미재현) · 작성 직후 games E2E 첫 4회 중 3회에서 매번 다른 1~2건 실패(메시지 미보존), 이후 12+3회 연속 통과 — 미재현, 원인 미확정(동시 부하 의심) · lint 0 errors·경고 6 · build · stubs 0
- 추가(사용자 결정 D-027): 진행 중 주간 리플레이 404 — `isReplayPublic` + 단위 6·E2E 1 · prettier를 games 전체에 잘못 돌려 무관 파일 9개 서식 변경 → 역패치로 HEAD 복원, 편집 파일 7개는 3-way 병합으로 편집 줄 외 서식 제거 · 단위 **1116/1116** · games E2E 58/58 · tsc
- 개발 서버(사용자 구경용): 백엔드 worktree `nest start --watch` 3500(Redis 6380, 운영 DB 접속 — 사용자 지시) · 프론트 worktree `next dev` 3000. `.env`에 `GAME_WEEKLY_SEED_SECRET` 없음 → `/boards`는 무한만, weekly 세션 503(설계대로)

## 2026-10-22 — E2 수신 · 백엔드 사본 동기화(B1-c) · D-028
- 프론트 E2(`next-bun-1b`, 미커밋 — S1 착수 전 상태 보존: 프론트 세션 scratchpad `e2-snapshot/`(tracked.patch·untracked.tar·status·base `cacfca0`)): 타워 6·적 11·상태효과 6·효과 엔진·증강 24·주간 규칙 15·다중 경로·조기 호출·판매 환급 · ENGINE_VERSION **2** · 매니페스트 `515271f3…` · 골든 **42**(성공 16·실패 26, 사유 6종) · `wavesStarted` 추가 · lint 0·typecheck·test 786(defense 257) · 리뷰 10회차 두 리뷰어 0 · perf (a) 3.2~3.3ms (b) 2.11~2.28s(계약 2.0 초과) → D-028
- 동기화: 프론트 엔진 폴더(`*.test.ts`·숨김 제외)·매니페스트를 S1 편집 전에 복사 → 백엔드 매니페스트 spec 통과(전체 해시 일치) · 골든 42 백엔드 재현 통과 · golden spec 엔진 버전 단정 2로 · `defense-verify.ts` NOT_STARTED = `wavesStarted === 0`(목숨 5 규칙 등 추정 오판 제거, 테스트 2)
- 백엔드 Node 실측(dist, 부하 4~5, 중앙값/7회): E2 최장 판 4,495틱 **4.10ms** · Lv5 판 4,115틱 4.51ms · 판 상한 162,000틱(웨이브 미시작) 16.0ms — (a) 계약 ≤300ms 여유. (b)는 프론트 하네스(engine-dev) 수치 사용
- B1-c 리뷰 R1: review-flow 확정 1·경미 2 / Opus 확정 1·의심 2 — **같은 확정**: 디펜스 E2E 제출 본문이 `engineVersion: 1` 하드코딩 → 엔진 2에서 409(동기화 후 E2E 미실행 — 메인 누락) → 사본 `ENGINE_VERSION` import로 · 서식 1줄·`START_LIVES` 복원 · 의심: 타임아웃 503 반복(O1 완료 판정에 "백엔드 (b) ≤ 타임아웃 절반" 추가) · 서버 경로 NOT_STARTED 실제 엔진 테스트 없음(S1 동기화 때 무한 보드 대기 판으로 추가 — 후속) · Opus 실측: 입력 20,000·162,000틱 최악 19ms, 골든 3회 연속 결정성 일치
- B1-c 반영 후 검증: 단위 games 240/240 · 전체 E2E **191 통과·2 skip**(sandbox 밖) · E2E 제출 버전을 옛 값 1로 되돌리면 2건 실패 확인 후 원복 · lint 0 errors·경고 6 · tsc · R2 두 리뷰어 **확정 0** → 종료
- 커밋(사용자 승인): 백 `39e1f43`(B1-c)·`bc7983b`(문서) · 프 `638b9da`(E2 — 보존 스냅샷으로 S1과 분리, 임시 인덱스+commit-tree, 커밋 트리 단독 검증: 매니페스트·골든 sha 일치·tsc·eslint 0·vitest 786)
- `GAME_WEEKLY_SEED_SECRET`: 사용자가 생성해 로컬 worktree `.env`·운영 fs-01 `.env`에 같은 값으로 추가(해시 비교로 일치 확인, 값은 기록하지 않음) · 백엔드 개발 서버 재기동 → `/boards`에 `weekly-2026-w43`(current)·`w42` 노출, weekly 세션 SUCCESS

## 2026-10-22 — 공용화 분리 PR (D-030)
- 백 `feat-onam-games-common`(base origin/main `c016557`): `c23543a`(=8b7c5ce) · `4306bfb`(=e5e607c, lessons 충돌 — 이번 항목만) · `bec681f` README · `1868baa`(=3b95832 디펜스 설계 문서, CLAUDE.md 라우팅 대전·디펜스 두 줄 유지) — 단위 1290 · E2E 215·56 skip ×3 · lint 0 · build · 리뷰 두 리뷰어 확정 0(낮음: 미사용 주간 에러 DTO·Swagger DEFENSE 문구 → 리베이스 충돌 회피로 PR 본문 명시)
- 리뷰 의심 "세션 발급 본문 검증 신설" → 프론트 확인: main `882a8b0`·`87110e1` 모두 본문·Content-Type 없음(`gameService.ts:96-99`), strict 스키마 없음, BUSY 자동 재시도 1회 → 해소
- 프 `feat-onam-games-common`(base `882a8b0`): `6a81e10`(=87110e1, 충돌: gamesPaths·ReplayPlayer·대전 playerName import 3) · `0dfc96a` 주석 — test 644 · 리뷰 2라운드 0
- 통합(두 브랜치 dist·운영 빌드, 운영 DB): 실API 22/23(로그인 생략) · boards·session boardKey·tetris board 422·defense 404·replay params·rankings board·CORS · Playwright 게임 29/29·공유 14/14+4/4 · OG 200 · 대전 페이지 200 · 서버 종료
- 푸시(사용자) → PR: 백 https://github.com/kon6443/bun/pull/279 · 프 https://github.com/kon6443/next-bun/pull/361 (base develop) — 머지는 사용자 승인 대기

## 2026-10-22 — 백엔드 디펜스 브랜치 리베이스 (사용자 승인)
- 공용화 PR #279·#361 머지 후(origin/main `a96f8d2`) `feat-onam-defense`를 origin/main 위로 리베이스. 미커밋 문서는 임시 WIP 커밋으로 묶었다가 리베이스 후 `reset --soft`로 다시 미커밋 상태로 복원(stash 미사용)
- 자동 제외: `8b7c5ce`(= main `c23543a`) · 충돌 해결: README(main 쪽 유지 후 마지막에 디펜스 서술·env·기준선 재반영 — 미커밋) · CLAUDE.md(main 쪽 = 대전·디펜스 두 줄 — `3b95832`는 빈 커밋이 되어 skip) · lessons.md(두 항목 모두 유지, `e5e607c`는 빈 줄 1줄만 남음)
- 커밋 14개(디펜스 전용) · HEAD `90f9017` · 검증: tsc · lint 0 errors(경고 6) · 스텁 0 · 단위 **1424/1424**(62) · E2E **230·56 skip** ×2 · build(워커 js 포함)
- 프론트 디펜스 브랜치 리베이스는 S1 커밋 후(작업 트리에 S1 미커밋 변경)

## 2026-10-22 — S1 완료 수신 · 백엔드 사본 동기화(B1-d)
- 프론트 S1(R1~R10, 마지막 두 라운드 두 리뷰어 0): 캠페인 8·무한 endless-s1·주간 weekly-YYYY-wNN 데이터 · 생성기·시뮬레이터(병렬 child_process 워커, 순차와 바이트 동일) · 탐색 봇 B8·H3·무교란 계보 고정 · 용 25 단독 규칙 · ENGINE_VERSION 3 · 매니페스트 `17eee826…` · 골든 52(`9fd9759d…`) · lint 0·typecheck·test 877 · 병렬 실측: 기준 봇 21판 2.48배, 주간 4.10배, 주간 전체 85분→7.9분, 웨이브 생성 37분→26분(탐색 봇 2배 무거워진 상태)
- 진행 경과: (B) 37/30 ✗ → 진단(탐색 봇 5 seed 표본 오차 · 웨이브 25 용 뽑기 운으로 실력 무관 즉사 5/21) → (A) 탐색 봇 보강·용 단독 규칙 → 2029‰ 38✗/45 → (A2) 2740‰ 33✓/43✓
- 백엔드 동기화(미커밋): 엔진 폴더·매니페스트 복사 → 매니페스트 spec 통과 · 골든 52 재현 · golden spec 버전 3 · 신규 `defense-verify.engine.spec.ts`(골든 무한·주간 판 서버 경로 재현 + 대기만 한 무한·주간 판 실제 엔진 NOT_STARTED) · 실제 워커(dist) 무한·주간 골든 5판 점수 일치, 3~189ms(첫 판은 워커 기동 포함) · 단위 **1445/1445** · E2E 230·56 skip
- B1-d 리뷰 R1: review-flow 코드 확정 0(문서 확정 1 — README 기준선이 새 spec 추가 전 값) · Opus 확정 0 — 보드 키 해석 2000~2100년 5271개 전부 엔진 해석 OK·주간 판은 boardKey+seed만으로 결정·판 시작 생성 무한 0.08ms/주간 0.57ms·결정성 골든 2회 일치. 후속 반영: 서버 시즌 상수↔엔진 `ENDLESS_BOARD_KEYS`·`isWeeklyBoardKey` 결합 테스트(시즌만 2로 바꾸면 실패 확인 후 원복) · 엔진 spec detail에 engineVersion 단정 · README 1446/63
- **O1 근거(Opus 실측, 부하 높은 로컬)**: endless-greedy 60145틱 681ms(프론트 plain Node 123.5ms) · 1만 틱당 비용이 58→210ms로 증가(Lv5 타워 15~16개) — 162000틱까지 버티는 판 외삽 약 4초로 워커 타임아웃 5초 근접(의심). O1 완료 판정(백엔드 (b) ≤ 2.5초)에 "최장 판 외삽"도 함께 측정
- B1-d 리뷰 R2: 두 리뷰어 **확정 0** → 종료(import 한 줄로 합침). review-flow가 games 단위 10회 중 1회 1건 실패를 봤으나 출력 미보존 → 메인이 부하 26(load avg) 상태에서 **25회 연속 로그 보존 실행, 실패 0**(미재현, 원인 미확정 — 의심 후보: 타이밍 의존 `verify-worker-pool.spec`). 재발 시 로그 파일로 특정

## 2026-10-22 — 프론트 S1 커밋·주간 seed 6·리베이스 · 백엔드 재동기화(B1-e)
- 프론트(`next-bun-1b`, 미푸시): origin/main `19f4cf7` 위 6커밋(e152c6f 엔진 v1 · 323e5a5 렌더러 · dba17b6 E2 · 41cdcb6 S1 엔진+생성 데이터(합침) · 03b4d83 시뮬레이터·탐색 봇·병렬 · 51e727b 주간 seed 2→6) — 87110e1은 `--onto`로 제외, 커밋마다 단독 tsc·lint·test 통과(e152c6f는 작업 트리 `.next/types` 잔여물만 제외하면 0)
- 주간 재생성(D-031): 허용 2070/9171쌍 · 다른 seed 재검증 대역 안 63%(직전 40%) · 영향 530~1410(직전 208~3275) · 매니페스트 `ee6d0fe6…` · ENGINE_VERSION 3 유지(미배포)
- 백엔드 재동기화: 3파일(weeklyCombos·골든·매니페스트) · 단위 1446 · E2E 230·56 skip · 리뷰 두 리뷰어 확정 0 — 의심 해소: `pnpm db:select`로 GAME_REPLAYS 집계 → TETRIS v1 38건뿐(디펜스 0) · 프론트 디펜스 브랜치 원격 미존재(배포 이력 없음)

## 2026-10-22 — F1a 수신 · 메인 검증 (build · Playwright S1 클리어)
- 프론트 F1a(`next-bun-1b`, 미커밋, 엔진·매니페스트·골든 무변경): `/games` 카드 → `/games/defense` 허브(캠페인 지도 8·잠김·별) → `/games/defense/campaign/[s1~s8]`(난이도, 어려움은 보통 클리어 후) → `/games/defense/play/stage/[boardKey]`(s1·s1-easy·s1-hard, `?seed=` 고정) → 결과(별·다시·다음·패배 원인) · useDefensePlay·HUD·WaveBar·TowerRing(2탭·단축키·한글/Dvorak)·진행·다시보기 localStorage · 렌더러 타워 6·적 12종 · lint 0·typecheck·test 1088 · 리뷰 R4 두 리뷰어 0
- 메인: 프론트 `next build` exit 0(play 10.8kB) · 운영 빌드(3000) Playwright `defense-f1a.mjs` **20/20**(모바일 390·데스크톱 1280): 허브 잠김 · 어려움 잠김 · 3× · 가이드 순서 타워 7기 · **S1 보통 클리어 victory·별 3·목숨 20** · 다음 → S2 · S2 해금 저장 · localStorage 진행·다시보기 · 어려움 열림 · 콘솔·페이지 오류 0. 스크린샷 `scratchpad/e2e/shots/defense-*.png`
- 관찰(F1b 전달): 타워·적이 대부분 흰·회색 원이라 종류 구분이 약함(대포·궁수, 졸개·질주병) · 하단 BNB가 허브 목록 아래를 덮음(스크롤로 접근은 가능)
- DESIGN §F10 경로 `play/stage/[stageId]` → `[boardKey]`(난이도 접미사 — 프론트 요청)

## 2026-10-22 — F1b 수신 · 메인 검증 → 수정 요청
- 프론트 F1b(미커밋, 엔진 무변경): 종류 구분(타워 6색·적 모양·테두리·표식) · 허브 BNB 여백 · 튜토리얼·브리핑·도감 · 효과음(기본 꺼짐·HUD 토글·켤 때만 AudioContext) · 설정 · 이어하기 · 나가기 확인 · 문양·쿨다운 고리·보스 막대·연출 · lint 0·typecheck·test 1123 · 리뷰 R3 두 리뷰어 0
- 메인: build exit 0 · Playwright `defense-f1b.mjs` **15/15**(허브 맨 아래 카드가 BNB 위 · 튜토리얼 0→1→2→종료·tutorialDone · 효과음 기본 off·AudioContext 0 → 켜면 생성 · 나가기 확인 중 일시정지 · 허브 이어하기 → 같은 웨이브·골드로 일시정지 복원 · 설정 기본 배속 3 → 다음 판 3× · 도감 data-known · 오류 0) · S1 클리어 회귀 `defense-f1a.mjs` **20/20**
- **스크린샷 검토로 수정 요청 3건**(테스트는 통과했지만 화면에서 보인 결함): ① 390px HUD 「웨이브 n / N」 두 줄로 깨짐(효과음 버튼 추가 후) ② 적이 전부 흰 원 — 모양·테두리·표식이 실제 렌더에 안 나옴(렌더러 단위 테스트 통과와 불일치 → 실제 렌더 경로 회귀 테스트 요청) ③ 튜토리얼 배너가 왼쪽 위 슬롯을 덮음
- 수정 후 재검증: build exit 0 · HUD 「W n/N」 320·360·390px 모두 한 줄(수치 칸 높이 = 줄 높이, 잘림 없음) · 튜토리얼 0단계 말풍선이 아래 띠로(강조 슬롯·0번 슬롯 안 덮음) · 웨이브 3 장면에서 질주병이 분홍 마름모 + 어두운 윤곽선(2px 이상)으로 졸개(흰 원)와 구분 · Playwright F1b **15/15** · S1 클리어 **20/20**
- 메인 오판 기록: ② "적이 전부 흰 원 = 렌더 경로 결함"은 틀렸다 — 찍은 두 장면(웨이브 1·5)이 졸개만 나오는 웨이브였다(설계값). 실제 결함은 윤곽선 1.3px로 거의 안 보인 것뿐. 스크린샷으로 결함을 판정할 때는 그 장면의 적 구성(웨이브 미리보기·데이터)부터 확인

## 2026-10-22 — O1 수신 · 백엔드 사본 동기화(B1-f) · 실측
- 프론트 O1(미커밋→승인): combat·game·spawn·status 최적화, ENGINE_VERSION 3 유지, 매니페스트 `e5564b03…`(골든 해시 불변) · 결과 동일: 골든 52 · 무작위 봇 1500판 · 시뮬레이터 봇 840판(캠페인 8×3·무한·주간 3주, 최장 77,459틱) 차이 0 · plain Node (b) 2031→1690ms(−16.8%), E2 2236→1896ms · 리뷰: review-front 0 + (정정 후 추가) Opus must-fix 0
- 백엔드 실측(백엔드 tsc ES2020 컴파일 하네스 `scratchpad/be-perf/`, 부하 3~6): (b) **1.76~1.90초** · E2 **2.06~2.18초** · 실제 최장 판(60,145틱) 115~119ms · 162,000틱 외삽 **311~321ms** — O1 판정(백엔드 ≤ 2.5초) 충족, 배포 전 차단 해제. 실제 워커(dist) 무한·주간 골든 5판 일치 2~186ms(첫 판 기동 포함)
- 측정 함정: `tsx`로 바로 실행하면 약 2.7배 부풀어 (b) 4.8초로 보임 — 계약 판정은 컴파일 JS(서버와 같은 경로) 기준
- 단위 1446 · E2E 230·56 skip · 리뷰: review-flow 확정 0(재실측 수치 범위 확장 권고 반영) · Opus 확정 0 — 최적화 전·후 사본 1000판(약 210만 틱) 매 틱 명령 반환·이벤트·상태 해시 비교 불일치 0, 판 도중 예외 주입 후 같은 프로세스에서 골든 52 재현 일치(워커 연속 검증 오염 없음). Opus 시간 수치(700ms대)는 tsx 실행이라 계약 판정에 쓰지 않음
- 사용자 결정: 배포는 F2·F3·V 후 한 번에(캠페인 선배포 안 함)

## 2026-10-23 — F2 수신 · 메인 실API 검증 → 커밋 승인 · F3 착수
- 프론트 F2(F2a 플레이 일반화·증강 UI·주간 규칙 줄 / F2b 세션·등록·만료 띠·대기 제출 / F2c 랭킹 탭·허브 카드): lint 0·typecheck·test 1176 · 묶음 리뷰(사용자 지시 — 속도): review-front R1 should 7 → R3 0 · Opus R1 should 6 → R3 0
- 메인(백엔드 HEAD e15d6e2 dist 3500 + 프론트 운영 빌드 3000, 운영 DB): `defense-f2.mjs` + 재확인 `defense-f2-rank.mjs` — S4 전 잠김·랭킹 열림 · 무한·주간 세션 201 · 주간 규칙 2개 · 게임 오버 → **등록 201**(scoreId 46 endless-s1 · 47 weekly-2026-w43, 서버 재검증 detail `{wave:1,progress:0,kills:0,livesLeft:0,goldEarned,engineVersion:3}`) · 랭킹 링크 board · 탭·강조 행 · 무한 기간 탭 있음/주간 없음 · ▶ 비활성 사유 2종 · API 진행 중 주간 리플레이 404·무한 200 · 오류 0 (첫 실행 강조 행 2건 FAIL은 데이터 로딩 전 확인 — 스크립트 타이밍, 재확인 4/4)
- 회귀: 테트리스 games-ui 28/29(카드 수 기대값 구식 — 디펜스 카드 추가) · 공유 14/14+4/4 · 디펜스 F1b 15/15 · S1 클리어 20/20
- 사용자 확인 대기: 운영 DB 테스트 기록 46·47 숨김(담당자 SQL 실행) · 점수 표기 "웨이브 n · 진척 p%"로(권장 — F3에 포함)

## 2026-10-23 — F3 수신 · 메인 검증
- 프론트 F3(미커밋, engine 무변경): F3a 점수 표기 "웨이브 n · 진척 p%"(결과·랭킹·허브·대기·공유·메타·OG, 테트리스 불변) · F3b 엔진 버전 표(§E6 구조)·replayRunner(사전 패스·스냅샷·탐색) · F3c 재생기(재생·배속 0.5~4×·웨이브 눈금·명령 목록·슬롯 강조·키보드)·`replays/[scoreId]`·`replays/local/[stageId]` · F3d 공유·OG·▶ 활성 · lint 0·typecheck·test 1196 · 묶음 리뷰 review-front R1 should 9 → R3 0 · Opus R1 should 3 → R3 0
- 메인: build exit 0 · `defense-f3.mjs` 16항목 중 15 PASS + 1건은 스크립트 결함(기록 46의 명령이 모두 CALL_WAVE라 강조 요소가 없는데 속성 읽기가 30초 기본 대기로 기다리는 동안 재생이 끝까지 감 — 실제 이동은 0:06→0:00 확인) — 랭킹 점수 표기·원점수 없음 · 진행 중 주간 ▶ 비활성 · 재생 자동·4×·시간 진행 · 웨이브 눈금 3 · 명령 3 → 탭 시 해당 틱 · 끝까지 탐색 → 정지 · 공유 문구 · 메타(title·og:image·noindex) · OG 200 image/png(600s) · 없는 기록 OG 200 · 47(진행 중 주간) 안내 · 로컬 저장본 없음 안내 · 오류 0
- 캠페인 로컬 다시보기(S1 클리어 직후, 모바일·데스크톱): 재생 3:22 · 명령 16(건설 포함) · 건설 명령 탭 → 슬롯 5 강조 — `defense-f1a.mjs` LOCAL_REPLAY 26/26
- 회귀: 테트리스 games-ui 29/29(카드 3개 기대값 갱신) · 공유 14/14+4/4 · 테트리스 OG 200 · 디펜스 F2 랭킹 4/4 · F1b 15/15
- 후속(프론트 제안·메인 권장): 공유 카드·메타에 보드 표기("무한 시즌 1 · 1위" / "W43 주간 · 1위") — 요약 API에 boardKey·보드 안 순위가 이미 있음

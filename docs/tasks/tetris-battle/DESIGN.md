# 테트리스 멀티(대전) — 설계 초안

> 정본. 결정 근거는 DECISIONS.md, 조사 근거는 WORKLOG.md·`research/01-global-patterns.md`.
> 🟡 표시는 사용자 확인 대기(STATUS 미해결 질문 Q 번호).

## 0. 가능성 판정 — 가능

| 요구 | 판정 | 근거 |
|---|---|---|
| 방 생성·목록·비밀번호 | 가능 (신규) | Socket.IO + Redis 어댑터·Redis 공유 상태 기반 있음(`realtime-ws.md`) |
| 콤보 공격 | 가능 — **판정은 엔진에 이미 있음** | `LockEvent`의 lines·tSpin·B2B·combo (`tetris-engine/game.ts:46-57`). 퍼펙트 클리어 판정만 래퍼에서 추가(판이 빈지 검사) |
| 가비지 받기 | 가능 — **엔진 수정 없이** 대전 래퍼에서 | 블록 고정 후 생성 전 지연 구간(`game.ts:569-578`)에 `state.board`(공개 Uint8Array)를 밀어올림. 엔진·`ENGINE_VERSION`·골든·기존 랭킹 무영향(D-003) |
| 2~4인 | 가능 | 방 room 브로드캐스트. 4인 × 락 이벤트 수준 트래픽은 작다(§8) |
| 비로그인 참가 | 가능 | `/fishing`이 게스트 연결 선례(`fishing-ws.guard.ts:75-79`). 재연결용 방 단위 `playerToken` 필요 |
| 모바일 다인원 | 가능, 공간 빠듯 | 세로 여유 ≈90px → 상단 띠 미니보드, 메인 판 ≈20% 축소(프론트 추정, 실측 필요) |
| 기록 공유 | 가능 | 대전 리플레이 = 플레이어별 입력 + 받은 가비지 이벤트 → 결정적 재생 가능(§10) |
| 채팅 | 가능 | 팀 채팅 이벤트 선례(`team.events.ts:13`). 대기실 텍스트 + 게임 중 이모트 권장(§11) |

## 1. 범위

- **MVP**: 방 생성(이름·인원 2~4·비밀번호 선택) · 방 목록 · 링크/코드 초대 · 방장 시작 · 같은 seed · 공격표+콤보 단계 연출 · 가비지 대기열/상쇄 · 자동 타깃팅 · 모바일 미니보드 · 끊김 처리 · 결과 화면(순위·KO·APM·PPS·보낸/받은 줄) · 재대결 · 대기실 채팅+이모트 · **대전 기록 저장·4분할 리플레이·공유(D-008)** · **연출 강화(D-009)**
- **2차 후보**(순서): 관전 → 타깃 옵션(수동 선택·반격) → B2B 서지 → 비동기 대전(고스트) → 1v1 매칭+레이팅
- **비목표**: 기존 랭킹(`GAME_SCORES`)에 대전 기록 합산, 자동 매칭(동접이 적어 대기열이 비어 있을 확률이 높음 — research §8.3)

## 2. 방(로비)

- 방: `roomId`(짧은 코드 6자, 초대 링크 `/games/tetris/battle/{code}`) · 이름(금칙어 검사 재사용) · 최대 인원 2~4 · 비밀번호 선택 · 방장 · 상태 `WAITING|PLAYING|RESULT`
- 비밀번호: 서버가 `crypto.scrypt` 해시만 Redis에 저장, 목록에는 🔒 표시만. 입장 시 검증, 실패 반복은 소켓 단위 제한
- 목록: `WAITING` 방 우선, 인원·🔒·상태 표시. 진행 중 방은 2차 관전 전까지 "진행 중"으로만
- 방장 이탈 → 다음 입장자에게 이양. 전원 이탈 → 방 삭제
- 빈도 제한: 방 생성 소켓·IP 단위(스로틀 상수 파일에 추가)

## 3. 매치 흐름

```
WAITING ──방장 시작(2명↑, 전원 준비)──▶ COUNTDOWN(서버 startAt, 3초) ──▶ PLAYING
PLAYING ──생존자 1명──▶ RESULT ──재대결──▶ WAITING(같은 방)
```
- 시작 시 서버가 라운드 seed 1개 발급 → 전원 같은 블록 순서(공정성 관행, research §6). 가비지 구멍 난수는 서버가 별도로 정해 이벤트에 담는다
- 카운트다운은 서버 `startAt` 시각을 내려보내 각 클라이언트가 맞춘다(서버 타이머 불필요)

## 4. 공격 규칙 — 콤보가 쌓일수록 강해짐 (사용자 요청 2026-10-22 #1)

| 클리어 | 공격 줄 | | 콤보(연속 삭제 n번째) | 추가 줄 |
|---|---|---|---|---|
| 싱글 | 0 | | 1 | 0 |
| 더블 | 1 | | 2~3 | +1 |
| 트리플 | 2 | | 4~5 | +2 |
| 테트리스 | 4 | | 6~7 | +3 |
| T-스핀 미니 싱글/더블 | 0 / 1 | | 8~10 | +4 |
| T-스핀 싱글/더블/트리플 | 2 / 4 / 6 | | 11+ | +5 |
| B2B(테트리스·T-스핀 연속) | +1 | | | |
| 퍼펙트 클리어 | 10 | | | |

- 가이드라인 공격표·콤보표(research §2.1-2.2) — 가장 널리 쓰이고 설명이 쉽다. 상수 테이블 1곳(백·프 공용 사본)
- **경쟁 심리 장치(MVP)**: 콤보 단계별 연출 — 3·5·8·11콤보에서 텍스트("COMBO ×5")·색·흔들림이 단계적으로 커짐, 상대 미니보드에 "공격 받음" 화살표, KO 시 KO 카운트 +1 배지, 결과 화면 "최대 콤보·최대 한 방" 하이라이트
- **더 센 옵션 — B2B 서지**(D-007로 2차)(TETR.IO 현행): B2B 4연속부터 서지가 쌓였다가 끊길 때 한꺼번에 발사. 중독성은 크나 캐주얼에겐 설명 비용 → 2차 권장

## 5. 가비지

- 받은 공격은 **대기열**에 쌓이고, 내가 공격하면 **대기열을 먼저 상쇄**, 남는 만큼만 상대에게 간다
- **콤보 중엔 들어오지 않음**(combo blocking) · 수신 후 **30프레임(0.5초) 지나야 활성** · **피스당 최대 8줄** · 구멍은 공격 단위로 같은 열, 공격이 바뀌면 열이 바뀜
- 적용 시점: 줄을 지우지 않은 블록이 고정된 직후(엔진 지연 구간, `!state.active`)에 래퍼가 판을 위로 밀고 아래에 가비지 줄을 넣는다. 밀린 블록이 맨 위를 넘으면 탑아웃(게임 오버)
- 결정성: 래퍼는 "받은 가비지 이벤트(id·줄 수·구멍 열) + 적용 프레임"을 리플레이에 기록 → `simulateBattleReplay`가 그대로 재현
- 상수(지연·캡·공격표)는 대전 래퍼 상수 파일 1곳 — 원본 프론트, 백 사본 + 동기화 검사(기존 엔진 사본 방식)

## 6. 공격 대상 (사용자 질문 #4) — ✅ A. 자동 순환 (D-006)

| 방식 | 동작 | 장점 | 단점 |
|---|---|---|---|
| **A. 자동 순환(Even)** — 권장 | 공격할 때마다 생존자에게 돌아가며 1명씩 | 조작 0, 모바일 최적. 한 명 집중 공격(왕따) 방지 | 전략성 낮음 |
| B. 모두에게 | 같은 공격을 생존자 전원에게 | 단순·화끈 | 4인에서 공격 총량 3배 → 판이 빨리 끝남, 콤보 잘하는 1명이 독주 |
| C. 직접 선택 | 상대 미니보드를 탭해 대상 고정 | 전략·복수 심리 | 모바일에서 플레이 중 탭이 부담, 조작 실수 |
| D. 반격(Payback) | 나를 공격한 사람에게 | 복수 심리 | 처음엔 대상이 없음 → 다른 방식과 혼합 필요 |

- 2인전은 방식과 무관하게 상대 1명. 3~4인전의 기본을 A로 두고, 미니보드 탭으로 C 전환은 2차 권장(MVP에서 탭 영역·오조작 검증 부담)
- 대상은 **서버가 결정**한다(클라이언트가 고르지 않음 — 조작 방지, 동시성 처리 단순)

## 7. 모바일 화면 (세로 390×844 기준, 프론트 추정)

```
┌──────────────────────────────┐
│ [P2 ▓▓]  [P3 ▓▓]  [P4 ▓▓]   │ ← 상대 미니보드 띠(판만, 셀 4~5px) + 이름·KO
│   ▲공격 대상 강조 테두리       │   대상 = 테두리 색, 탈락 = 회색 X
├─┬────────────────────┬───────┤
│█│ HOLD │  메인 판     │ NEXT │ ← 메인 판 ≈20% 축소
│█│      │ (10×20)      │      │   왼쪽 세로 게이지: 대기 가비지(회색) / 곧 들어옴(빨강)
│░│      │              │      │
├─┴────────────────────┴───────┤
│  [←][↓][→]        [⟲][⟳]    │ ← 기존 TouchControls 재사용
│                   [HOLD][⤓]  │
└──────────────────────────────┘
```
- 2인전: 상대 보드 1개만 조금 크게(셀 6~7px). 4인전: 3개
- 이모트는 상단 띠 오른쪽 작은 버튼 → 4~6개 프리셋(§11)
- 자동 일시정지 없음(대전은 멈출 수 없음) — 백그라운드 전환 시 그대로 진행, 복귀 시 따라잡기

## 8. 동기화·서버 구조

- **각자 자기 판을 로컬에서 즉시 진행**(입력 지연 0). 서버 권위 시뮬레이션·lockstep은 모바일 네트워크에서 조작감이 나빠 버림(research §5)
- 클라이언트 → 서버: 블록 고정마다 `lock` 이벤트 {frame, 공격 계산 입력(lines·tSpin·B2B·combo·PC), 가시 판 스냅샷 200칸, 적용한 가비지 id 목록}
- **가비지 대기열의 권위는 받는 쪽 클라이언트**(D-013): 상쇄는 로컬 `stepBattle`에서만 하고 `lock`으로 상쇄 후 `sent`만 보낸다. 서버는 `sent`를 대상에게 라우팅만 하고(구멍 열·id 부여) 플레이어별 대기열을 계산하지 않는다 — 서버 상태는 대상 순환 커서·KO·통계·가비지 송신 로그. `sent`의 정당성은 경기 후 재시뮬이 보장. 방 전체에 상대 스냅샷 중계. **방 상태 변경은 Redis Lua로 원자 처리**(여러 레플리카가 같은 방 이벤트를 받음 — 인메모리 금지)
- 트래픽: 블록 고정 초당 1~3회 × 4인 × 스냅샷 ≈200B → 방당 수 KB/s 미만
- 조작 방지: 실시간엔 클라이언트 보고를 믿되, **경기 종료 후 각 플레이어 리플레이(입력 + 받은 가비지)를 서버가 재시뮬레이션**해 보고한 공격·탈락 프레임과 대조. 불일치면 그 경기 결과를 무효(기록·공유 제외). 검증 워커 풀은 디펜스 브랜치 머지 후 재사용 검토
- 끊김: 재연결 10초 유예(`playerToken`으로 복귀) → 초과 시 탈락 처리. 유예 판정은 이벤트 수신 시 지연 판정 + 짧은 주기 정리(단일 실행은 `TASK_SLOT` 가드)
- 소켓: 신규 namespace(가칭 `/tetris-battle`), 비로그인 허용(fishing 패턴), 핸들러마다 방 멤버 검증(playbook 클러스터 1)

## 9. 데이터

- **Redis**(방·매치 진행 상태, TTL): 방 메타·멤버·비밀번호 해시·라운드 seed·플레이어별 대기열·가비지 이벤트 로그·채팅 최근 N개. 방당 수~수십 KB, 경기 중 입력 로그 포함 ≈100KB 상한 추정
- **Oracle**(1차, D-008): `BATTLE_MATCHES`(경기)·`BATTLE_PLAYERS`(참가자·순위·통계)·`BATTLE_REPLAYS`(gzip, 기존 `GAME_REPLAYS` 방식) — 신규 마이그레이션, 번호 `1792591422000` 이후(D-003)

## 10. 기록 공유 (사용자 질문 #2) — ✅ 1차 포함 (D-008)

- 가능. 대전 리플레이는 "seed + 플레이어별 입력 + 받은 가비지 이벤트"라 N명 판을 동시에 재생할 수 있다(기존 단일 재생기 구조 확장)
- 공유 단위: 경기 결과 카드(순위·닉네임·KO·최대 콤보) + 링크 → 4분할 재생. 기존 카톡 공유·OG 카드 구조 재사용(디펜스 공용화 `_shared` 머지 후가 깔끔)
- 비용: DB 테이블 3개 + 마이그레이션 + 다판 재생기. 저장 전제는 경기 후 재시뮬 검증 통과(P5) — 무효 경기는 저장·공유 제외. 공유 UI는 디펜스 `_shared` 머지 여부를 그 슬라이스 착수 때 확인
- 레이팅(Glicko-2 등)은 1v1 자동 매칭 도입 시에만(research §7.2)

## 11. 채팅 (사용자 질문 #3)

- 가능. **대기실·결과 화면: 텍스트 채팅**(최근 50개, Redis, 방 삭제 시 함께 삭제, 비저장) · **게임 중: 이모트 4~6개 프리셋**(모바일에서 타이핑 불가 + 욕설 위험 낮음)
- 금칙어 검사는 이름 금칙어 정책 재사용, 소켓 단위 빈도 제한, 비로그인도 허용(D-011)

## 12. Redis 용량 (사용자 질문 #4) — ✅ 512MB (D-012)

- 현재 `--maxmemory 128mb` + `allkeys-lru`(`infra/docker-stack.yml:57-60`) — **꽉 차면 TTL 없는 키까지 오래된 것부터 지운다**. 대전 중인 방 키가 지워지면 경기가 깨진다
- 대전 증가분 추정: 동시 방 50개 × 100KB ≈ 5MB — 128MB 안에서 충분할 가능성이 높다(추정)
- 권장: 먼저 실사용량을 본다 — Grafana redis_exporter `redis_memory_used_bytes`·`redis_evicted_keys_total`. 사용량이 50%를 넘거나 evicted가 0이 아니면 256MB로 올린다(노드 12GB라 여유). yml 수정 + `infra` 스택 재배포 필요 → 배포 작업이라 사용자 승인 사항, 재시작 시 소켓 순간 끊김

## 13. 위험

- 클라이언트 보고 신뢰 구간의 조작 → 경기 후 재시뮬 검증으로 결과만 무효(실시간 판 자체는 막지 못함)
- 모바일 네트워크 지연 → 가비지 0.5초 지연이 버퍼, 스냅샷은 표시용이라 늦어도 판정 무영향
- 디펜스 공용화와 프론트 파일 7개 충돌(WORKLOG 프론트 조사 절) → 대전은 새 경로, 공용 파일 수정은 디펜스 머지 후
- Redis LRU 퇴출 → §12

## 14. 화면 연출 강화 — 싱글·대전 공통 (사용자 요청 2026-10-22) — ✅ 권장안 (D-009)

- 가능. 렌더러는 엔진 상태를 읽기만 해서(`renderer.ts:80` drawGame) **연출을 바꿔도 엔진·리플레이·랭킹·서버 무영향**. 디펜스 공용화도 `renderer.ts`·`TetrisCanvas`를 건드리지 않음(WORKLOG 프론트 조사 절)
- **권장: Canvas 2D "입체감" + 파티클** (새 의존성 없음)
  - 블록: 베벨(밝은 윗면·어두운 아랫면)·그라데이션·하이라이트 → 입체 블록 느낌. 고스트는 반투명 외곽선
  - 줄 삭제: 줄이 빛나며 하얗게 번쩍 → 블록 조각 파티클이 튀어 흩어짐(테트리스·T-스핀은 더 크게)
  - 하드 드롭: 낙하 잔상 + 착지 시 작은 화면 흔들림 · 콤보 단계 텍스트(§4)·B2B 불꽃 · 레벨업 배경 색 전환
  - 대전 전용: 공격이 날아가는 궤적(내 판 → 대상 미니보드), 가비지 들어올 때 판 아래 붉은 진동
  - 진짜 3D(WebGL·three.js 등)는 새 의존성 + 모바일 발열·배터리 부담 + 렌더러 전면 재작성이라 비권장(원하면 2차 검토)
- 안전장치: 설정에 "연출 줄이기"(OS `prefers-reduced-motion` 기본 반영) · 저사양에서 파티클 개수 상한 · 재생기(리플레이)에도 같은 연출
- 슬라이스: 대전과 독립이라 **먼저 싱글 테트리스에 적용(P-V1)** → 대전이 그대로 물려받음. 단, `TetrisPlay.tsx` 수정이 필요하면 디펜스 머지 후로(충돌 높음 파일)

## 15. 대전 래퍼 계약 (P0 원본 프론트 · P0b 백 사본) — D-004

- 위치: 프 `src/app/games/tetris/battle-engine/` (원본) · 백 `src/modules/tetris-battle/battle-engine/` (사본, 직접 수정 금지, 동기화 검사). 엔진(`engine/`·`tetris-engine/`)은 import만 한다
- 상수(`battle-engine/constants.ts`): `BATTLE_ENGINE_VERSION = 1` · 공격표·콤보표(§4) · `GARBAGE_DELAY_FRAMES = 30` · `GARBAGE_CAP_PER_PIECE = 8` · `GARBAGE_CELL = 8`(회색, 피스 값 1~7과 구분) · `MAX_PLAYERS = 4` · `MAX_BATTLE_FRAMES`(엔진 `MAX_FRAMES` 재사용) · `MAX_GARBAGE_EVENTS`(상한)
- 순수 함수:
  - `computeAttack(lock: LockEvent, perfectClear: boolean): number` — §4 표. 싱글 0, B2B +1, PC +10. 콤보 표의 n = `lock.combo + 1` → `lock.combo` 0→0, 1~2→+1, 3~4→+2, 5~6→+3, 7~9→+4, 10+→+5. 연출 "COMBO ×k"의 k = `lock.combo`(D-013)
  - 고정은 `stepFrame`당 최대 1회(고정 후 active=false라 같은 프레임 추가 동작은 pending) → `game.pieces` 증가로 감지. 가비지 활성 판정 `activeAt ≤ lastLock.frame`, 탑아웃 시 `endFrame = game.frame`
  - `isPerfectClear(board, rows)` — 고정 직후(줄 제거 전) 비어 있지 않은 칸이 전부 `rows`에 속하면 true
  - `createBattle({ seed, das, arr })` → `BattleState { game, queue: PendingGarbage[], received: GarbageEvent[], sentLog }`
  - `receiveGarbage(bs, ev: { id, lines, hole })` — **수신 즉시 호출**, `ev.frame = bs.game.frame`(도착 프레임) 기록, `activeAt = frame + GARBAGE_DELAY_FRAMES`로 대기열 뒤에 추가
  - `stepBattle(bs, actions, count)` → `{ applied, lock?: { attack, sent, pc } }` — 내부에서 `stepFrame` 호출 후 `game.pieces` 증가로 고정 감지:
    1. `attack = computeAttack(lastLock, pc)` → 대기열 앞에서부터 상쇄 → 남은 값이 `sent`(서버로 보낼 공격)
    2. `lastLock.lines === 0`이면(콤보 중 차단) `activeAt ≤ frame`인 대기열 항목을 앞에서부터 피스당 최대 8줄까지 판에 넣는다: 판을 n줄 위로 밀고(맨 위 n줄에 블록이 있으면 탑아웃 → `game.over = true`, `active = false`, `endFrame = frame`) 아래 n줄을 `GARBAGE_CELL`로 채우고 `hole` 열만 0. 항목을 일부만 넣으면 남은 줄은 대기열에 남는다
  - `simulateBattleReplay(replay)` → `{ ok, frames, sent[], topOutFrame, boardHash } | { ok:false, reason }` — 서버 검증·재생기 공용
- 대전 리플레이 형식: `{ battleEngineVersion, seed, das, arr, frames, inputs(기존 형식), garbage: [deltaFrame, id, lines, hole, ...] }` — 도착 프레임 순, 결정적 재현
- 검증: **공격표 전 케이스·PC는 단위 테스트**(`battle.test.ts`), **골든 19케이스는 대표 경로**(attack 6 · 상쇄 · 콤보 차단 · 캡 분할 · 지연 · 가비지 블록 아웃 · 가비지 탑아웃 · 생존 · 거절 6) — 프론트 생성, 백 사본이 같은 결과(D-016)
- KO 판정은 `game.over`로(가비지 탈락은 대개 엔진 블록 아웃 `toppedOut=false`, 래퍼 탑아웃은 숨은 줄까지 쌓인 경우만)
- 서버 보장(P2·P5): `garbage` 이벤트 lines 1~22·이벤트 합치지 않음 · 생존자 리플레이 frames는 클라이언트가 `matchEnded` 수신 시 멈춘 프레임 — 서버는 `경과 시간 × 60 + 여유` 이하·마지막 lock frame 이상으로 대조

## 16. 소켓 프로토콜 (namespace `/tetris-battle`) — 확정 v1 (D-013, `next-bun-bd` 검토 반영)

- 연결: `handshake.auth.token` 있으면 로그인(userId), 없으면 게스트. 핸들러는 ack 응답 `{ ok: true, data } | { ok: false, code, message }`
- 식별: 방 입장 시 서버가 `playerId`(방 내 고유)·`playerToken`(재연결용, 방 수명) 발급
- 판 인코딩(백·프 공용 상수): 가시 20행(판 좌표 20~39, 위→아래) × 10열, 칸당 1바이트(0 빈칸·1~7 블록·8 가비지) = 200바이트 → base64
- 로비: `listRooms`가 로비 구독을 겸한다. `createRoom`·`joinRoom` 성공 시 서버가 로비 room에서 자동으로 뺀다. 방을 나가면 다시 `listRooms`로 구독
- 재연결: `joinRoom{ code, playerToken, lastGarbageId }` → ack에 `rejoin: { match: { matchId, seed, status, alive }, missedGarbage[], opponents[{ playerId, board, pending, alive }] }`(D-017). 가비지는 플레이어 채널로 보내고 재연결 시 채널 입장 후 놓친 가비지를 읽으므로 같은 id가 두 번 올 수 있다 — 클라이언트는 id ≤ 직전 수락 id를 버린다(D-018). 소켓만 끊겼다 붙은 경우만 복귀 — **경기 중 새로고침은 로컬 판이 사라져 복귀 불가 → 유예(10초) 후 KO**
- 경기 중 `leaveRoom` = 기권(즉시 KO, reason `leave`)

### 클라이언트 → 서버
| 이벤트 | 페이로드 | ack data |
|---|---|---|
| `listRooms` | `{}` | `{ rooms: RoomSummary[] }` |
| `createRoom` | `{ name, maxPlayers: 2~4, password?, playerName }` | `{ room: RoomState, playerId, playerToken }` |
| `joinRoom` | `{ code, password?, playerName, playerToken?, lastGarbageId? }` | `{ room, playerId, playerToken, rejoin? }` |
| `leaveRoom` | `{ code }` | `{}` |
| `setReady` | `{ code, ready }` | `{}` |
| `startMatch` | `{ code }` (방장) | `{}` |
| `rematch` | `{ code }` (방장, RESULT에서) | `{}` → WAITING, 전원 ready=false |
| `lock` | `{ matchId, seq(=game.pieces), frame, sent, combo, b2b, tSpin, lines, pc, board, pending }` | `{ targetId }`(다음 대상) |
| `topOut` | `{ matchId, frame }` | `{}` |
| `chat` | `{ code, text }` (WAITING·RESULT, 경기 중에는 탈락자만 — tetris-audit D-016) | `{}` |
| `emote` | `{ code, emoteId }` | `{}` |

- `lock` 검증: `seq` 중복은 무시(재전송), `seq`·`frame` 단조 증가 아니면 거부

### 서버 → 클라이언트
| 이벤트 | 대상 | 페이로드 |
|---|---|---|
| `roomsChanged` | 로비 | `{ rooms: RoomSummary[] }` |
| `roomState` | 방 | `RoomState { code, name, maxPlayers, locked, hostId, status: 'WAITING'\|'PLAYING'\|'RESULT', players[{ playerId, name, ready, connected, isGuest }] }` |
| `matchStarting` | 방 | `{ matchId, seed, startInMs, startAt(ISO, 참고), players[] }` — 클라이언트는 수신 시각 + `startInMs`로 카운트다운 |
| `garbage` | 대상 1명 | `{ matchId, id(받는 플레이어 기준 단조 증가 정수), lines, hole, from }` — ack 없음, 유실은 재연결 `lastGarbageId`로 |
| `attack` | 방 | `{ matchId, from, to, lines }` — 궤적·대상 표시 |
| `opponentUpdate` | 방(본인 제외) | `{ matchId, playerId, board, pending, combo, b2b }` |
| `playerKO` | 방 | `{ matchId, playerId, by, place, reason: 'topout'\|'disconnect'\|'leave' }` |
| `matchEnded` | 방 | `{ matchId, results[{ playerId, name, place, kos, sent, received, pieces, maxCombo, frames }] }` → 방 상태 RESULT |
| `chatMessage` | 방 | `{ playerId, name, text, at }` |
| `emoteReceived` | 방 | `{ playerId, emoteId, at }` |

- `RoomSummary = { code, name, playerCount, maxPlayers, locked, status }`
- ack 에러 `code`: `ROOM_NOT_FOUND` · `ROOM_FULL` · `ROOM_WRONG_PASSWORD` · `ROOM_PASSWORD_LOCKED`(반복 실패) · `NOT_HOST` · `NOT_IN_ROOM` · `MATCH_ALREADY_STARTED` · `MATCH_NOT_FOUND` · `NOT_ENOUGH_PLAYERS` · `NOT_ALL_READY` · `NAME_INVALID` · `NAME_FORBIDDEN` · `RATE_LIMITED` · `INVALID_PLAYER_TOKEN` · `INVALID_PAYLOAD` · `ROOM_NAME_INVALID` · `ROOM_NAME_FORBIDDEN` · `CHAT_FORBIDDEN` · `ROOM_BUSY`(동시 변경 재시도 초과) · `SERVICE_UNAVAILABLE`(Redis 미연결) · `INTERNAL_ERROR` (D-014) · `PLAYER_NOT_ALIVE`(탈락 후 lock, D-017)
- 이모트 id: `gg`·`nice`·`wow`·`laugh`·`cry`·`angry` · 채팅 이력 없음(입장 후 메시지만) · 방 TTL 2시간(변경마다 갱신) · 계약 정본 파일 `src/modules/tetris-battle/tetris-battle.events.ts`
- 대전 리플레이 제출(P5)은 REST(본문 크기·재시도 단순) — 별도 절에서 확정

### 16-a. 프로토콜 추가 (2026-10-23, `docs/tasks/tetris-audit-2026-10/` D-007·D-010~D-012)
- 요청 필드: `createRoom`·`joinRoom`에 `tabId?`(탭 메모리 식별자, `[A-Za-z0-9-]{1,64}`) · `heartbeat?: boolean`(presencePing에 답하는 클라이언트)
- 넘겨받기: `joinRoom`은 토큰 → 같은 소켓 → **같은 로그인 userId** 순으로 기존 자리를 찾는다. 방이 PLAYING이고 그 자리가 연결된 다른 소켓을 갖고 있으면 같은 `tabId`일 때만 넘겨받고, 아니면 `SEAT_IN_USE`
- 클라이언트 → 서버: `kickPlayer { code, playerId }`(방장·WAITING/RESULT → `{}`) · `heartbeat { code }`(ack 없음)
- 서버 → 클라이언트: `sessionReplaced { code }`(넘겨받힌 이전 소켓) · `kicked { code }`(강퇴된 소켓) · `presencePing`(4초, 페이로드 없음)
- 에러 코드 추가: `SEAT_IN_USE` · `PLAYER_NOT_FOUND`
- `chat`: 경기 중에도 탈락한 참가자는 보낼 수 있다(생존자는 `MATCH_ALREADY_STARTED`, D-016)

## 17. 경기 후 검증·결과 저장 (P5) — D-021

### 17-1. 흐름
1. `matchEnded` 수신 후 각 플레이어(로컬 판이 있는 사람만, D-020)가 `POST /api/v1/tetris-battle/matches/:matchId/replays` 본문 `{ playerToken, replay }`(대전 리플레이 형식 §15) 제출. 인증은 방 입장 때 받은 `playerToken`(매치 시작 시 플레이어별 토큰 해시를 매치 Hash에 복사 — rematch·이탈 뒤에도 그 경기 기준으로 검증). 로그인 토큰은 선택(있으면 USER_ID 기록)
2. 서버 검증(`simulateBattleReplay`): seed = 매치 seed · 리플레이 garbage 목록(id·lines·hole, 순서)이 서버 수신자별 가비지 로그와 일치(도착 frame은 클라이언트 값) · 시뮬 결과 `sent[]`가 서버가 받은 그 플레이어의 lock별 sent 기록과 일치(서버는 lock마다 `(seq, sent)` 로그를 남긴다) · 탈락자는 topOutFrame이 서버 기록 탈락 frame과 일치, 생존자는 frames ≤ 경과 시간×60+여유 · 엔진 거절 이유는 그대로 실패
3. 판정: 제출자별 `VERIFIED` / `INVALID`, 미제출은 `MISSING`(새로고침 기권·끊김). 경기 상태 = 전원 VERIFIED 또는 MISSING뿐이면 `VERIFIED`, INVALID가 하나라도 있으면 `DISPUTED`(~~공유·재생 목록 제외~~ → 2026-10-23부터 공개, INVALID 참가자만 재생 제외 — tetris-audit D-004·D-008)
4. 저장 시점: 모든 예상 제출자가 제출했거나, 종료 후 마감(60초)이 지난 뒤 첫 제출·조회 때. 한 번만 저장(Redis `SET NX` 가드 — 멀티 레플리카)
5. 응답: `201 { code, data: { verdict }, message }` · 재제출 409 · 마감 후 410 · 토큰 불일치 403 · 본문 크기 초과 413(기존 300kb) · 검증 실패도 201 + verdict INVALID(재시도 무의미) · 같은 참가자의 제출을 검증하는 중에 겹친 요청 503(잠시 후 재시도, tetris-audit 리뷰 R1)

### 17-2. 스키마 (Oracle, 신규 마이그레이션 — 번호 `1792591422000` 이후, D-003)
- `TETRIS_BATTLE_MATCHES`: `MATCH_ID varchar2(16) PK` · `ROOM_NAME nvarchar2(20)` · `SEED number` · `PLAYER_COUNT number(1)` · `STATUS varchar2(10) CHECK IN ('VERIFIED','DISPUTED')` · `STARTED_AT`·`ENDED_AT timestamp with time zone` · `CRTD_AT` · `IS_HIDDEN number(1) default 0`(운영자 숨김, 기존 GAME_SCORES와 같은 방식)
- `TETRIS_BATTLE_PLAYERS`: PK `(MATCH_ID, PLAYER_ID)` · FK → MATCHES · `NAME nvarchar2(12)` · `USER_ID number null` · `PLACE`·`KOS`·`SENT`·`RECEIVED`·`PIECES`·`MAX_COMBO`·`FRAMES number` · `KO_REASON varchar2(10) null` · `VERDICT varchar2(10) CHECK IN ('VERIFIED','INVALID','MISSING')`
- `TETRIS_BATTLE_REPLAYS`: PK `(MATCH_ID, PLAYER_ID)` · FK → PLAYERS · `BATTLE_ENGINE_VERSION number` · `REPLAY blob`(gzip JSON — 기존 GAME_REPLAYS 방식) · `CRTD_AT`
- 인덱스: MATCHES `(CRTD_AT)` — 최근 경기 목록용(P6). 플레이어 → 경기 조회는 P6에서 필요 시
- 실행은 담당자(머지 전 차단 게이트)

### 17-3. 조회(P6 전제, P5에서 API만)
- `GET /api/v1/tetris-battle/matches/:matchId` → 경기·플레이어 요약(숨김은 404 · DISPUTED는 2026-10-23부터 200 + `disputed: true`, tetris-audit D-004)
- `GET /api/v1/tetris-battle/matches/:matchId/replays/:playerId` → 리플레이(VERIFIED만)


## 18. 대전 기록 재생·공유 (P6) — D-024

- 전제: 디펜스 공용화(`_shared` — ShareMenu·replayLoader·kakao·ogFont·replayCard 등)가 main에 머지됨(bun #279·#280, next-bun #361·#362). 백엔드 조회 API(§17-3)는 1차 배포에 포함
- 페이지 `/games/tetris/battle/matches/{matchId}`(비로그인 접근, 전체화면 경로):
  - 상단: 방 이름·일시·결과표(순위·이름·KO·보낸/받은 줄·최대 콤보)
  - 재생: 참가자 2~4판 동시 재생(모바일 세로 2×2, 2인은 좌우), 공통 프레임 축으로 동기(각 리플레이의 frame 0 = 각자 카운트다운 종료 — 같은 시작 시각 기준이라 근사 동기), 배속(0.5·1·2·4×)·탐색·처음부터. 판마다 가비지 도착·KO 표시. 리플레이가 없는 참가자(MISSING)는 "기록 없음" 판
  - 재생은 `simulateBattleReplay`가 아니라 래퍼 `createBattle`+`stepBattle`+기록된 garbage를 프레임마다 주입(스냅샷 탐색은 기존 재생기 방식 재사용)
  - 공유: `_shared` ShareMenu(카톡·링크 복사·기본 공유 시트) + OG 카드(방 이름·우승자·인원·KO) — 기존 리플레이 공유와 같은 구조
  - 숨김·미저장 경기는 404 안내(DISPUTED는 2026-10-23부터 공개 — tetris-audit D-004)("공개되지 않은 경기예요")
- 진입점: 대전 결과 화면의 "기록 보기·공유" 버튼(제출 결과가 저장됨일 때 활성 — 저장 전이면 "저장 중" 대기 후 GET 200이면 활성)
- 백엔드: 변경 없음 예상(GET 경기·리플레이로 충분). OG 카드에 필요한 필드가 부족하면 그때 추가
- 비목표: 내 대전 목록·전적, 대전 랭킹

## 19. 대전 입구·최근 대전 목록 (P7) — D-025

- 문제(사용자 2026-10-22): 대전 입구가 `/games/tetris`의 보조 버튼 하나뿐, 게임 목록·지난 기록 입구 없음
- 프론트
  - `/games` 테트리스 카드에 "친구와 대전" 버튼 + NEW 배지(디펜스 브랜치가 같은 목록에 카드를 추가하므로 최소 줄)
  - `/games/tetris` 홈: "게임 시작"과 "친구와 대전"을 나란한 주요 버튼으로, 대전 버튼에 "지금 열린 방 N개"(0이면 "방 만들기") — 소켓 없이 REST로
  - "최근 대전" 섹션(최근 5경기: 방 이름·인원·우승자·시각 → 기록 페이지) + 전체 목록 페이지 `/games/tetris/battle/matches`(더 보기 페이지네이션)
- 백엔드(신규 REST, 인증 없음, 조회 스로틀 `THROTTLE_BATTLE_RESULT_READ`)
  - `GET /api/v1/tetris-battle/lobby` → `{ waitingRooms, playingRooms }` — Redis 로비 ZSET·방 상태로 계산(로비 `listRooms`와 같은 정리 규칙), 짧은 캐시 가능
  - `GET /api/v1/tetris-battle/matches?limit=&cursor=` → 최근 VERIFIED·비숨김 경기 요약 `{ items: [{ matchId, roomName, playerCount, endedAt, winnerName, players: [{ name, place }] }], nextCursor }` — `CRTD_AT DESC, MATCH_ID DESC` 커서(기존 인덱스 `IDX_TB_MATCHES_CRTD`), limit 1~20(기본 10). 스키마 변경 없음

## 20. 연출 2차(네온·글로우) + 사운드 (P8) — D-026

- 범위: 싱글·대전·재생기 공통(렌더러·이펙트 레이어). 엔진·리플레이·서버 무영향 원칙 유지(순도 테스트)
- 시각(네온·글로우): 블록 발광·외곽 글로우, 고스트 네온 외곽선, 줄 삭제 섬광 + 충격파 링, 테트리스·T-스핀·B2B·퍼펙트 클리어 배너(글로우·스케일 인), 콤보 미터, 레벨업 버스트, 배경 별·입자 흐름(레벨에 따라 색조), 하드 드롭 빛줄기, 대전: 공격 궤적 글로우·가비지 상승 연출·KO 폭발·카운트다운 연출
- 사운드: Web Audio 합성(파일·라이선스 없음) — 이동·회전·하드 드롭·고정·홀드·줄 삭제(1~4줄 음 다르게)·T-스핀·콤보(단계마다 음 상승)·B2B·레벨업·게임 오버, 대전: 공격 송신·가비지 수신 경고·KO·승리. 배경음악은 단순 루프(별도 토글)
- 토글: **기본 꺼짐**. 테트리스 홈 설정(효과음·배경음악·볼륨) + 게임·대전 화면 상단 스피커 버튼(빠른 켜기/끄기). localStorage 저장, 오디오는 사용자 첫 조작 후에만 시작(iOS 자동재생 정책)
- 성능·접근성: 기존 "연출 줄이기"(prefers-reduced-motion) 존중 — 줄이면 글로우·입자 축소, 파티클·글로우 상한, 저사양 감지 시 자동 축소. 실기기 fps 확인은 사용자

## P. 구현 슬라이스 (기획 확정 후)

| # | 레포 | 내용 | 검증 |
|---|---|---|---|
| P-V1 | 프 | 연출 강화(§14) — 렌더러 입체 블록·파티클·흔들림·연출 줄이기 | test·Playwright 스크린샷·실기기 fps |
| P0 | 프 | 대전 래퍼(가비지 적용·PC 판정·공격 계산·`simulateBattleReplay`) + 골든 픽스처 | 단위·골든 |
| P0b | 백 | 래퍼 사본 + 동기화 검사 + 골든 | 골든 동일 결과 |
| P1 | 백 | `/tetris-battle` namespace: 방 생성·목록·입장(비번)·이탈·방장 이양 + Redis 상태 | 단위·WS E2E |
| P2 | 백 | 매치: 시작·seed·lock 처리(Lua)·가비지 분배·탈락·결과·끊김 유예 | 단위·WS E2E(멀티 클라이언트) |
| P3 | 프 | 로비·대기실·대전 화면·미니보드·게이지·연출 | test·Playwright 2탭 대전 |
| P4 | 백·프 | 채팅·이모트 | E2E |
| P5 | 백 | 경기 후 재시뮬 검증·무효 처리 + 결과 저장(신규 테이블·마이그레이션) | 조작 리플레이 거부 테스트 · 마이그레이션 tsc |
| P6 | 백·프 | 대전 기록 조회 API · 4분할 재생기 · 카톡·링크 공유(OG 카드) — **디펜스 머지 후 착수(D-010)** | API·Playwright·재생 결과=기록 |
| V | — | 리뷰 루프 · 실기기 2~4대 대전 | |

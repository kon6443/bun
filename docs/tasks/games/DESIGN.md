# 게임 모음집 · 테트리스 · 랭킹 — 설계 정본

> 스키마·REST·리플레이·엔진 규칙의 정본. 결정 근거는 DECISIONS.md(D-번호). 🟡 항목은 STATUS "미해결 질문"과 연결된다. 결정이 바뀌면 이 문서를 먼저 고친다.

## 1. 스키마 — `GAME_SCORES` (D-006)

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `SCORE_ID` | `NUMBER` IDENTITY | PK | Entity `@PrimaryGeneratedColumn` |
| `GAME_TYPE` | `VARCHAR2(20 BYTE)` | NOT NULL, CHECK IN (`'TETRIS'`) | 새 게임은 CHECK 교체 마이그레이션 |
| `SCORE` | `NUMBER(12)` | NOT NULL, CHECK ≥ 0 | 서버가 리플레이로 계산한 값 |
| `PLAYER_NAME` | `VARCHAR2(48 BYTE)` | NOT NULL | 1~12자(§3) — 바이트 상한도 검사 |
| `USER_ID` | `NUMBER` | NULL, FK → `USERS` ON DELETE SET NULL | 로그인 등록이면 기록 |
| `DURATION_MS` | `NUMBER(10)` | NOT NULL | 리플레이 프레임 수 × 1000 / 60 |
| `DETAIL` | `CLOB` | NOT NULL, CHECK `IS JSON` | 게임별 값 — 테트리스: `{ lines, level, pieces, tSpins, maxCombo, tetrises, engineVersion, das, arr }` |
| `IP_HASH` | `VARCHAR2(64 BYTE)` | NULL | 비로그인 스팸 묶음 판별용 HMAC-SHA256(원문 IP 미저장, env `GAME_IP_HASH_SECRET` 없으면 NULL) (Q5) |
| `IS_HIDDEN` | `NUMBER(1)` | NOT NULL, DEFAULT 0 | 운영자 숨김(SQL) — 조회에서 제외 |
| `CRTD_AT` | `TIMESTAMP(6) WITH TIME ZONE` | NOT NULL, DEFAULT `CURRENT_TIMESTAMP` | UTC |

- 인덱스: `(GAME_TYPE, SCORE DESC, CRTD_AT)` 전체 랭킹 · `(GAME_TYPE, CRTD_AT)` 일간·주간 랭킹·통계
- Oracle **19c**(실측) — JSON 타입 없음 → `CLOB` + `IS JSON`, 통계는 `JSON_VALUE`
- 리플레이 입력 기록은 별도 테이블 `GAME_REPLAYS`에 보관한다(Q6, D-010)

### 1-2. `GAME_REPLAYS` (D-010)
| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `SCORE_ID` | `NUMBER` | PK, FK → `GAME_SCORES` ON DELETE CASCADE | 기록 1개당 리플레이 1개 |
| `GAME_TYPE` | `VARCHAR2(20 BYTE)` | NOT NULL, CHECK IN (`'TETRIS'`) | 게임별 리플레이 관리·통계를 조인 없이 (D-012) |
| `ENGINE_VERSION` | `NUMBER(5)` | NOT NULL | 재검증 시 같은 버전 엔진 필요 |
| `SEED` | `NUMBER(10)` | NOT NULL | 0 ~ 2³²−1 |
| `REPLAY` | `BLOB` | NOT NULL | 헤더(das·arr·frames) + 입력 배열을 gzip한 JSON |
| `CRTD_AT` | `TIMESTAMP(6) WITH TIME ZONE` | NOT NULL, DEFAULT `CURRENT_TIMESTAMP` | |
- 정합성(D-012): `GAME_SCORES`에 `UNIQUE (SCORE_ID, GAME_TYPE)`를 두고 `GAME_REPLAYS (SCORE_ID, GAME_TYPE)` 복합 FK가 이를 참조한다 — 리플레이의 게임 종류가 점수 기록과 다르면 DB가 거부
- 랭킹 조회에서 읽지 않는다(별도 테이블이라 순위 쿼리에 영향 없음). 저장은 점수 기록과 같은 트랜잭션(`dataSource.transaction`)
- 용량 추정은 WORKLOG 2026-10-21 리플레이 용량 절 — 보관 기간·정리 정책은 실측 후 재검토

## 2. 게임 세션 (Redis — 멀티 레플리카 공유, 인메모리 금지)

- 키 `game:session:{sessionId}` → `{ gameType, seed, engineVersion, startedAt(ms), userId|null }`, TTL 2시간
- Redis 클라이언트는 기존 관례대로 `main.ts`에서 `setRedisClient(redisAdapter.getPubClient())`로 주입(`OnlineUserService`·`FishingOnlineService`와 같은 방식)
- 제출 시 **1회만** 사용 — 2026-10-21부터 검증 결과가 확정된 뒤 `GETDEL`(검증기 오류는 503 `GAME_VERIFY_BUSY` + 세션 유지). 정본은 `docs/tasks/defense/DESIGN.md` §B4. Redis 장애로 세션을 못 만들면 플레이는 그대로 되고 랭킹 등록만 불가(프론트 안내)
- `seed`: 서버가 `crypto.randomInt(0, 2**32)`로 발급 — 클라이언트가 seed 값을 정할 수는 없다. 단 seed는 발급 즉시 응답에 실리고 쓰지 않은 세션은 버릴 수 있어(분당 20개), 유리한 seed를 골라 오프라인으로 입력을 만든 뒤 실시간 검사만 기다려 제출하는 봇은 막지 못한다 — D-005에서 수용한 위험(D-015)
- **Redis 퇴출 위험**: 운영 Redis는 `maxmemory 128mb` + `allkeys-lru` — 메모리가 차면 진행 중 세션이 지워질 수 있고, 그 판의 제출은 409가 된다. 세션 키는 약 150B·TTL 2시간이라 수용(D-015). `redis_memory_used_bytes`가 상한에 가까워지면 재검토

## 3. REST (응답 `{ code, data, message }`, 경로 `:gameType`은 소문자 `tetris` → 코드값 `TETRIS`)

| 메서드·경로 | 인증 | 용도 | 성공 | 주요 에러 |
|---|---|---|---|---|
| `POST /games/:gameType/sessions` | 선택(`OptionalJwtAuthGuard`) | 세션·seed 발급 | 201 `{ sessionId, seed, engineVersion, expiresAt }` | 404 `GAME_NOT_FOUND` · 429 · 503 `GAME_SESSION_UNAVAILABLE`(Redis) |
| `POST /games/:gameType/scores` | 선택 | 리플레이 제출 → 서버 검증·저장 | 201 `{ scoreId, score, detail, ranks: { daily, weekly, all } \| null }` (순위 계산만 실패하면 null) | 401(만료·무효 토큰 — 토큰 없이 재시도) · 409 `GAME_SESSION_INVALID`(없음·만료·재사용·버전 불일치) · 413 `PAYLOAD_TOO_LARGE` · 422 `GAME_PLAYER_NAME_INVALID`·`GAME_PLAYER_NAME_FORBIDDEN`(세션 미소모)·`VALIDATION_ERROR`(리플레이·세션 형식)·`GAME_REPLAY_INVALID`(재현 불가·시간 초과) · 429 |
| `GET /games/:gameType/rankings?period=daily\\|weekly\\|all&limit` | 없음 | 기간별 순위 | 200 `{ items: [{ rank, scoreId, playerName, score, detail, createdAt }], periodStart }` | 422 |
| `GET /games/:gameType/scores/:scoreId/replay` | 없음 | 리플레이 재생 데이터 (D-011) | 200 `{ scoreId, playerName, score, detail, createdAt, engineVersion, seed, das, arr, frames, inputs }` | 404 `GAME_SCORE_NOT_FOUND`(없음·숨김) · 429 |

- 이름 규칙(제출): DTO가 trim·연속 공백 1개로 정리 → 서비스가 판정(`player-name-policy.ts`): 1~12자, 한글 완성형·영문·숫자·공백·`_`·`-`만, 48바이트 이하 → 위반은 422 `GAME_PLAYER_NAME_INVALID`. 금칙어(서버 상수 목록, 한글·영문만 남기고 소문자화 후 포함 검사)는 422 `GAME_PLAYER_NAME_FORBIDDEN`. 두 경우 모두 세션을 소모하지 않는다 — 이름만 바꿔 같은 세션으로 재제출 (D-014)
- 로그인 유저: 프론트가 닉네임을 기본값으로 채우고 수정 가능, `USER_ID` 저장
- 순위: `SCORE DESC, SCORE_ID ASC`(같은 점수면 먼저 저장된 기록이 위 — `CRTD_AT`은 앱 시각이라 레플리카·풀 대기로 ID 순서와 어긋날 수 있어 동점 기준에 쓰지 않는다, D-015), `IS_HIDDEN = 0`, `FETCH FIRST :limit ROWS ONLY`. **기록 단위**(아케이드식 — 같은 이름이 여러 줄 오를 수 있음) (Q4)
- 기간 경계(D-004): 일간 = KST 오늘 00:00, 주간 = KST 이번 주 월요일 00:00 → UTC로 바꿔 `CRTD_AT >= :start`. `periodStart`(ISO UTC)를 응답에 싣는다
- 등록 직후 순위: 기간별로 `더 높은 점수 수 + 같은 점수인데 SCORE_ID가 작은 수 + 1` — 목록 정렬과 같은 규칙. 커밋 후 계산이 실패하면 `ranks: null`로 201 유지
- 한도(초안): 세션 발급 초당 2·분당 20, 제출 초당 1·분당 10(IP 또는 `user-{id}` — 기존 `CustomThrottlerGuard` 추적 키), 랭킹 조회는 전역 스로틀
- **본문 크기**: JSON 한도 `JSON_BODY_LIMIT = '300kb'`(`main.ts`·E2E 공유, Express 기본 100kb에서 상향 — D-014). 입력 120,000개 이론상 최대 본문 약 262KB. 초과는 413 `PAYLOAD_TOO_LARGE`(전역 필터가 body-parser 오류를 4xx로 변환)

## 4. 리플레이 검증 (D-005)

### 4-1. 제출 형식
```
replay: {
  engineVersion: number,        // 세션과 같아야 함
  das: number, arr: number,     // 프레임 단위, 허용 범위 안 (예: DAS 4~20, ARR 0~5)
  frames: number,               // 게임이 끝난 논리 프레임
  inputs: number[]              // [deltaFrame, actionCode, deltaFrame, actionCode, ...] 평탄 정수 배열
}
```
- `actionCode`: 누름/뗌이 있는 것(좌·우·소프트드롭)과 즉시 동작(회전 CW·CCW, 하드드롭, 홀드)을 정수 코드로. 키 반복은 기록하지 않는다 — DAS/ARR은 엔진이 누름 상태로 계산
- 일시정지는 프레임을 진행시키지 않으므로 기록에 없다

### 4-2. 서버 절차
1. 세션 조회 → 없으면 409. `gameType`·`engineVersion` 일치 확인 (2026-10-21 순서 변경 — 형식 검사 → `GET` 세션 → 시간 검사 → 검증 → 확정 시 `GETDEL`, 정본 `docs/tasks/defense/DESIGN.md` §B4)
2. 형식·상한 검사(DTO): `frames ≤ 216,000`(60분), `inputs.length ≤ 120,000`(동작 6만 개 — D-014), 정수·범위
3. **시간 검사**: `frames / 60초 ≤ (지금 − startedAt) + 5초` — 빨리 감기 봇 차단
4. 같은 엔진을 화면 없이 `seed` + `inputs`로 실행 → 게임 오버가 `frames`에서 실제로 일어났는지, 입력이 모두 유효한 프레임인지 확인 → 아니면 422 `GAME_REPLAY_INVALID`
5. 엔진이 계산한 `score`·`detail`로 저장. **클라이언트가 말한 점수는 받지 않는다**
- 실행 시간은 구현 후 실측해 WORKLOG에 남긴다(예상 수~수십 ms). 크면 worker thread

### 4-3. 엔진 공유 (D-008)
- 원본: `next-bun/src/app/games/tetris/engine/` → 백엔드 `src/modules/games/tetris-engine/`에 복사(파일 머리에 "원본·동기화 규칙" 주석, 직접 수정 금지)
- 골든 리플레이 픽스처(JSON: `seed`·`das`·`arr`·`inputs` → `score`·`lines`·`level`·`frames`·최종 보드 해시)를 **두 레포에 같은 파일**로 두고 양쪽 테스트가 같은 결과를 단정한다 — 어긋나면 CI 실패
- 엔진 규칙을 바꾸면 `ENGINE_VERSION`을 올린다. 서버는 현재 버전만 받는다(배포 순서: 백엔드 → 프론트, 버전 전환 중 제출은 409 → 프론트가 새 세션 안내)

### 4-4. 엔진 인터페이스 계약 (백·프 공통 — 이 절이 정본)
- 위치: 원본 `next-bun/src/app/games/tetris/engine/`(외부 import 없음, DOM·`Date`·`Math.random`·부동소수 금지, ES2020 문법만) → 사본 `bun/src/modules/games/tetris-engine/`
- `export const ENGINE_VERSION = 1`
- 동작 코드(정수, 바꾸면 버전 올림): `0` 좌 누름 · `1` 좌 뗌 · `2` 우 누름 · `3` 우 뗌 · `4` 소프트드롭 누름 · `5` 소프트드롭 뗌 · `6` 회전 CW · `7` 회전 CCW · `8` 하드드롭 · `9` 홀드
- 입력 로그 `inputs`: `[deltaFrame, code, ...]` 평탄 배열. `deltaFrame`은 직전 입력 프레임과의 차이(첫 입력은 0프레임 기준), 같은 프레임 여러 동작은 `deltaFrame = 0`, 동작은 해당 프레임 시작에 순서대로 적용
- `export function simulateReplay(input: { seed: number; das: number; arr: number; frames: number; inputs: number[] }): ReplayResult`
  - 성공: `{ ok: true, score, lines, level, pieces, tSpins, tetrises, maxCombo, endFrame, boardHash }` — 모두 정수, `boardHash`는 최종 판 FNV-1a 32비트 hex 8자
  - 실패: `{ ok: false, reason }` — `reason` ∈ `INVALID_HEADER`(seed·das·arr·frames 범위) · `INVALID_INPUT`(코드·delta 음수·홀수 길이) · `INPUT_AFTER_END`(게임 오버 이후 입력) · `NOT_ENDED`(`frames`에 게임 오버가 아님)
  - 규칙: 게임 오버(블록 아웃·락 아웃)로 끝난 판만 성공. `endFrame === frames` 필수
  - 범위: `seed` 0~2³²−1 정수 · `das` 4~20 · `arr` 0~5 · `frames` 1~216,000 · `inputs.length` ≤ 120,000 (D-014)
- 실시간 플레이용 증분 API(`createEngine` 등)는 프론트 내부 설계 — 단 `simulateReplay`와 **같은 틱 함수**를 써야 한다(플레이 결과 = 리플레이 결과)
- 골든 픽스처 `engine/__fixtures__/golden-replays.json`: `[{ name, input, expected }]`. 최소 케이스 — 입력 없이 탑아웃 · 단일·2·3·4줄 · T-스핀(미니·일반) · 백투백 · 콤보 · 홀드 · DAS/ARR 이동 · I 블록 벽 킥 · 소프트·하드드롭 점수 · 레벨 상승 · 실패 사유 4종. 두 레포에 **바이트 단위로 같은 파일**
- 성능 목표: 최악 `simulateReplay`가 Node에서 200ms 이하 — 실측 WORKLOG 2026-10-21 엔진 사본 절(212,253프레임·입력 38,844: 프론트 vitest 중앙값 41.6ms, 백엔드 tsx 77.8ms)

## 5. 테트리스 엔진 규칙 (D-009 — 가이드라인 기준)

- 판: 10×20 표시 + 위쪽 숨은 20줄. 생성 위치 가이드라인 기준, 블록 아웃·락 아웃이면 게임 오버
- 순서: 7-bag, 시드 PRNG(32비트 정수, mulberry32 등). `Math.random`·`Date`·부동소수 금지
- 회전: SRS + 벽 킥 표(JLSTZ·I 별도), CW·CCW
- 홀드: 블록당 1회. 다음 블록 5개 표시. 고스트 표시(렌더러)
- 락 딜레이 30프레임(0.5초), 이동·회전 성공 시 리셋, 리셋 15회 상한
- 낙하 속도: 레벨별 중력을 **정수 표**(프레임당 1/65536칸 고정소수점)로 미리 정한 상수 — 가이드라인 공식을 미리 계산해 표로 둔다(실행 중 부동소수 계산 없음)
- 레벨: 1부터 시작, 10줄마다 +1, 상한 20
- 점수: 1·2·3·4줄 = 100·300·500·800 × 레벨, T-스핀(미니/일반) 가이드라인 값, 백투백 ×3/2(정수 나눗셈), 콤보 50 × 콤보 × 레벨, 소프트드롭 1/칸, 하드드롭 2/칸
- 지연: 줄 삭제·출현 지연은 엔진 상수 프레임(렌더러 연출은 이 프레임 안에서만)
- DAS/ARR: 엔진이 누름 상태와 충전 프레임으로 계산, 값은 리플레이 헤더(§4-1). 사용자 설정은 허용 범위 안에서만

## 6. 프론트 (D-007·D-009 — `next-bun-8b` 조사 근거)

- `/games`: 게임 카드 목록(테트리스·낚시), 각 카드에서 랭킹 보기
- BNB: "낚시" → "게임"(`/games`), `/games/**`·`/fishing/**` 활성. 게임 플레이 화면은 BottomNavBar 내부 경로 판정으로 숨김(낚시 layout의 `<style>` 숨김 제거)
- `/games/tetris`: 시작 화면(최고점·랭킹 미리보기·조작 안내·DAS/ARR 설정) → 플레이(전체화면, 줌·스크롤 차단 layout, 소켓 없음) → 게임 오버(점수·기간별 예상 순위·이름 입력·등록) → 랭킹
- 랭킹 화면: 일간·주간·전체 탭, `periodStart`를 로컬 시각으로 표시, 내가 방금 등록한 기록 강조(로컬에 내 `scoreId` 기억)
- 조작: 키보드 `e.code`(←→ 이동, ↓ 소프트, Space 하드, ↑·X 회전 CW, Z·Ctrl CCW, C·Shift 홀드, Esc·P 일시정지) / 모바일 멀티터치 가상 버튼(왼쪽 이동·소프트, 오른쪽 회전·하드·홀드), 진동(지원 시)
- 일시정지: 탭 숨김·창 포커스 이탈 시 자동, 복귀 시 "계속하기"
- 저장: 개인 최고점·마지막 이름·DAS/ARR 설정은 localStorage(try/catch). 제출 실패 시 결과를 sessionStorage에 보관 후 재시도
- 1차 제외: 사운드, 키 재지정, 점수 공유 카드

## 7. 리플레이 재생 (D-011)

- 누구나(비로그인 포함) 랭킹의 모든 기록을 재생할 수 있다. 숨김(`IS_HIDDEN = 1`) 기록은 404
- 서버는 `GAME_REPLAYS.REPLAY`(gzip)를 풀어 §4-1 형식 그대로 돌려준다(응답 압축은 HTTP 계층). 조회는 기록 1건 단위 — 랭킹 목록 쿼리는 리플레이 테이블을 읽지 않는다
- 프론트는 같은 엔진에 `seed`·`das`·`arr`·`inputs`를 넣고 렌더러로 그린다(입력 장치 대신 기록이 입력을 공급)
  - 컨트롤: 재생/일시정지 · 배속 0.5·1·2·4× · 진행 막대 탐색(앞으로 = 빨리 시뮬레이션, 뒤로 = 처음부터 다시 시뮬레이션 — 엔진이 화면 없이 빨라 즉시 이동) · 처음부터
  - 표시: 점수·줄·레벨·경과 시간, 눌린 키 오버레이(어떤 입력으로 플레이했는지 보이게)
  - 진입: 랭킹 행의 "▶ 리플레이", 게임 오버 화면의 "내 플레이 다시보기"(등록한 기록)
- **엔진 버전**: 재생은 기록의 `engineVersion`과 같은 엔진이 있어야 한다. 1차는 현재 버전만 재생하고, 다른 버전이면 "이전 버전 기록이라 재생할 수 없어요" 안내. 버전을 올리는 시점에 이전 엔진을 보존할지(버전별 엔진 폴더) 정한다
- 한도: 조회 스로틀(초당 2·분당 30), 응답 크기는 저장 상한(§4-2)을 따른다

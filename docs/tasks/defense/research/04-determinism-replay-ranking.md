# 04 · 타워 디펜스 — 결정적 시뮬레이션 · 리플레이 · 랭킹 (조사·설계 제안)

> 조사 문서다(결정 아님). 결정은 태스크 폴더의 DECISIONS로 옮긴 뒤 DESIGN에 반영한다.
> 레포 근거는 `파일:라인`(경로 접두 `bun/.claude/worktrees/defense/` 생략), 웹 근거는 URL. 수치 중 **"추정"**은 실측 전 값이다.

## 0. 요약 — 권장안 한눈에

| 주제 | 권장안 | 대안 | 핵심 위험 |
|---|---|---|---|
| 틱 | **30Hz 고정 틱**, 렌더는 보간 | 60Hz(테트리스와 통일) | 60Hz는 서버 검증 CPU 2배 |
| 수치 | **정수 고정소수점**(1타일 = 256단위), 거리 제곱 비교, 삼각함수 없음 | 사칙연산만 쓰는 double | `Math.sin/cos/atan2/pow`는 엔진별 차이 |
| 난수 | 기존 mulberry32 재사용, 시뮬 상태에 포함 | 확률 요소 제거(완전 결정 퍼즐) | 난수가 많을수록 "유리한 seed 고르기" 공격 이득 |
| 경로 | **1차: 고정 경로(웨이포인트)** — 경로탐색 없음 | 미로형: 목표에서 BFS 거리장 + 고정 이웃 순서 | 미로형은 막힘 판정·재계산 순서가 결정성 함정 |
| 리플레이 | 명령 로그 `[deltaTick, op, ...args]` 평탄 정수 배열 (테트리스 형식 확장) | 고정 길이 레코드 | 명령 인자 무효 시 처리 규칙(엄격 거부 권장) |
| 탐색 | 클라이언트가 재생 중 **주기 스냅샷**(5~10초) + 웨이브 경계 | 처음부터 재시뮬(테트리스 방식) | 60분 판은 처음부터 재시뮬이 수 초 |
| 시간 검사 | `ticks / (TPS × 최대배속) ≤ 경과 + 여유` | 배속 구간 기록 후 합산(보안상 이득 없음) | 배속 허용 = 오프라인 계산 봇 차단력 1/3로 약화 |
| 서버 비용 | **worker thread에서 검증**(첫 판부터), 최악 리플레이로 실측 | 메인 스레드 + 틱 상한 | 메인 스레드 수 초 블로킹 → 같은 프로세스 WS 지연 |
| 랭킹 | 스테이지: (생명 내림, 클리어 틱 오름)을 **정수 1개로 인코딩** / 무한: (도달 웨이브, 마지막 웨이브 진척) | 게임식 점수 공식(처치·시간 보너스) | 공식형은 밸런스 패치마다 기록 비교 불가 |
| 스키마 | `GAME_TYPE` CHECK에 `'DEFENSE'` 추가 + **`BOARD_KEY` 컬럼 신설**(스테이지·무한·일일) | DETAIL JSON에 stageId / GAME_TYPE을 스테이지별로 분리 | 컬럼 추가는 Entity와 세트 — 미실행 배포는 장애 |
| 인터페이스 | `ReplayInput`의 `das/arr`를 `params: Record<string, number>`로 일반화 + 엔진별 `ticksPerSecond`·상한 | 게임별 DTO 분기 | 테트리스 API 계약(`das`·`arr` 최상위) 호환 |
| 렌더 | 순수 TS 시뮬(의존성 0) + **Canvas2D 렌더러**, 부족하면 PixiJS로 교체 | PixiJS 처음부터 / Phaser | Phaser는 자체 루프·가변 delta가 결정 루프와 충돌 |

---

## 1. 현재 구조 — 전제 (읽은 근거)

- **레지스트리**: 서비스는 `GameEngine { engineVersion; verify(input) }`만 안다(`src/modules/games/game-engine.registry.ts:21-26`). 그런데 `ReplayInput`이 `{ seed, das, arr, frames, inputs }`로 **테트리스 고유 필드(das·arr)를 품고 있다**(`game-engine.registry.ts:9-15`). 결과 `detail`은 `Record<string, number>`(`:18`).
- **테트리스 어댑터**: `simulateReplay` 결과를 `detail`로 옮기고 das·arr도 detail에 넣는다(`src/modules/games/tetris-game-engine.ts:9-31`).
- **틱 속도가 서비스 전역 상수**: `FRAMES_PER_SECOND = 60`(`src/modules/games/games.service.ts:39`). 시간 검사 `playedMs > Date.now() - startedAt + 5000`이면 422(`games.service.ts:124-129`), `durationMs`도 이 값으로 계산(`:147`).
- **저장 형식도 테트리스 고정**: gzip 안 `StoredReplay { das, arr, frames, inputs }`(`games.service.ts:42-47, 139, 160`), 재생 응답도 das·arr를 최상위로 돌려준다(`games.service.ts:208-217`, `src/modules/games/games.dto.ts:160-167`).
- **DTO**: `ReplayDto`가 `das`·`arr`를 필수 정수로 요구(`games.dto.ts:46-52`), 상한은 전역 상수 `GAME_REPLAY_MAX_FRAMES = 216_000`·`GAME_REPLAY_MAX_INPUT_LENGTH = 120_000`(`src/common/constants/app.constants.ts:51-52`, `games.dto.ts:54-68`).
- **세션**: Redis `{ gameType, seed, engineVersion, startedAt, userId }`, seed는 `crypto.randomInt(0, 2**32)`(`src/modules/games/game-session.service.ts:18-25, 55`), TTL **2시간**(`app.constants.ts:48`).
- **랭킹 정렬**: `SCORE DESC, SCORE_ID ASC`(`games.service.ts:186`), 등록 직후 순위도 같은 규칙(`games.service.ts:230-240`). 필터는 `GAME_TYPE`·`IS_HIDDEN`·기간뿐 — **스테이지 축이 없다**.
- **스키마**: `GAME_SCORES_TYPE_CK CHECK (GAME_TYPE IN ('TETRIS'))`·`UK (SCORE_ID, GAME_TYPE)`(`migrations/1792564226000-CreateGameScores.ts:59-60`), 인덱스 `(GAME_TYPE, SCORE DESC, CRTD_AT)`·`(GAME_TYPE, CRTD_AT)`(`:70, :75`). `GAME_REPLAYS_TYPE_CK`와 복합 FK(`migrations/1792564227000-CreateGameReplays.ts:46-49`). Entity `GAME_TYPES = ['TETRIS']`(`src/entities/GameScore.ts:5-6`).
- **엔진 규약**: 원본은 프론트, 백엔드는 사본 + 골든 픽스처 바이트 동일, "DOM·`Date`·`Math.random`·부동소수 금지, ES2020"(`docs/tasks/games/DESIGN.md:84-100`). PRNG는 mulberry32 32비트 정수 연산(`src/modules/games/tetris-engine/random.ts:7-12`).
- **실측 기준점**: 테트리스 최악 리플레이(212,253프레임·입력 38,844) 백엔드 77.8ms, gzip 5.4KB(`docs/tasks/games/WORKLOG.md:57`).
- **수용한 위험**: seed가 발급 즉시 노출되고 세션을 버릴 수 있어 "유리한 seed 고르기 + 오프라인 입력 생성 + 실시간 검사만 기다리기" 봇은 막지 못함(`DESIGN.md:42`).

→ 디펜스는 이 파이프라인(세션 seed → 입력 로그 제출 → 서버 재시뮬 → 서버 계산 점수 저장)을 **그대로 재사용**할 수 있다. 바뀌어야 하는 것은 ① 테트리스 고유 필드의 일반화 ② 엔진별 틱 속도·상한 ③ 배속을 고려한 시간 검사 ④ 스테이지 축 ⑤ 검증 CPU(테트리스보다 무겁다).

---

## 2. 결정적 시뮬레이션

### 2-1. 고정 틱
- **권장: 30Hz**(33.3ms). 타워 디펜스는 반응 속도 게임이 아니라 입력이 드물고, 적 이동·발사 주기는 30Hz로 충분하다. 서버 검증 CPU가 60Hz의 절반이다. 화면은 60/120Hz로 그리되 직전·현재 틱 위치를 **보간**한다(렌더 전용, 시뮬에 되먹이지 않음) — "Fix Your Timestep"의 accumulator 패턴 <https://gafferongames.com/post/fix_your_timestep/>.
- 배속: 실시간 1프레임에 시뮬 틱을 1·2·3개 돌린다(틱 길이는 불변). 일시정지 = 틱 0개. **배속·일시정지는 시뮬레이션 밖**이므로 리플레이 결과에 영향이 없다.
- 대안 60Hz: 테트리스와 상수를 맞출 수 있지만 이득이 없다. 엔진별로 `ticksPerSecond`를 레지스트리에 두면(§6) 둘이 공존한다.
- 상한(제안): 스테이지 모드 60분 = 108,000틱, 무한 모드는 §4-4 세션 TTL과 함께 정한다.

### 2-2. 수치 — 정수 고정소수점
- **JS 사칙연산 자체는 엔진 간 결정적이다**: Number는 IEEE 754 double이고 `+ - * /`는 정확 반올림이 규격이라 V8·SpiderMonkey·JSC가 같은 비트를 낸다. 진짜 위험은 **초월 함수**다 — ECMA-262는 `Math.sin` 등을 "implementation-approximated"로 두고 fdlibm은 권고일 뿐이다 <https://esdiscuss.org/topic/es6-accuracy-of-special-functions>, <https://github.com/tc39/ecma262/pull/903>. 실제로 같은 V8 계열(Node vs Chrome)에서도 `Math.sin/cos` 결과 마지막 비트가 달라 물리 시뮬이 갈라진 사례가 있다(`Math.sqrt`는 일치) <https://codeberg.org/perplexdotgg/bounce/issues/8>. 네이티브 쪽도 같은 문제(CPU별 삼각함수 차이) <https://gafferongames.com/post/floating_point_determinism/>.
- 그럼에도 **정수 고정소수점을 권장**한다: ① 기존 엔진 규약 "부동소수 금지"(`DESIGN.md:90`)와 일관 ② 상태 해시·골든 픽스처 비교가 쉽다 ③ 누군가 나중에 `Math.atan2`·`**` 하나 넣는 실수를 리뷰에서 "실수(float) 금지" 한 줄로 잡을 수 있다.
- 단위: 1타일 = 256단위(서브픽셀). 맵 32×18타일이면 좌표 최대 8,192×4,608 → `dx² + dy²` 최대 약 8.8×10⁷ < 2³¹, `|0` 정수 연산 범위 안.
- **거리**: 사거리 판정은 `dx*dx + dy*dy <= range*range`(range² 미리 계산). sqrt 불필요.
- **이동**: 적은 경로 위 **진행 거리(progress) 정수 하나**로 표현하고 좌표는 웨이포인트 사이 선형 보간을 정수 나눗셈으로 계산(렌더에서만 필요하면 시뮬에서는 progress만). 속도 = 틱당 진행 단위(정수), 감속 효과 = `speed * pct / 100` 정수 나눗셈.
- **투사체**: 유도 미사일의 벡터 정규화가 필요하면 정수 `isqrt`(반복법) 또는 256방향 정수 sin/cos 테이블. 더 단순한 권장안은 **"발사 시 명중 틱 예약"**: 발사 시점 거리로 도달 틱 `t + ceil(dist/speed)`를 정해 그 틱에 대상이 살아 있으면 피해 — 비행 궤적은 렌더 연출. 거리 계산에 쓰는 정수 sqrt만 필요하다.
- **각도**: 포탑 회전은 렌더 전용. 시뮬에 각도가 필요하면(부채꼴 범위) 정수 외적·내적 부호로 판정.
- 금지 목록(엔진 규약 후보): `Math.sin/cos/tan/atan2/exp/log/pow/**`(정수 지수 포함 — 직접 곱셈으로), `Math.random`, `Date`, `performance.now`, 부동소수 리터럴, `Number.toFixed` 기반 로직, 객체 키 순서 의존. lint 규칙(`no-restricted-properties`)으로 엔진 폴더에만 걸 수 있다.

### 2-3. 시드 PRNG
- 기존 mulberry32(`tetris-engine/random.ts:7-12`)를 그대로 쓰되 **난수 상태를 시뮬 상태 안에 둔다**(전역 금지). 뽑는 위치는 틱 안 정해진 단계에서만.
- 크리티컬·회피 판정: `value % 100 < critPct`. 모듈로 편향은 무시 가능하고 양쪽이 같은 식이면 결정성엔 무관.
- 스트림 분리(선택): 스폰 변동용·전투용 상태를 따로 두면 "타워 하나 더 지었더니 다음 웨이브 구성이 바뀜" 같은 나비효과가 줄어 **디버깅·밸런싱이 쉬워진다**(검증에는 불필요).
- **설계 질문**: 난수가 점수에 미치는 영향이 클수록 seed 고르기 공격(`DESIGN.md:42`) 이득이 커진다. 스테이지 랭킹은 **난수 최소화**(크리 없음 또는 "N번째마다 크리" 같은 결정 규칙)를 권장 — 그러면 seed가 사실상 무의미해지고 BTD6 레이스처럼 "같은 퍼즐을 누가 더 잘 푸나" 경쟁이 된다. 일일 챌린지는 모두에게 같은 seed(§5-4).

### 2-4. 엔티티 처리 순서
- **틱 단계 순서를 계약으로 고정**(DESIGN에 정본으로):
  1. 이 틱 명령 적용(기록 순서대로) → 2. 스폰 → 3. 적 이동·상태효과 감소 → 4. 타워 쿨다운·타겟팅·발사 → 5. 예약된 명중 처리 → 6. 사망·현상금 → 7. 누설(생명 감소) → 8. 웨이브 종료·게임 종료 판정.
- 엔티티는 **단조 증가 정수 ID**(생성 순)로 배열에 보관, 순회는 ID 오름차순. 삭제는 "죽음 표시 → 틱 끝에 압축"(순회 중 splice 금지).
- 정렬: `Array.prototype.sort`는 ES2019부터 안정 정렬이지만 비교 함수가 **전순서**여야 한다 — 동점은 항상 ID로 끊는다.
- 타겟팅 동점 규칙 예: `first` = progress 최대 → ID 최소, `strong` = HP 최대 → progress 최대 → ID 최소, `close` = 거리² 최소 → progress 최대 → ID 최소.
- `Map`/`Set` 순회는 삽입 순서라 결정적이지만, **정수 형태 문자열 키를 가진 일반 객체는 숫자 오름차순이 먼저 나온다** — 상태 컨테이너는 배열·`Map`만.
- 동시 피해: 같은 틱에 여러 타워가 같은 적을 치면 단계 4의 타워 ID 순서로 순차 적용, 이미 죽은 적에 대한 명중은 버림(오버킬 규칙도 계약에).

### 2-5. 경로탐색
- **권장(1차): 고정 경로** — Kingdom Rush식 길 + 건설 슬롯. 경로탐색이 없어 결정성 위험·서버 비용이 가장 작다. 건설 명령 인자는 "슬롯 번호"라 리플레이도 작다.
- 대안(미로형, Fieldrunners식): 목표에서 BFS로 **거리장**을 만들고 적은 이웃 중 거리 최소 칸으로 이동(flow field) — 한 번 계산으로 모든 적이 공유 <https://www.redblobgames.com/pathfinding/tower-defense/>. 결정성 규칙:
  - 이웃 순서 고정(N·E·S·W), 동점이면 그 순서 첫 번째.
  - 재계산은 **건설·판매 명령 적용 직후 같은 틱 단계 1에서만**.
  - 경로를 완전히 막는 건설은 거부 — 거부 판정도 시뮬 안(같은 BFS)에서.
  - 칸 사이에 있는 적의 다음 칸 결정 규칙(현재 목표 칸 유지 vs 즉시 재선택)을 계약에 명시.
  - 비용: 32×18 = 576칸 BFS는 건설 시에만 돌아 무시 가능.

### 2-6. 결정성 검증 장치
- 골든 리플레이 픽스처(테트리스와 같은 방식, 두 레포 바이트 동일 — `DESIGN.md:86`): 입력 → 최종 점수·상태 해시.
- **웨이브별 상태 해시**(FNV-1a, 기존 `fnv1aHex` 재사용 `random.ts:30-38`)를 클라이언트가 리플레이에 선택적으로 실어 보내면, 서버 재시뮬과 갈라질 때 **첫 불일치 웨이브**를 로그로 남길 수 있다. 점수 판정에는 쓰지 않는다(신뢰 불가 값).
- 퍼즈 테스트: 무작위 명령열을 Node(jest)·브라우저 3종(Playwright: Chromium·Firefox·WebKit)에서 돌려 해시 일치 확인 — 초월 함수가 몰래 들어오면 여기서 잡힌다.

---

## 3. 리플레이 형식

### 3-1. 명령 로그
- 테트리스의 `[deltaFrame, code, ...]` 평탄 정수 배열(`DESIGN.md:93`)을 **가변 인자**로 확장: `[deltaTick, op, arg1, arg2, ...]` — 인자 개수는 op별 고정(엔진 상수 표).

| op | 이름 | 인자 | 비고 |
|---|---|---|---|
| 0 | BUILD | slot(또는 x, y), towerType | 타워 ID는 시뮬이 생성 순으로 부여 → 이후 명령은 그 ID를 참조 |
| 1 | UPGRADE | towerId, path | |
| 2 | SELL | towerId | |
| 3 | SET_TARGET | towerId, mode | |
| 4 | CAST | skillId, x, y | 쿨다운·비용은 시뮬이 검사 |
| 5 | CALL_WAVE | — | 조기 호출(보너스 골드·시간 단축) |

- **기록하지 않는 것**: 배속·일시정지·카메라·선택 UI(시뮬 밖). 단 배속은 표시용 메타로 따로 둘 수 있다(§4-2).
- 명령은 **다음 틱 경계에 적용**하고 그 틱 번호로 기록 — 실시간 플레이와 재생이 같은 틱 함수를 쓴다(`DESIGN.md:99`와 같은 원칙).
- **무효 명령 처리 — 권장: 엄격 거부**. 클라이언트는 자기 시뮬이 수락한 명령만 기록하므로 서버에서 무효(골드 부족·없는 타워·막힌 칸)면 변조 또는 비결정성 버그다 → 422 `GAME_REPLAY_INVALID` + reason 로그. 대안(무시하고 진행)은 버그를 숨긴다.
- 테트리스처럼 `endTick`(= frames)을 헤더에 두고 엔진이 "그 틱에 게임이 끝났는가"(스테이지: 마지막 웨이브 클리어 또는 생명 0, 무한: 생명 0)를 확인.

### 3-2. 크기 추정 (추정 — 구현 후 실측)
- 명령 1개 ≈ 정수 3~5개 ≈ JSON 12~20바이트.

| 플레이 | 명령 수 | 정수 | JSON | gzip(약 1/3~1/4) |
|---|---|---|---|---|
| 스테이지 20웨이브 | ~150 | ~600 | ~2.5KB | ~1KB |
| 스테이지 40웨이브 고수 | ~400 | ~1,600 | ~7KB | ~2KB |
| 무한 100웨이브 | ~1,500 | ~6,000 | ~25KB | ~7KB |

→ 테트리스 실측(5.4KB, `WORKLOG.md:57`)과 같은 규모 이하. 본문 한도 300kb(`DESIGN.md:60`)에 여유. 입력 상한은 엔진별로 **20,000 정수** 정도면 충분(테트리스 120,000보다 작게 — DoS 면 축소).

### 3-3. 탐색(시크)·배속 재생
- 테트리스는 "뒤로 = 처음부터 재시뮬"(`DESIGN.md:132`)이 가능했지만, 디펜스는 틱당 비용이 커서 60분 판을 처음부터 돌리면 수 초가 걸릴 수 있다(§4-1 추정).
- **권장**: 재생기가 앞으로 시뮬하면서 **N틱마다 상태 스냅샷**(권장 300틱 = 10초, 메모리 보고 5초로) + **웨이브 시작마다** 스냅샷을 클라이언트 메모리에 쌓는다. 탐색 = 직전 스냅샷 복원 → 목표 틱까지 화면 없이 시뮬.
  - 전제: 시뮬 상태가 **순수 데이터**(클래스 인스턴스·클로저·함수 참조 없음)여야 `structuredClone` 한 번으로 복제된다 → 엔진 설계 제약으로 명시.
  - 메모리 추정: 상태 20~50KB × 360개(60분/10초) ≈ 7~18MB — 무한 모드 장시간이면 간격을 늘리거나 오래된 것 솎기.
  - 진행 막대에 웨이브 경계 눈금 → "웨이브 N으로 이동".
- 배속 재생: 렌더 1프레임당 틱 k개(0.5×는 2프레임에 1틱). 탐색 중 대량 시뮬은 메인 스레드를 잡으므로 틱 묶음 단위로 `requestAnimationFrame`/`setTimeout` 분할 또는 Web Worker.
- 서버 저장은 지금처럼 명령 로그만(스냅샷 저장 안 함).

---

## 4. 서버 검증 비용 · 시간 검사

### 4-1. CPU 추정 (추정 — 반드시 최악 리플레이로 실측)
- 틱당 비용 ≈ 적 이동 E + 타겟팅 T×E(무식한 전수) + 투사체 P.
- V8에서 정수 거리 비교 1회를 수 ns(속성 로드 포함 3~5ns)로 보면:

| 상황 | 타워 T | 동시 적 E | 틱당 | 108,000틱(60분@30Hz) |
|---|---|---|---|---|
| 보통 | 25 | 60 | ~10µs | ~1초 |
| 후반 혼잡 | 50 | 200 | ~50µs | ~5초 |
| 무한 후반 | 80 | 500 | ~200µs+ | 수십 초 |

- 테트리스 최악 77.8ms(`WORKLOG.md:57`)와 **자릿수가 다르다**. 메인 스레드에서 돌리면 그동안 같은 프로세스의 HTTP·Socket.IO가 멈춘다.
- **완화책**(시뮬 설계 단계에서 같이):
  - 타겟 유지: 현재 대상이 사거리 안·생존이면 재탐색 안 함, 재탐색은 쿨다운이 찼을 때만.
  - 공간 버킷: 타일 그리드(또는 고정 경로의 progress 구간)별 적 목록 → 사거리 칸만 검사.
  - 적 수 상한(무한 모드는 HP 스케일로 난이도, 마릿수는 상한).
- **권장: 검증은 첫 판부터 `worker_threads`에서**. Node 기본 모듈이라 새 의존성 없음(piscina 같은 풀 라이브러리는 의존성 추가 → Ask). 레플리카당 워커 1~2개 + 대기열 상한, 넘치면 503(재시도 가능 코드) — 세션은 **검증 시작 전에 소모되므로** 대기열 초과 시 세션 소모 전에 거부하거나, 세션 소모를 검증 성공 뒤로 미루는 순서 조정이 필요(현재는 소모 후 검증 `games.service.ts:113-136`).
- 서버 시간 상한: 시뮬에 **틱 예산·벽시계 타임아웃**(예: 10초)을 두고 초과는 422 + 경고 로그(악의적 "적 1,000마리 방치" 리플레이 대비).

### 4-2. 시간 검사 — 배속이 있으면
- 현재 검사: `frames × 1000 / 60 ≤ (now − startedAt) + 5s`(`games.service.ts:124-129`) — 게임 시간이 벽시계 경과보다 길 수 없다.
- 배속 최대 `S`(예 3×)를 허용하면 게임 시간 `ticks / TPS`가 벽시계의 최대 S배까지 정상이다. 바뀐 검사:

  ```
  minWallMs = ticks × 1000 / (TPS × S_max)
  거부 조건: minWallMs > (now − startedAt) + tolerance
  ```
- **배속 구간을 기록해 합산**(`Σ 구간틱 / (TPS × 구간배속)`)하는 안은 보안상 이득이 없다 — 클라이언트가 "내내 3×"라고 쓰면 그만이라 하한은 결국 `S_max`로 정해진다. 표시용(평균 배속)으로만 의미.
- 결과: 오프라인 봇이 기다려야 하는 시간이 1/S로 준다. 게다가 디펜스는 명령이 드물고 전략 퍼즐이라 오프라인 탐색(시뮬을 수천 번 돌려 최적 빌드 찾기) 이득이 테트리스보다 크다. 이것은 `DESIGN.md:42`에서 이미 수용한 위험의 연장 — **랭킹은 "검증된 합법 플레이"까지만 보장하고 "사람이 직접 했음"은 보장하지 않는다**를 문서화하는 것이 정직하다. 완화: 난수 최소화로 seed 고르기 무의미화, 일일 챌린지 동일 seed(모두 같은 조건).
- 추가 상한 검사(선택): `ticks / TPS + 일시정지 허용 ≥ ...` 같은 상한은 일시정지 무제한이라 의미 없음.
- `durationMs`(`games.service.ts:147`)는 **게임 시간**(`ticks × 1000 / TPS`)으로 저장 — 배속과 무관한 값이라 랭킹 동점 기준에도 쓸 수 있다.

### 4-3. 세션 TTL
- TTL 2시간(`app.constants.ts:48`)은 테트리스 60분 상한 기준. 디펜스는 1×로 60분 + 일시정지가 길면 **세션이 판 도중 만료 → 409로 기록 유실**.
- 선택지: (a) 디펜스 세션 TTL을 엔진별로(예 4~6시간) — Redis 키 수가 적어 메모리 영향 미미(`DESIGN.md:43`) (b) 웨이브마다 heartbeat로 `EXPIRE` 연장 — API 추가. **권장 (a)**, 무한 모드 상한(틱)과 함께 결정.

---

## 5. 랭킹 점수 설계

### 5-1. 모드 축
- **스테이지별 랭킹**: 스테이지마다 별도 보드. 클리어한 판만 등록(실패 판은 등록 불가 — 스테이지 보드의 의미 보존).
- **무한 모드 랭킹**: 하나의 보드(맵별로 여러 개면 맵별). 게임 오버로 끝난 판만.
- **일일 시드 챌린지**: 날짜별 보드, 모두 같은 seed·같은 맵/규칙.
- 기간 탭(일간·주간·전체 `ranking-period.ts`)은 그대로 각 보드에 적용 가능.

### 5-2. 점수 공식 — 권장: 사전식 키를 정수 하나로 인코딩
현재 랭킹은 `SCORE DESC, SCORE_ID ASC` 한 축(`games.service.ts:186, 235`). 이를 그대로 쓰려면 다중 기준을 정수 1개로 만든다.

- **스테이지**: 1순위 남은 생명(많을수록), 2순위 클리어 게임 틱(적을수록 — 조기 호출이 전략 요소).
  ```
  score = livesLeft × 10^7 + (10^7 − 1 − clearTicks)     // clearTicks ≤ 108,000 < 10^7
  ```
  `NUMBER(12)` 안(생명 ≤ 99,999). 화면에는 score 대신 DETAIL의 `livesLeft`·`clearMs`를 보여준다.
  - 사례: Kingdom Rush는 남은 생명(20 중 18 이상 = 별 3개)으로 평가 <https://kingdomrushtd.fandom.com/wiki/Lives>, BTD6 레이스는 클리어 시간이 순위이고 라운드 조기 호출로 시간을 줄인다(파워·더블캐시 금지) <https://www.bloonswiki.com/Race_(BTD6)>, BTD6 보스 이벤트도 별도 보드(최소 비용·최소 티어 등)에 시간 동점 처리 <https://www.bloonswiki.com/Boss_Bloon_Event>.
  - 대안: "무누설만 등록 + 시간만"(BTD6 레이스형, 더 하드코어) — 생명 항목을 빼면 공식이 더 단순.
- **무한**: 1순위 클리어 웨이브 수, 2순위 마지막(죽은) 웨이브 진척(처치 수 또는 처치 HP 비율 ‰).
  ```
  score = wavesCleared × 10^6 + finalWaveProgressPermille × 10^3 + min(999, ...)   // 예시
  ```
  "같은 웨이브에서 죽음 → 오래 버틴 쪽"을 틱으로 하면 조기 호출과 충돌하므로 **진척(처치)**을 권장.
- **잔여 골드를 점수에 넣지 않기**를 권장: 저축 플레이를 유도해 재미를 해친다. 넣는다면 아주 작은 3순위.
- **대안: 게임식 점수 공식**(처치 점수 + 시간 보너스 + 생명 보너스 + 조기 호출 보너스) — 숫자가 직관적이지만 밸런스 패치(=엔진 버전 상승)마다 기록 비교가 깨지고 계수 튜닝 부담. 랭킹을 사전식으로 두고 "점수"는 표시용 별도 값으로 DETAIL에 두는 절충도 가능.

### 5-3. 동점
- 인코딩 후 동점이면 기존 규칙 그대로 `SCORE_ID ASC`(먼저 등록한 기록 우선, `DESIGN.md:56`).
- **위험**: 난수 없는 스테이지는 "무누설 + 최적 시간"으로 수렴해 상위가 **완전 동점 다수**가 된다. 기록 단위(아케이드식, `DESIGN.md:56` Q4)면 같은 사람이 같은 공략을 반복 등록해 보드를 도배할 수 있다 → 스테이지 보드는 "유저(또는 이름)별 최고 1개" 표시를 검토(쿼리 변경 필요, 비로그인 이름 기준은 우회 쉬움).

### 5-4. 일일 시드 챌린지
- seed = `HMAC-SHA256(secret, 'defense-daily:' + KST 날짜)`의 하위 32비트 — 서버만 계산, 모두 동일. 세션 발급 시 그 seed를 넣고 `BOARD_KEY = 'daily-2026-10-21'`.
- 날짜 경계는 KST(`ranking-period.ts:11-23`와 같은 기준). 세션 발급일 기준으로 보드를 정하고 자정 넘어 끝나도 그 날 보드에 등록.
- 공정성: 모두 같은 seed라 seed 고르기 공격은 사라지지만 오프라인 최적화는 모두에게 열린 퍼즐 — 일일 1회 기록 제한(로그인 전용) 같은 선택지는 별도 결정.

---

## 6. 레지스트리·스키마 일반화

### 6-1. 인터페이스 (권장안)
```ts
export interface ReplayInput {
  seed: number;
  frames: number;                    // 틱 수 (게임별 TPS)
  inputs: number[];
  params: Record<string, number>;    // 테트리스 { das, arr } · 디펜스 { } (스테이지는 boardKey로)
  boardKey: string;                  // §6-2
}
export interface GameEngine {
  engineVersion: number;
  ticksPerSecond: number;            // 60 · 30 — games.service.ts:39 전역 상수 대체
  maxSpeed: number;                  // 테트리스 1 · 디펜스 3 — 시간 검사 §4-2
  maxFrames: number; maxInputLength: number;   // 엔진별 상한(DTO 전역 상한은 최댓값)
  boardKeys(): readonly string[] | ((key: string) => boolean);  // 허용 보드
  verify(input: ReplayInput): VerifiedReplay;  // 디펜스는 worker로 돌리므로 Promise 반환 버전 필요
}
```
- `verify`가 무거운 게임을 위해 **`Promise<VerifiedReplay>`**로 바꾸고 테트리스는 `Promise.resolve`로 감싼다(호출처 `games.service.ts:132` 1곳 + spec의 가짜 엔진).
- **DTO 호환**: `ReplayDto`(`games.dto.ts:40-69`)의 `das`·`arr`를 선택(optional)으로 바꾸고 `params?: Record<string, number>`를 추가 → 서비스가 테트리스면 최상위 `das`·`arr`를 `params`로 옮긴다. 엔진이 `params` 키를 **엄격 검사**(전역 ValidationPipe의 `forbidNonWhitelisted`는 데코레이터 없는 일반 객체 내부 키까지는 막지 못하므로 엔진 책임).
- **저장 형식**: `StoredReplay`(`games.service.ts:42-47`)에 `params` 추가, 읽기는 옛 형식(`das`·`arr` 최상위)도 받기 — 이미 저장된 테트리스 행 호환.
- **재생 응답**: `GameReplayDetailDto`(`games.dto.ts:160-167`)의 `das`·`arr`는 테트리스 계약이므로 유지(값 없으면 생략) + `params` 추가. 계약 변경 = Ask 대상, 프론트 세션 확인 필요.
- 대안: 게임별 DTO 클래스를 서비스에서 `plainToInstance` + `validate`로 분기 — 타입이 엄격하지만 코드량·Swagger 표현이 늘어난다.

### 6-2. 스테이지 ID 위치

| 안 | 내용 | 장점 | 단점 |
|---|---|---|---|
| A. `GAME_TYPE` 분리 | `DEFENSE_S01`, `DEFENSE_ENDLESS` … | 스키마 그대로 | 스테이지 추가마다 CHECK 교체 마이그레이션 2개 테이블 + `GAME_TYPES` 상수·경로 파라미터 의미 붕괴. **비권장** |
| B. `DETAIL` JSON | `{ stageId, ... }` | 컬럼 추가 없음 | 랭킹이 `JSON_VALUE(DETAIL, '$.stageId')` 필터 — CLOB이라 일반 인덱스 불가(함수 기반 인덱스는 가능하나 19c CLOB JSON에서 관리 부담), 순위 쿼리 `rankOf`도 JSON 필터 |
| **C. 컬럼 `BOARD_KEY`** | `VARCHAR2(40 BYTE) NOT NULL DEFAULT 'default'` — `stage-01`·`endless`·`daily-2026-10-21` | 인덱스 정상, 쿼리 단순, 일일·시즌까지 같은 축 | 마이그레이션 + Entity 세트, 인덱스 교체 |

- **권장 C**. 인덱스 `(GAME_TYPE, BOARD_KEY, SCORE DESC, SCORE_ID)`로 교체(기존 `IDX_GAME_SCORES_TYPE_SCORE`), 기간 랭킹용 `(GAME_TYPE, BOARD_KEY, CRTD_AT)`. 테트리스는 `'default'`.
- Oracle 11g+에서 `ADD (col ... DEFAULT ... NOT NULL)`은 메타데이터만 바뀌어 기존 행을 다시 쓰지 않는다(빠름) — 단 실행 전 담당자 확인.
- `GAME_REPLAYS`에는 필요 없음(SCORE_ID로 조인).
- 세션에 `boardKey`를 넣고(`GameSession` `game-session.service.ts:18-25`), 제출 시 세션 값을 쓴다 — 클라이언트가 보드를 바꿔 제출하는 것 차단(일일 seed와 보드 짝 보장). 엔진도 `boardKey`로 맵·웨이브를 고르므로 재시뮬 자체가 검증.
- API: `POST /games/defense/sessions` 본문 `{ boardKey }`, `GET /games/:gameType/rankings?board=stage-01`(없으면 `'default'`) — 테트리스 계약 불변.
- `detail`은 숫자만(`Record<string, number>`, `game-engine.registry.ts:18`) 유지 가능 — 문자열 stageId를 DETAIL에 넣지 않아도 되므로.

### 6-3. 마이그레이션 영향 (1파일 1목적, 실행은 담당자)
1. `GAME_SCORES_TYPE_CK`·`GAME_REPLAYS_TYPE_CK` 교체: `IN ('TETRIS','DEFENSE')`(`CreateGameScores.ts:60`, `CreateGameReplays.ts:46`) + Entity `GAME_TYPES`(`GameScore.ts:5`).
2. `BOARD_KEY` 컬럼 추가 + 컬럼 코멘트 + Entity.
3. 인덱스 교체(기존 2개 → 보드 포함 2개).
- 배포 게이트: Entity에 `BOARD_KEY`가 생기면 TypeORM SELECT가 그 컬럼을 읽으므로 **마이그레이션 미실행 배포 = 테트리스 랭킹까지 장애**(머지 전 차단). LOCAL=PROD 같은 DB라 실행 즉시 상용 반영(프로젝트 CLAUDE.md Never 표).
- `down()`: 컬럼 drop·CHECK 원복 — CHECK 원복은 DEFENSE 행이 있으면 실패하므로 down 주석에 명시.

---

## 7. 렌더링 기술 · 로직/렌더 분리

| 선택지 | 성격 | 장점 | 단점 |
|---|---|---|---|
| **Canvas2D 직접** | 브라우저 API | 의존성 0, 번들 증가 없음, 수백 스프라이트 규모면 충분 | 파티클·필터·대량 스프라이트에서 성능 한계, 배칭 직접 구현 |
| PixiJS | WebGL/WebGPU 렌더 라이브러리 | 스프라이트 배칭 빠름(벤치마크 상위), 렌더만 담당해 결정 루프와 충돌 없음 | 의존성·번들 추가(Ask), 학습 |
| Phaser | 풀 게임 프레임워크(씬·물리·입력·오디오) | 기능 많음 | 자체 게임 루프·가변 delta·물리가 **우리 결정 루프와 중복/충돌** — 렌더러로만 쓰면 낭비, 번들 큼 |

- 벤치마크: Pixi가 가장 빠르고 Phaser도 양호 <https://github.com/Shirajuki/js-game-rendering-benchmark> (하드웨어·씬 조건 불명이라 참고치). Phaser 3는 Pixi 대신 자체 WebGL 렌더러 <https://dev.to/ritza/phaser-vs-pixijs-for-making-2d-games-2j8c>.
- **권장**: 시뮬은 테트리스 엔진처럼 **외부 import 없는 순수 TS 폴더**(백엔드 사본 대상). 렌더러는 시뮬 상태를 **읽기 전용**으로 받아 그리는 별도 모듈 — 1차 Canvas2D, 성능이 부족하면 렌더러만 PixiJS로 교체(시뮬·리플레이·서버 무영향).
- 분리 규칙:
  - 시뮬 → 렌더: 틱마다 상태(또는 이전·현재 위치)만 노출, 렌더는 보간·연출(투사체 궤적·사망 애니메이션·데미지 숫자)을 자기 시간축으로.
  - 렌더 → 시뮬: 직접 호출 금지, **명령 큐**로만(입력 = 리플레이 명령과 같은 형식).
  - 연출 난수(파티클 흔들림)는 `Math.random` 허용 — 단 렌더 폴더에서만, 시뮬 PRNG를 소비하면 안 됨.
  - 탐색·배속·서버 검증은 같은 `step()`을 렌더 없이 호출.

---

## 8. 위험 목록

| # | 위험 | 영향 | 대응 |
|---|---|---|---|
| R1 | 시뮬에 초월 함수·float 유입 | 브라우저별 재시뮬 불일치 → 정상 기록 422 | 정수 규약 + lint 금지 + 3브라우저 퍼즈 해시 테스트 |
| R2 | 서버 검증 CPU(수 초) | 같은 프로세스 HTTP·WS 지연 | worker thread, 틱 예산·타임아웃, 타겟 유지·공간 버킷 |
| R3 | 배속 허용으로 시간 검사 약화 | 오프라인 최적화 봇 대기 1/S | 위험 수용 문서화, 난수 최소화, 일일 동일 seed |
| R4 | 세션 TTL 2시간 < 긴 판 | 판 도중 만료 → 409, 기록 유실 | 엔진별 TTL(§4-3) |
| R5 | 세션을 소모한 뒤 검증 대기열 초과/타임아웃 | 재시도 불가로 기록 유실 | 대기열 검사를 세션 소모 전에, 또는 성공 후 소모 |
| R6 | 동점 대량(결정 퍼즐) | 상위 보드 도배 | 유저별 최고 1개 표시 검토 |
| R7 | `BOARD_KEY` Entity 선배포 | 테트리스 포함 랭킹 장애 | 머지 전 차단 게이트 |
| R8 | 밸런스 패치 = 엔진 버전 상승 | 이전 기록 재생 불가·비교 불공정 | 시즌 보드(`BOARD_KEY`에 시즌 포함) 또는 버전별 엔진 보존(`DESIGN.md:135`와 같은 결정 필요) |
| R9 | 시뮬 상태가 순수 데이터가 아님 | 스냅샷 탐색 불가 | 엔진 설계 제약으로 명시 |
| R10 | 테트리스 API 계약(`das`·`arr`) 변경 | 프론트 깨짐 | 하위 호환 유지(§6-1), 계약 변경은 Ask |

## 9. 다음 확인(결정 필요)
1. 틱 30Hz 확정 여부, 최대 배속(2× / 3×).
2. 맵 형식: 고정 경로 vs 미로형(경로탐색 필요 여부가 여기서 갈림).
3. 확률 요소(크리·회피) 포함 여부 — seed 공격 표면과 직결.
4. 스테이지 점수: 생명+시간 사전식 vs 게임식 공식.
5. `BOARD_KEY` 컬럼 도입(스키마 변경 — 마이그레이션 실행 담당자 필요).
6. 검증 worker 도입 시점(첫 판부터 권장) — 최악 리플레이 실측으로 확정.

## 출처
- Gaffer On Games — Fix Your Timestep: <https://gafferongames.com/post/fix_your_timestep/>
- Gaffer On Games — Floating Point Determinism: <https://gafferongames.com/post/floating_point_determinism/>
- Gaffer On Games — Deterministic Lockstep: <https://gafferongames.com/post/deterministic_lockstep/>
- es-discuss — ES6 accuracy of special functions: <https://esdiscuss.org/topic/es6-accuracy-of-special-functions>
- tc39/ecma262 PR #903 (삼각함수 정확도 제안): <https://github.com/tc39/ecma262/pull/903>
- JS 엔진 간 Math.sin/cos 시뮬 불일치 사례: <https://codeberg.org/perplexdotgg/bounce/issues/8>
- Red Blob Games — Flow Field Pathfinding for Tower Defense: <https://www.redblobgames.com/pathfinding/tower-defense/>
- Bloons Wiki — Race Event (BTD6): <https://www.bloonswiki.com/Race_(BTD6)>
- Bloons Wiki — Boss Bloon Event: <https://www.bloonswiki.com/Boss_Bloon_Event> (본문 직접 열람 403 — 검색 요약 근거, 동점 규칙 세부 미확인)
- Kingdom Rush Wiki — Lives: <https://kingdomrushtd.fandom.com/wiki/Lives>
- JS game rendering benchmark: <https://github.com/Shirajuki/js-game-rendering-benchmark>
- Phaser vs PixiJS: <https://dev.to/ritza/phaser-vs-pixijs-for-making-2d-games-2j8c>

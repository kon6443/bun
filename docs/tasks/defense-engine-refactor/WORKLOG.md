# 디펜스 엔진 리팩토링 — 작업 기록

> 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 절을 찾는다.

## 2026-10-24 — 착수
- 백 worktree `bun/.claude/worktrees/defense-refactor`(`origin/main` `49be967`), `.env` 링크
- 기존 기록(`../defense/WORKLOG.md`): 프론트 perf (a)·(b) 하네스 `engine-dev/perf.test.ts`, 백엔드 실측 (b) 1.76~1.90초·실제 최장 판(60,145틱) 115~119ms·162,000틱 외삽 311~321ms(백엔드 tsc 하네스), 실제 워커 dist 골든 5판 2~186ms
- 엔진 규모: 백엔드 사본 `src/modules/games/defense-engine/` 6,653줄(생성 데이터 `weeklyCombos.ts` 2,079 포함)

## 2026-10-24 — 서버 기준선(백엔드, 엔진 무변경 `49be967`)
- 환경: Apple M2 Pro · Node v22.21.1 · load average 3.9~4.2(다른 세션 작업 중) · `pnpm build` dist
- 골든 52판 중 서버 검증 대상(무한·주간) 8판, 최장 60,145틱(`endless-greedy`)

| 측정 | 결과 |
|---|---|
| 인프로세스 `verifyDefenseReplay` 서버 대상 8판 합 | 5회 206·192·188·188·191ms, 중앙 **191ms** |
| 최장 판 60,145틱 단건 | 7회 101.8~105.5ms, 중앙 **103.1ms** (≈ 0.0017ms/틱) |
| 최장 판 1회 힙 증가 | 약 3.7MB(gc 후 기준, 참고값) |
| 실제 워커 풀(dist 워커) 최장 판 | 197.2(첫 회 기동 포함)·117.9·104.1·97.5·97.7ms |

- 판 상한 162,000틱 외삽 ≈ 280ms(선형). 최악 스트레스 (b)는 프론트 하네스 수치로 받는다
- **운영 리플레이 회귀**: 운영 DB 디펜스 기록 3건뿐(`endless-s1` 1 · `weekly-2026-w43` 2, 테스트 기록 포함, 숨김 0) → 회귀 픽스처 가치 낮음(D-002). 안전망은 생성 코퍼스 중심

## 2026-10-24 — 백엔드 안전망(코퍼스) · 실효 증명
- 프론트 픽스처(엔진 af55815 기준, 결정성 2회 생성 바이트 동일): 이식용 `portable.json` 71판(캠페인 35·무한 18·주간 18, idle 162,000틱 장판 2·보스 웨이브 포함, 총 2,776,624틱) sha256 `2f4f52f7…` · 러너 `portableRunner.ts` `f7577694…` · 프론트 전용 `corpus.expected.json` 4,000판(봇 6종, 프론트 차등 테스트 통과)
- 백엔드 배치: `src/modules/games/defense-engine-corpus/{portable.json, portableRunner.ts(엔진 import 한 줄만 '../defense-engine'), copy-hashes.json, corpusSpec.ts}` + spec 4개(사본·구성 1 + 모드별 campaign·endless·weekly — jest 병렬) · 러너 사본은 lint 제외(eslint ignores — 엔진 사본과 같은 이유, 경고 6 유지)
- 결과: 백엔드 엔진 사본으로 71판 전부 고정값 일치(76 tests) · 모드별 분할 후 23.3초(단일 파일 45.8초)
- **실효 증명**: 엔진 사본 `data/towers.ts:108` 궁수탑 damage 8→9 임시 변경 → 코퍼스 50판·골든 실패, 메시지에 첫 차이 위치("checkpoint #21 (tick 6300): 8cf662cd ≠ a33bc239") → 원복(git 변경 0)
- ci:core: 단위 1663/1663(+76), lint 0 errors·경고 6, build ✅
- 다른 메인 세션(bun-c4, 리플레이 조회수 기능)의 충돌 질의에 답함 — 겹치는 파일·스키마 없음, 주의: 리플레이 GET 60초 캐시·진행 중 주간 리플레이 404

## 2026-10-24 — 프론트 리뷰 R1 반영 픽스처로 백엔드 갱신
- 프론트 76321f6(엔진 diff 0): 픽스처 v2 + 헤더 `engineVersion` 3 · 이식용 72판(캠페인 36·무한 18·주간 18, **seed 0~2³²−1 전 범위 — 72판 중 34판 ≥ 2³¹**, 캠페인 10% 시험 스테이지) sha256 `7bb6b4fc…` · 러너 `30a29bb3…`(replayCheckpoints가 끝 해시·틱도 돌려 simulateReplay와 자기대조, 형식 깨진 로그 null) · 프론트 4,000판 `b08c3e32…` · 같은 ENGINE_VERSION 재생성 가드(DEFENSE_CORPUS_FORCE=1)
- 프론트 실효 증명(새 픽스처): A 데미지 8→9 이식 37/72·코퍼스 3,462/4,000 · B 증강 난수 1회 추가 28/72·1,537 · C streamSeed `seed|0` 34/72·2,035(seed ≥ 2³¹ 전부 — 옛 코퍼스였으면 0)
- 백엔드: 사본 재복사(import 한 줄만) · copy-hashes 갱신 · spec에 `corpus.engineVersion === ENGINE_VERSION`·seed ≥ 2³¹ 포함 단정 추가 → 79 tests 통과, 18.4초 · lint 경고 6
- 백엔드 실효 증명 C(`random.ts:53` `seed | 0`) → 34/79 실패(프론트 34/72와 일치) → 원복(git 변경 0)

## 2026-10-24 — 0단계 완료(프론트 보고 · 백엔드 최종)
- 프론트(9ca73ef·76321f6·d3afca8, 엔진 diff 0, 리뷰 R1 결함 0·R2 확정 0, test 1515·build ✅): 기준선 `engine-dev/baseline/BASELINE.json` · 코퍼스 4,000판(89,564,848틱 — 캠페인 2,365·무한 824·주간 811, 보드 132종, 봇 7종, 증강 판 1,537·누수 판 2,763·상한 장판 85·seed ≥ 2³¹ 2,035) · 결정성 2회 바이트 동일
- 프론트 기준선(plain Node 22, M2 Pro, `--expose-gc --semi-space 16`, 부하 7~9 — 높음):

| 시나리오 | 틱 | 중앙 ms | 스캐빈지/회 | 할당 추정 MB/회 |
|---|---|---|---|---|
| golden endless-greedy (서버 103ms와 같은 판) | 60,145 | 92.7 | 5.4 | 86 |
| corpus c2093 무한 최장 | 93,048 | 223.2 | 10.6 | 170 |
| corpus c3636 주간 최장 | 82,250 | 238.7 | 10.2 | 163 |
| corpus c680 캠페인 S8 어려움 최장 | 14,275 | 15.5 | 1.6 | 26 |
| 이어하기 복원 restoreGame(최악 93,047틱) | — | 227.2 | 11 | 176 |
| restoreGameInChunks 4,000틱 | 총 253.4 | 최장 청크 19.6 | — | — |
| prepareReplay | 총 265.4 | 최장 청크 20.4 | — | — |

  - major GC 0 · 잔여 힙 ±0.02MB(누수 없음) · 번들: 엔진 청크 raw 106,050B / gzip 33,275B, 무한·주간 First Load 262kB, 캠페인 플레이 199kB, 리플레이 246kB, 공통 103kB
  - 기존 perf.test(vitest, 부하 6): (a) 407ms·(b-E2) 5,211ms로 상한 초과 — vitest 오버헤드·부하 영향, 판정은 plain Node 기준(파일 규칙)
- 프론트 리팩토링 후보(측정 근거): ① `effects.ts statValue` CPU self **38.2%**(효과 목록을 호출마다 3번 선형 탐색, 호출처 35곳 — 효과 변경 시에만 (subject, stat) 표 재계산, 예상 25~35%) ② 핫패스 할당 재생 1회 약 170MB(틱당 약 1.8KB — towerStage·coveredLength·selectTarget·runUltimate·processDeaths, scratch 재사용) ③ 다음 CPU: attack 7.2·step 6.7·slotCover 6.6·updateAndMoveEnemies 6.6·runUltimate 3.8% ④ 모듈 분리·번들(엔진 청크 gzip 33KB) — 1단계 번들 분석 후 판단
- 주의(프론트): 백엔드 러너는 `computeExpected` 경유(백엔드 spec 준수 확인) · getStateHash 자체를 바꾸면 픽스처 재생성 불가피 → 마지막 단계로 · 코퍼스 기대값은 봇 코드에도 의존(봇 수정은 엔진 무변경 커밋으로 분리) · Node 24(CI) 동일성은 PR CI에서 첫 확인(이식용은 입력 로그라 영향 없음) · 무거운 코퍼스 테스트가 타이밍 민감 테스트를 흔들 가능성(RankedPlay 간헐 1회)
- 백엔드 최종: 러너 사본을 주석 변경본(`a3c10927…`)으로 갱신 · ci:core 단위 1666/1666 · lint 경고 6 · build ✅ · 커밋 `test(games): 디펜스 엔진 결과 동일성 코퍼스 안전망`


## 2026-10-24 — 1단계 R1 statValue 캐시 (프론트 af02a48 → 백엔드 동기화)
- 변경: `effects.ts`만 — 마지막으로 본 효과 배열(신원·길이)을 수치별 버킷으로 나눠 두고 statValue는 그 수치 효과만 원래 순서·규칙으로(곱→더하기→덮어쓰기). (대상, 수치) 정수 키 표는 희소 배열 사전 모드로 더 느려 버림(게이트 b)
- 무효화 전수(프론트 grep): 효과 목록 생성·변경은 `state.ts:242-245 initialEffects`(새 배열)·`augment.ts:125 pickAugment`(push — 길이 변화) 2곳, 원소 제자리 변경 0, 복제는 새 배열. statValue 호출처 27곳 모두 state.effects(예외 createGame 로컬 1)
- 메인 코드 대조: 효과 없는 수치는 `Math.max(0, base)` — 원래 루프 무동작 결과와 같음 ✅
- 게이트: 프론트 이식 72 + 전체 4,000판 + 엔진 테스트 333·매니페스트 통과 · 백엔드 사본 diff는 effects.ts 1개(매니페스트 23파일 대조) → 동기화 후 단위 1666 통과·lint 경고 6
- 성능(같은 조건, 부하 5~12):

| 시나리오 | 전 | 후 | 변화 |
|---|---|---|---|
| 프론트 golden endless-greedy | 93.85 | 63.13ms | −32.7% |
| 프론트 무한 최장 93,048틱 | 226.44 | 143.10 | −36.8% |
| 프론트 주간 최장 | 243.20 | 134.46 | −44.7% |
| 프론트 캠페인 S8 어려움 | 15.94 | 14.04 | −11.9% |
| 프론트 restoreGame 최악 / 청크 최장 | 235.15 / 19.78 | 146.68 / 12.16 | −37.6% / −38.5% |
| 프론트 prepareReplay | 274.53 | 179.99 | −34.4% |
| **서버** 최장 판 60,145틱(dist) | 103.1 | 62.3 | −39.6% |
| **서버** 대상 8판 합 / 워커 | 191 / 97~118 | 118 / 64~79 | −38% / −34% |

- 관찰: 무한·주간 스캐빈지 +3~6회/판(V8 측 추정, R2에서 할당 프로파일로 재확인)

## 2026-10-24 — 1단계 R2 핫패스 임시 객체 재사용 (프론트 cb8f2b7 → 백엔드 동기화)
- R1 뒤 스캐빈지 증가 원인(프론트 할당 프로파일): R1 버킷의 for…of 반복자가 bucketOf 삽입 뒤 V8 탈출 분석에서 제거되지 않아 statValue만 판당 72MB → 인덱스 루프로 0. 나머지 135MB는 makeStrike(공격마다 객체 2개)·enemySubject(틱마다 적 종류 수)
- 변경 3파일: effects(인덱스 루프) · state(towerSubject·enemySubject 값별 공유 객체, 키 kind×8+element — ELEMENT 0~4) · combat(makeStrike 작업 객체 하나, 매 호출 전 전 필드 재기입)
- 메인 대조: makeStrike 호출처 attack(500)·runUltimate(601)·impact(681) — 호출부(456·460)·투사체 루프(675)에서 순차, 중첩 없음 · 투사체는 towerId·slot·kind·level·branch·nthStatus 원시값만 저장 → 착탄 때 makeStrike 재생성 · 효과 대상 키 충돌 없음
- 판 간 격리 테스트: 프론트 `interleave.test.ts` → 백엔드 `defense-engine.corpus.interleave.spec.ts`(jest) — 8판 틱 단위 교대, 단독 기대값과 일치. 변이(버킷 메모 신원 검사 제거) 시 실패 확인 후 원복
- 게이트: 프론트 전체 4,000판·이식 72·골든·매니페스트·tokenScan 537 tests · 백엔드 엔진 테스트 138 · ci:core 1667 · lint 경고 6
- 성능(R1 → R2): 프론트 무한 c2093 145.4→138.0ms(−5.1%, 스캐빈지 14→0.4) · 주간 136.6→128.8(−5.7%, 16→0.2) · 골든 62.5→60.2 · 복원 148.6→144.3(14.6→1) · 서버 최장 판 62.3→61.6ms · 힙 증가 4.0→0.6MB — CPU 이득은 작고 GC가 사실상 사라짐(연속 검증·프론트 GC 멈춤 제거)

## 2026-10-24 — 1단계 리뷰 라운드 1 (백엔드)
- 범위: origin/main..HEAD `src/`·`eslint.config.mjs`(엔진 사본 3파일·매니페스트·코퍼스 사본·spec 5)
- 리뷰어 A(메인, review-flow): 엔진 호출처 `defense-verify.ts`·`defense-game-engine.ts` 2곳 — `simulateReplay` 동기 호출, 워커 스레드는 모듈 인스턴스 분리 → 판 교차 경로 없음. 확정 0
- 리뷰어 B(Opus 서브에이전트): 확정 0. effects 변경은 push 2곳뿐(augment.ts:125·state.ts:261-262, 같은 길이 내용 변경 0건 grep) · subject 필드 대입·identity 비교 0건 · strike 재진입 경로 없음(damage·status가 combat 미import) · 변이 재확인(길이 비교 제거 → 코퍼스 26건 실패, 신원 검사 제거 → interleave 실패). `defense-engine|defense-verify` 171 tests 통과
- 사소(버그 아님, 기각/후속): interleave의 캠페인 판 수 미단정(증강 판 ≥3 단정이 있어 격리 검사는 공허하지 않음 — 프론트 원본 테스트와 같이 바꿔야 해 프론트에 선택 제안) · effects "push만" 전제는 주석으로만 보장(효과 제거 기능이 생기면 코퍼스에 그런 판 추가 필요 — 후속 메모)

## 2026-10-24 — 배포 전 운영 기록 점검 (중간)
- `pnpm db:select`(읽기 전용) — 운영 DEFENSE 기록은 여전히 3건(46 endless-s1 · 47·79 weekly-2026-w43), 모두 ENGINE_VERSION 3, 숨김 0
- 리플레이 본문(GAME_REPLAYS.REPLAY BLOB)은 `db:select`가 LOB을 문자열로 꺼내지 못하고 내장 패키지(DBMS_LOB)는 가드가 거부 → 공개 API(`GET /games/:gameType/scores/:scoreId/replay`)로 받아야 한다. 주간 w43 2건은 그 주가 끝나고 4시간 뒤까지 404
- 재검증은 D-002대로 배포 직전에 공개 API로 받아 리팩토링 엔진 `verifyDefenseReplay`로 돌린다(점수·결과 일치 확인)

## 2026-10-24 — 1단계 리뷰 완료 (프론트 4라운드 → 백엔드 재동기화)
- 프론트: review-front + Opus 4라운드, 마지막 확정 0. 최종 cdda053(엔진 변경은 0e683ed effects.ts 주석 2줄 — 효과 배열 push 전용 계약). Opus 독립 검증: base·HEAD 엔진 72판 틱 단위 교대 해시 비교 275만 틱 불일치 0, statValue 무작위 대조 40만 회 0. 3R에서 격리 테스트 가드의 거짓 통과(표본 순서에 따라 길이만 비교 퇴행을 못 잡음)를 찾아 실제 step 순서 기준 가드로 수정(37005bc), 4R 실측 400·350 표본 어긋남 0
- 프론트 최종 게이트: DEFENSE_CORPUS=full 537 tests(4000판) · lint · typecheck · test:run 1516
- 백엔드 재동기화: effects.ts·매니페스트(루트 e6b2977d…) 바이트 복사, interleave spec은 머리 3줄(import·출처 주석·cases)만 다르게 다시 이식. 변이(길이만 비교) → interleave 실패(c2 tick 0) 확인 후 원복. `defense-engine|defense-verify` 171 · ci:core 1667 · lint 경고 6
- 1단계 코드 확정: R1·R2 + 계약 주석. ENGINE_VERSION 3·getStateHash 무변경

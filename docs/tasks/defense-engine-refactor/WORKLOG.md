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

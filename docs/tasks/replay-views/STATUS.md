# 리플레이 조회수·시청시간·인기 목록 — STATUS

> 결정 근거는 [DECISIONS.md](DECISIONS.md). 이 문서는 현황만 둔다.

## 범위

- TETRIS·DEFENSE 단일 플레이 리플레이(GAME_SCORES 공용) — 조회수, 시청시간, 기간별 인기 목록, 랭킹 항목에 누적 값 노출
- 범위 밖: 테트리스 대전 리플레이(경기 단위 집계는 별건)

## 세션·브랜치

| 레포 | 세션 | 브랜치 / worktree |
|---|---|---|
| 백엔드 bun | 메인 | `feat-onam-replay-views` / `.claude/worktrees/replay-views` |
| 프론트 next-bun | `next-bun-c4` | `feat-onam-replay-views` / `.claude/worktrees/replay-views` |

## API (백엔드)

| 메서드·경로 | 용도 |
|---|---|
| `POST /games/:gameType/scores/:scoreId/views` | 조회 1회 기록 → `{ scoreId, viewCount, counted }` (200) |
| `POST /games/:gameType/scores/:scoreId/watch?ms=` | 시청시간 증분 보고 → `{ scoreId, watchMs, countedMs }` (200) |
| `GET /games/:gameType/popular-replays` | 기간별 인기 목록 (D-005) |
| 랭킹·기록 요약·재생 응답 | 항목에 `viewCount`·`watchMs` 추가 (필드 추가만 — 기존 계약 유지) |

## 진행

- [x] 백엔드 구현 + 단위·E2E 테스트 (`games.service.spec`·`game-view.service.spec`·`games.module.spec`·`test/games.e2e-spec`)
- [x] 마이그레이션 파일 `migrations/1792828139000-CreateGameReplayViewStats.ts` 작성
- [x] 프론트 구현 (next-bun-c4, 미커밋) — 랭킹 행 `· 조회 N` · 재생 머리줄 조회수 · RankingsView 점수순/조회순/시청순 토글 · 테트리스 홈 "오늘 많이 본 리플레이". 프론트 lint·typecheck·test 1545·build 통과, 리뷰 2종 2회 must-fix 0
  - 후속 조정 지시(2026-10-24): 조회 기록은 재생 데이터 로드 성공 뒤에, 인기 목록 메달 제거
- [x] 마이그레이션 실행 (담당자, 2026-10-24) — 1차 ORA-02329 실패(생성물 없음) → D-006 수정 → 2차 성공. `db:select`로 컬럼 5·제약 4·인덱스 2 확인, 인기 목록 형태 쿼리 실행 확인
- [ ] 최종 검증 — 실제 API·Playwright
  - 실API 1차(2026-10-24, 로컬 `pnpm dev` → 운영 DB): 읽기 6종 정상 · scoreId 86에 views 2회(첫 INSERT·두 번째 증가 경로 모두 Oracle에서 동작) · watch 30초 · popular daily/all·watch 정렬 반영 · 기록 요약 viewCount·watchMs 반영 · `ms=0` 422. DB 행 `('2026-10-24', VIEW_COUNT 2, WATCH_MS 30000)` 확인. ⚠️ 이 2회·30초는 운영 집계에 남아 있다(검증 흔적)

## 다음 할 일

1. 프론트 구현 결과 대조 (계약: 위 API 표)
2. 사용자 커밋 지시 → 담당자 마이그레이션 실행 → 로컬 `pnpm dev`로 실제 API·Playwright 확인

## 게이트

- ~~머지 전 차단: 마이그레이션 실행~~ — 완료(2026-10-24). Entity `GameReplayViewStat`이 랭킹·요약·재생 조회에서 읽히므로, 테이블이 없는 상태로 배포하면 **랭킹 API 전체가 실패한다**(ORA-00942).
- **배포 직후 조치**: 없음
- **후속**: 테트리스 대전 경기 조회수 · README 테스트 기준선 갱신(PR 직전 `pnpm ci:all`)

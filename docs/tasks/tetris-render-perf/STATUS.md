# 테트리스 렌더 성능 개선 — STATUS

장시간 플레이 시 렉(배포 사이트, 맥북 Safari). 프론트(next-bun) 전용 작업, 백엔드·API·소켓 계약 변경 없음.

## 세션·브랜치

| 역할 | 세션 | 레포 | 브랜치 |
|---|---|---|---|
| 메인 | bun 메인 세션 | bun | 문서만 |
| 프론트 | next-bun-0c | next-bun | `perf-onam-tetris-render` (PR next-bun#387) |

## 원인 판정

- **배제(확정)**: 로그·배열 누적, 타이머·rAF·리스너 누수, 사운드 노드 누적, 레벨업 타이머 재생성 — 코드 근거 + headless 60분·23판 계측에서 증가 경향 없음 (next-bun-0c 분석)
- **가능성 높음(브라우저 실측 전)**: 매 프레임 shadowBlur·'lighter' 합성 고정 GPU 비용(Safari에서 특히 무거움) + 저사양 감지가 평균 25ms 초과 시에만 1회 전환되어 서서히 느려지는 스로틀을 못 잡음

## 범위 (사용자 승인 순서)

- [x] a3 저사양 감지 지속형(이동 평균 + 히스테리시스) — `TetrisCanvas.tsx`
- [x] a1 판 테두리 네온 오프스크린 캐시 — `effectsRenderer.ts`
- [x] a2 고스트 외곽선 shadowBlur 캐시 또는 lite에서 끔 — `renderer.ts`
- 후속(미착수): b1 HUD 리렌더 축소 · b2 프레임 할당 제거 · b3 큰 연출 shadowBlur lite에서 끔

## 제약 (bun-a1 확인)

- 캐시 키에 스킨 id(board·block) + 레벨 색·크기·dpr 포함 — PR #384 스킨 주입 구조
- `renderer.ts`는 고스트 부분만 최소 수정, `computeLayout` 불가침 — next-bun-35가 `feat-onam-game-settings`에서 S3(옆 HOLD/NEXT 패널 3→2.5칸) **확정·진행 중**. 오프스크린 캐시는 layout 계산값 기준으로 무효화. 머지는 먼저 끝난 쪽 기준, 나중 쪽이 main을 merge
- 관련 태스크: `docs/tasks/game-settings/`, `docs/tasks/tetris-skins/` (origin/main)

## 검증 계획

- 프론트: lint·typecheck·test·build + headless sim 전후 수치(draw 호출·shadowBlur 횟수)
- 메인: Playwright로 `/games/tetris/play` 시각 동일성·스킨 전환 확인
- 사용자: 배포 후 맥북 Safari 장시간 플레이 체감 확인

## 진행

- 2026-10-26 분석 완료(누적 원인 배제) → 사용자 승인(a3→a1→a2) → bun-a1 충돌 확인 → 프론트 구현 착수
- 프론트 세션은 이 작업 뒤 Node 런타임 고정 작업(`docs/tasks/node-runtime-2026-10/`)을 이어서 한다

## 결과 (2026-10-26 배포, release next-bun#388)

- 매 프레임 shadowBlur: full 2.42 → 0.98회/프레임(남은 것은 이벤트 연출), 테두리·고스트 0회. WebKit drawGame full 0.80 → 0.09ms, lite 1.43 → 0.07ms (next-bun-0c headless 측정)
- 픽셀 동일성 800케이스(DPR 5종 × 판 4 × 스킨 4 × 품질·이동) 최대 차 4/255
- a3 판정: 평균 20ms 30표본 연속 초과 시 lite, 18ms 미만 복귀, 최소 유지 10s(재진입 시 2배, 상한 5분), 표본은 실제 그린 프레임의 rAF 간격만
- 리뷰: review-front + Opus 4라운드, must 0
- 메인 Playwright(WebKit 26.6, DPR 2·1.1): `/games/tetris/play` 테두리·고스트 정상, pageerror 0, rAF p50 17ms·p95 18ms
- 미확인: 스킨 전환·리플레이 seek·대전 화면(로그인·백엔드 필요), 배포본 나란히 비교

## 다음 할 일

- 사용자: 맥북 Safari 장시간 플레이 체감 확인 → 렉 지속 시 Web Inspector Timelines 1분/20분 비교
- 후속(미착수): b1 HUD 리렌더 축소 · b2 프레임 할당 제거 · b3 큰 연출 shadowBlur lite에서 끔

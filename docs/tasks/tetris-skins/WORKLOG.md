# 작업 기록 — 테트리스 스킨·userId

> append-only. 목차는 `grep -n "^## "`.

## 2026-10-26 — 백엔드 userId 기록 경로·운영 데이터
- 싱글 랭킹: `games.controller.ts` 세션 생성(:98)·기록 제출(:149) 모두 `@UseGuards(OptionalJwtAuthGuard)` → `user?.userId ?? null` → `games.service.ts` 저장(:375 `userId`). 가드는 토큰이 없으면 익명 통과, 있으면 검증 후 user 주입(`optional-jwt-auth.guard.ts`) — 토큰은 cookie `access_token` → Bearer
- 대전: 방 입장 때 userId 보관(`tetris-battle-room.service.ts:134`) → 결과 제출 `tetris-battle-result.controller.ts:82` OptionalJwtAuthGuard → 저장 시 제출 userId 우선, 없으면 입장 userId(`tetris-battle-result.service.ts:409-410`)
- 운영 데이터(`pnpm db:select`, 읽기 전용):
  - GAME_SCORES — TETRIS user 56 · null 66, DEFENSE null 3(Playwright 테스트 기록). USER_ID가 있는 기록은 전부 USER_ID 1(첫 기록 2026-10-21). USERS 9명
  - TETRIS_BATTLE_PLAYERS — USER_ID 1 VERIFIED 12 · null VERIFIED 56 · null MISSING 13
  - 이상 사례: score 102(`daily-2026-10-24`, 이름이 USER_ID 1 사용자의 다른 기록과 같음)가 USER_ID null — 그 직전·직후 default 기록은 USER_ID 1. 비로그인 브라우저였는지 daily 경로가 토큰을 안 보내는지 프론트 호출부 확인 필요
- 판단(잠정): 백엔드는 토큰이 오면 기록한다. 누락은 프론트가 토큰(쿠키)을 안 보내는 경로가 있는지에 달림 → 프론트 세션 질의

# 게임 기록 소유 — 계정 이름 표시 · 내 기록 판별 — STATUS

계기(2026-10-26): "닉네임 바꾸기 전 테트리스 기록이 연동 안 된다". DB 확인 결과 기록은 USER_ID로 계정에 연결돼 있었고(`권오남_OnamKwon` 32건·`개발자` 18건 모두 USER_ID 1, 비로그인 저장 1건만 null), 원인은 두 가지였다.
- 랭킹 등은 제출 당시 입력 이름(PLAYER_NAME)을 그대로 보여 준다
- 프론트의 "나" 판별이 이 브라우저 localStorage의 scoreId 목록(최대 50개)뿐 — 다른 기기·저장소 삭제·상한에서 빠진다. "내 최고 점수"도 브라우저 로컬값

## 세션·브랜치

| 역할 | 세션 | 레포 | 브랜치 |
|---|---|---|---|
| 메인(백엔드) | bun 메인 세션 | bun | `feat-onam-score-owner-name` |
| 프론트 | next-bun-0c | next-bun | (구현 중) |

## 결정

- **표시 이름**: USER_ID가 있는 기록은 현재 계정 이름(USERS.USER_NAME), 계정 이름이 비면 저장 이름. 비로그인 기록은 저장 이름. 랭킹·기록 단건·리플레이·인기 리플레이·명예의 전당(캐시 밖에서 입힘). 제출 직후 응답의 이름은 입력값 유지(프론트가 마지막 입력 이름으로 저장)
- **내 기록 판별**: 서버가 `isMine`을 계산한다 — 프론트가 userId를 비교하려면 모든 기록의 사용자 ID를 노출해야 해서 기각. 사용자 ID는 응답에 싣지 않는다
- **선택 인증 Guard 분리**: 공개 조회에는 `ViewerJwtAuthGuard`(인증 실패 → 비로그인 통과). 기존 `OptionalJwtAuthGuard`는 무효 토큰이 401이라, 만료 쿠키를 가진 사용자가 랭킹을 못 보게 된다
- **리플레이 재생 API는 요청자를 보지 않는다**(public Cache-Control) — isMine 항상 false
- **내 최고 점수**: `GET /games/:gameType/me/best?board=` — 로그인 사용자의 숨기지 않은 기록 중 최고점, 비로그인·기록 없음은 200 + null
- **계정 이름도 랭킹 이름 정책을 통과해야 표시**: `PUT /users/me`는 길이(1~20)만 보고 카카오 닉네임은 검증 없이 저장된다 — 그대로 쓰면 제출 때 막히는 금칙어·사칭·길이 초과 이름이 기존 기록 전체에 공개된다(Opus 리뷰 확정). 제출과 같은 정규화 + `checkPlayerName` 통과 이름만 쓰고, 아니면 저장 이름
- 범위 밖: 테트리스 대전 기록(별도 테이블)

## API 계약 변경 (추가만, 프론트 대응 필요)

- RankingItem `isMine: boolean` 추가 · `playerName` 의미 변경(로그인 기록은 계정 이름)
- 신규 `GET /api/v1/games/{gameType}/me/best`
- 조회 GET 4개가 선택 인증을 받음 — 무효 토큰도 200

## 검증 (백엔드)

- `pnpm ci:core`: lint 0 errors/경고 6 · typecheck 0 · 단위 1808/1808 · build
- `pnpm test:e2e`: 283 통과 · 58 skip — 유효 토큰 isMine·계정 이름·사용자 ID 미노출, 만료·서명 불일치 토큰 200, me/best 로그인·비로그인·422
- 새 테스트는 수정 코드를 빼면 실패함을 확인(표시 이름)

## 리뷰

| 라운드 | 리뷰어 | 확정 | 조치 |
|---|---|---|---|
| 1 | review-flow | 0 | — |
| 1 | Opus 서브에이전트 | 1 (+PLAUSIBLE 1·경미 2) | 계정 이름 정책 우회 → 정규화 + checkPlayerName 적용, 테스트 4건 |
| 2 | review-flow | 0 | — |
| 2 | Opus 서브에이전트 | 0 | 수정 코드를 빼면 새 테스트 4건이 실패함을 복사본에서 확인 |

## 남은 것

- [ ] 리뷰 루프(백·프) → 백엔드 배포 → 프론트 배포
- [ ] 후속: `GET me/best`용 인덱스 `(GAME_TYPE, USER_ID, SCORE DESC, SCORE_ID)` 마이그레이션(지금 데이터량에선 영향 작음, 미측정) · `PUT /users/me`에 랭킹 이름 정책 적용 검토 · ViewerJwtAuthGuard가 JWT_SECRET 누락도 비로그인으로 삼킴(다른 인증 라우트는 401이라 탐지 가능)
- [ ] 비로그인으로 저장된 SCORE_ID 102 계정 연결 여부 — 사용자가 직접 UPDATE(AI는 DB 변경 실행 안 함)

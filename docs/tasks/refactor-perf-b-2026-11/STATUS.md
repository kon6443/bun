# 리팩터링·성능 B 등급 (구조 개선)

- **상태**: ✅ 완료 — 백·프 운영 배포 (백 `aecaca8`·프 `41fd452`, 2026-11-18)
- **브랜치**: 백 `refactor-onam-perf-b` (base `origin/develop` `0e6b1e9`) · 프 `refactor-onam-perf-b` (next-bun-fe가 origin/develop에서) · **최종수정**: 2026-11-18
- **관련 문서**: DECISIONS.md · WORKLOG.md · 출발점 `../refactor-perf-survey-2026-11/` (STATUS 등급표 B, WORKLOG 원표 번호)

## 세션·브랜치
| 역할 | 세션 | 위치 |
|---|---|---|
| 메인·백엔드·문서 | 이 세션 | `bun/.claude/worktrees/refactor-survey` |
| 프론트 | `next-bun-fe` | `next-bun/.claude/worktrees/team-nickname` (브랜치 `refactor-onam-perf-b`, base `3179c49`) |

## 목표 & 수용 기준
- 무엇을: 조사 등급표 B1~B9 — 동작·계약을 바꾸지 않는 구조 개선과 리렌더·왕복 축소
- 끝났다는 기준:
  - B1 — 액세스 토큰 페이로드 타입·소켓 토큰 추출·서명 검증이 `common/utils/access-token.utils.ts` 한 곳. 가드 5곳의 에러 코드·메시지·게스트 폴백은 그대로(가드 spec·E2E 통과)
  - B2 — 테트리스·포트리스 방 서비스에 같은 이름으로 복제된 타입·`findUserSeat`·`assertCanTakeOver`·`recordHeartbeat`가 `game-room/`에 하나. 에러 코드 그대로
  - B3 — 텔레그램·디스코드 6개 라우트가 `team-integration.controller.ts`로. 경로·가드·Swagger·응답 불변
  - B4 — 하트비트 게이트·`joinTeam`의 Redis 왕복이 줄고, `TASK_SLOT` 판정이 헬퍼 하나(D-002). 로비 캐시는 제외(D-003)
  - B5~B9 — 프론트 보고의 수용 기준(리렌더 실측 또는 테스트, 계약 불변)
  - 공통 — 백 `ci:all`·프 `ci:core` 통과, 리뷰 루프 두 리뷰어 확정 0, Playwright 회귀
- 비목표: C 등급(규모 의존), 기획 의도 변경, API·소켓 계약 변경

## 지금 어디까지 (다음 세션이 여기서 이어간다)
- 완료: 범위·결정(D-001~D-004), 백 B1~B4 · 프 B5~B9 구현, 리뷰 루프(백 5R·프 4R, 마지막 라운드 양쪽 확정 0), 백 `ci:all`·실 Redis E2E·실 API·Playwright (WORKLOG 2026-11-17)
- **다음 할 일**: 후속(D-005~D-007) 커밋·PR·배포 — 사용자 지시(2026-11-18) 진행 중. 텔레그램·디스코드 연결·해제 수동 확인은 사용자 몫

## 진행 체크리스트
- [x] B1 JWT 검증·소켓 토큰 추출 단일화
- [x] B3 팀 연동 컨트롤러 분리
- [x] B2 게임 방 서비스 잔여 복제 → game-room
- [x] B4 하트비트 게이트 · joinTeam 왕복 · TASK_SLOT 헬퍼 (로비 캐시는 D-003으로 제외)
- [x] B5~B9 프론트 (next-bun-fe)
- [x] 리뷰 루프 · 백 `ci:all` · 실 Redis E2E · Playwright(2계정 포함)
- [x] 커밋·PR·배포 (백 #338·#339, 프 #415·#416)

## 미해결 질문 · 차단
| # | 질문 | 누구에게 | 권장 디폴트 | 상태 |
|---|---|---|---|---|

## 결정 요약 (본문은 DECISIONS.md)
- D-001 B 전체를 한 태스크로, 리뷰는 전부 끝낸 뒤 1회
- D-002 `TASK_SLOT` 미설정은 리더가 아니다(안전 기본값)
- D-003 로비 목록 공유 캐시는 하지 않는다(마지막 변경 누락 위험)
- D-004 감사 M6을 D-002로 닫는다(스케줄러 spec 갱신)

## 검증 명령 (DoD)
- 백 `pnpm ci:core` → PR 전 `pnpm ci:all` · 실 Redis opt-in E2E(로컬 컨테이너) · 프 `ci:core`(프론트 세션) · Playwright

## 위험 & 롤백
- 인증 경로(B1)·방 CAS 경로(B2)·로비 방송(B4) — 묶음별 격리 커밋으로 개별 revert. DB 변경 없음

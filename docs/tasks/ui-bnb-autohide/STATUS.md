# 하단 내비(BNB) 스크롤 자동 숨김 — 공통 레이아웃

- **상태**: 🚧 프론트 구현 중 · 백엔드 변경 없음
- **브랜치**: 프 `feat-onam-bnb-autohide`(origin/develop `3de4ff5`) · **최종수정**: 2026-10-27

## 세션·브랜치
| 역할 | 세션 | worktree | 브랜치 |
|---|---|---|---|
| 메인·문서·브라우저 검증 | 메인(bun) | — | — |
| 프론트 | `next-bun-35` | `next-bun/.claude/worktrees/skin-levels` | `feat-onam-bnb-autohide` |

## 목표 & 수용 기준 (D-001)
- 아래로 스크롤(문턱 8~12px)하면 숨고 위로 조금이라도 스크롤하면 보인다(아이폰 Safari 툴바처럼). 맨 위·맨 아래·BNB 안 포커스는 보인다
- transform 애니메이션, prefers-reduced-motion이면 즉시 · 게임 플레이처럼 BNB를 숨기는 기존 규칙 유지 · iOS 바운스·키보드 resize·내부 스크롤·하단 고정 요소 겹침 처리

## 지금 어디까지
- **다음 할 일**: 1. 프론트 구현 → 게이트·두 리뷰어 0 → 로컬 커밋 2. 메인 브라우저 검증(375 스크롤 전후) 3. 배포

## 결정 요약
- D-001(2026-10-27, 사용자 "bnb 스크롤 내리면 숨고 올리면 보이게, 공통 설정") — 권장 동작은 위 수용 기준(메인)

## 진행 기록
- 2026-10-27 프론트 d9c6056(feat-onam-bnb-autohide): 아래 10px 숨김·위 2px 노출, 맨 위·맨 아래·스크롤 120px 미만·키보드 포커스 시 노출, resize·경로 이동 직후 300ms 아래 점프 무시, reduced-motion 즉시. 게이트 1893, 리뷰 3차 두 리뷰어 0
- 메인 로그인 브라우저: /teams·/games/tetris/points·/games/defense/codex — top 575 → 아래 300 숨김(699) → 위 20 노출 → 맨 아래 노출, pageerror 0
- 미검증: iOS Safari·Android Chrome 실기기(주소창 resize·키보드·뒤로 가기 복원) — 배포 뒤 사용자 확인

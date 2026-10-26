# 테트리스 사용자별 인게임 UI(스킨) + 게임 기록 userId 점검

- **상태**: 🟡 조사 중 — 프론트 렌더 구조·설정 저장 선례 질의, 백엔드 userId 기록 경로 확인 (2026-10-26)
- **브랜치**: 백·프 `feat-onam-tetris-skins`(각 `origin/main`) · **최종수정**: 2026-10-26
- **관련 문서**: DECISIONS.md · WORKLOG.md · 선행 `../games-polish-2026-10/`(공통 소리 설정 모달·게임패드) · `../tetris-battle/`

## 세션·브랜치
| 역할 | 세션 | worktree | 브랜치 (base) |
|---|---|---|---|
| 메인·백엔드·문서 관리 | 메인(bun) | `bun/.claude/worktrees/tetris-skins` | `feat-onam-tetris-skins` (`origin/main` `1c7df5c`) |
| 프론트 | `next-bun-35` | (생성 예정) | `feat-onam-tetris-skins` (`origin/main`) |
- 이 폴더는 메인만 수정한다.

## 목표 & 수용 기준 (초안 — 계획 승인 때 확정)
1. **스킨**: 현재 인게임 UI = 기본 스킨. 스킨 여러 개를 도입하고 사용자가 고르면 그 사용자 화면에만 적용된다(싱글·멀티·리플레이 공통). 사용자마다 다르게 적용
2. **userId**: 로그인 사용자의 게임 기록(싱글 랭킹·대전 결과)에 USER_ID가 남는지 확인하고, 빠지는 경로가 있으면 고친다

## 지금 어디까지
- 완료: 백 브랜치·worktree · 백엔드 userId 기록 경로·운영 데이터 확인(WORKLOG)
- **다음 할 일**: 프론트 조사 답 → 설계안·계획 사용자 보고

## 결정 요약
- (없음)

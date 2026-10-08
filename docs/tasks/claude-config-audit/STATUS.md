# Claude 설정·문서 전수조사 및 베스트 프랙티스 적용 추천

- **상태**: 🟡 진행 중 — 리뷰 통과·커밋 완료, PR 머지(feat-onam → develop → main) 진행 (2026-10-08)
- **브랜치**: `feat-onam` · **최종수정**: 2026-10-08
- **관련 문서**: RECOMMENDATIONS.md(추천안) · DECISIONS.md · WORKLOG.md · 선행 이력 `../tasks-claude-config.md`(평면 문서, 그대로 유지)

## 목표 & 수용 기준
- 무엇을: bun 레포의 Claude 설정(`.claude/**`)·`CLAUDE.md`·`docs/**` md를 전수조사하고, 글로벌 설정(`~/.claude`·`~/dotfiles/claude-config`)·비교 레포 B과 비교한 뒤, 공식 문서·업계 패턴 기준 적용 가능한 개선안을 추천한다. 프론트(`../next-bun`)는 `next-bun-89` 세션에 위임하고 결과를 이 세션이 취합한다.
- 끝났다는 기준:
  - 조사 대상 파일 목록과 각 파일의 역할·문제점이 WORKLOG에 표로 남아 있다
  - 글로벌·비교 레포 B과의 차이가 "중복 / 충돌 / 한쪽에만 있음"으로 분류돼 있다
  - 추천안마다 현재(Before) → 적용 후(After) · 장점 · 단점 · 근거(공식 문서 URL 또는 파일:라인)가 있다
  - `CLAUDE.md`에 진행 상황·상태값이 기록된 위치가 전수 보고돼 있다
  - 프론트 세션 보고가 WORKLOG에 취합돼 있다
- 비목표: 커밋(사용자 지시 후), 글로벌 설정 직접 수정(쓰기 차단 경로)

## 지금 어디까지 (다음 세션이 여기서 이어간다)
- 완료: 조사·추천(S1~S8), 백엔드 적용(WORKLOG "적용 (백엔드)" 절), prompt-audit 대체 감사 반영, 프론트 패치 반영 확인
- **다음 할 일**:
  1. PR: `feat-onam → develop` → `develop → main` (main 머지 = 배포)
  2. 후속(별건): WS 핸들러 입력 검증 보강, 큰 태스크 문서 정리, 문서 중복 4건, README `migrationsRun` 서술 확인

## 진행 체크리스트
- [x] S1 — 백엔드 레포 Claude 설정·문서 전수조사
- [x] S2 — 글로벌 설정 비교
- [x] S3 — 비교 레포 B 비교
- [x] S4 — 공식 문서·업계 패턴 조사 (에이전트 보고 중 틀린 주장 정정 — WORKLOG S4 절)
- [x] S5 — CLAUDE.md 내 상태값·진행 기록 점검 (사용자 요구 8)
- [x] S6 — 추천안 정리 → `RECOMMENDATIONS.md`
- [x] S7 — 프론트 세션(`next-bun-89`) 보고 취합
- [x] S8 — 회사명·타 프로젝트명 점검 (D-003)
- [x] S9 — 백엔드·프론트 적용·검증
- [x] S10 — 사용자 직접 적용 항목(settings.json·메모리) 확인
- [x] S11 — `/doctor prompt-audit` · 독립 리뷰(High·Med 0) · 커밋 `86bf73d`(카카오 문서) · `2eacccd`(설정·문서 정비) · 이 기록 커밋
- [ ] S12 — PR 머지 feat-onam → develop → main

## 미해결 질문 · 차단
| # | 질문 | 누구에게 | 권장 디폴트 | 상태 |
|---|---|---|---|---|
| Q1 | 요청 경로와 실제 경로가 다른 비교 레포를 현행 버전으로 보면 되는가 | 사용자 | 현행 버전으로 진행, 레거시 버전 제외 | 디폴트로 진행 |
| Q2 | 추천안 적용 범위 | 사용자 | — | 해결: 전체 적용, `pnpm dev` 제외 (D-006) |
| Q-F1 | 메모리 수정(쓰기 차단 경로)은 사용자가 직접 적용? | 사용자 | 세션이 diff 제시 → 사용자 적용 | 해결: 디폴트 |
| Q-F2 | 프론트 local allow 정리 범위 | 사용자 | 위험 5종 + 일회성 절대경로만 | 해결: 디폴트 |
| Q3 | 이력 문서 `tasks-claude-config.md`의 타 프로젝트명(약 20건) 익명화 여부 | 사용자 | 새 커밋으로 익명화(히스토리는 그대로) | 해결: 익명화 적용 |

## 결정 요약 (본문은 DECISIONS.md)
- D-001 새 태스크 폴더로 관리, 기존 `tasks-claude-config.md`는 쪼개지 않음
- D-002 프론트 작업은 `next-bun-89` 세션에 위임, 결과는 이 세션이 취합
- D-003 설정 파일·커밋 문서에 회사명·타 프로젝트명 금지 (짝 레포 next-bun만 허용)
- D-004 CLAUDE.md에 수치·날짜·커밋 수·상태값·태스크 ID 일절 금지 (HTML 주석안 폐기)
- D-005 코드 규약 파일 종류별 rule 7개로 분할
- D-006 `pnpm dev` 현행 유지 (B2 보류)
- D-007 prompt-audit는 동일 기준 에이전트로 대체 + 사용자 교차 확인
- D-008 D-005 근거 정정(트랜잭션·QueryBuilder 수치는 원 문서가 맞음)
- 글로벌 설정은 `claude-config-08` 전담 — 이 태스크 범위 밖(2026-10-08 사용자 지시)

## 검증 명령 (DoD)
- 이름 노출: `git ls-files -co --exclude-standard | xargs grep -niE '<회사명>|<비교 레포 이름>'` → 0건
- 적용 단계: `/doctor prompt-audit` · 권한 변경은 탐침으로 시험(`docs/lessons.md`) · `pnpm ci:core`(훅 변경 시 `.claude/hooks/test-inject-sibling-claudemd.sh`)

## 위험 & 롤백
- 작업 트리에 다른 작업의 미커밋 변경(`CLAUDE.md`·`auth.service.ts` 등)이 있다 — 이 작업은 건드리지 않는다
- 권한 축소(B1·B2)는 프롬프트 증가만 유발 — 롤백은 해당 줄 복원

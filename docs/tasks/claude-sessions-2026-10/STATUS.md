# 백·프 2세션 운영 규칙 · Claude 설정 전수조사 · SELECT 허용

- **상태**: 🟡 진행 중 — 조사 완료·결정 확정, 적용 단계 (2026-10-20)
- **최종수정**: 2026-10-20
- **관련 문서**: DECISIONS.md · WORKLOG.md · 선행 `../claude-config-audit/`(2026-10-08 전수조사·적용 완료) · `../tasks-claude-config.md`(두 레포 공통 이력)

## 세션·브랜치
| 역할 | 세션 | worktree | 브랜치 (base) |
|---|---|---|---|
| 메인·백엔드·문서 관리 | `bun-f5` | `bun/.claude/worktrees/claude-sessions` | `chore-onam-claude-sessions` (`origin/develop` `7d56d53`) |
| 프론트 | `next-bun-6c` | `next-bun/.claude/worktrees/claude-sessions` | `chore-onam-claude-sessions` (`origin/develop` `8b2a330`) |
| 글로벌 설정(docker ask·db-guard) | `claude-config-7a` | — (글로벌 `~/.claude`·dotfiles) | — · 사용자와 직접 진행, 이 태스크는 결과만 (D-009) |
- 세션 이름은 사용자가 지정한 값이다(D-002). 세션이 바뀌면 이 표를 갱신한다.
- 이 폴더는 메인만 수정한다. 프론트 세션은 보고·질문을 메인에 보낸다.

## 목표 & 수용 기준
- 무엇을:
  1. 백·프 2세션 운영 규칙을 두 레포 `CLAUDE.md`에 상시 규약으로 넣는다
  2. 두 레포 Claude 설정(`CLAUDE.md`·`.claude/rules|agents|skills|hooks|settings.json`·라우팅 문서)의 위치·내용 문제를 전수조사하고 고친다
  3. SELECT 쿼리를 사용자 허가 없이 쓸 수 있게 한다(안전장치 포함)
- 끝났다는 기준:
  - 두 레포 `CLAUDE.md`에 세션 운영 절이 있고, 서로 모순이 없다(백엔드=메인·사용자 창구, 프론트=메인 경유)
  - 세션 찾기는 **사용자에게 묻는다**(직접 탐색 금지), 태스크 폴더 STATUS에 세션 표를 둔다, 프론트 세션이 없으면 사용자에게 새 세션을 요청한다
  - 전수조사 결과가 WORKLOG에 파일별 표(위치·문제·조치)로 남고, 고친 항목과 후속 항목이 구분된다
  - SELECT 허용 방식이 결정되고(D-00N), Never 표·README·권한 설정이 서로 일치한다. 쓰기(DML·DDL)는 여전히 차단됨을 탐침으로 확인한다
  - 회사명·타 프로젝트명 노출 0(claude-config-audit D-003 검증 명령)
- 비목표: 글로벌 설정(`~/.claude`·dotfiles) 직접 수정 — 쓰기 차단 경로라 diff 제시만

## 지금 어디까지
- 완료: 태스크 폴더·worktree, 전수조사(S1·S2), SELECT 러너·가드(S4), 백·프 문서·스킬·규칙 수정, 결정 D-001~D-016, 양쪽 settings 사용자 적용(백 allow79·ask101·deny101 / 프 allow29·deny60·ask88), 백엔드 리뷰 3회 + 최종 루프 R1·R2(ci:core 860/860)·프론트 리뷰 2R + 최종 R1 확정 0(ci:core 360/360) — WORKLOG 2026-10-20 절들
- **다음 할 일**:
  1. 메인: 커밋 3개 → develop PR·CI·머지 → main PR·CI·머지 (프론트는 next-bun-6c가 같은 순서) — 사용자 지시 완료(2026-10-21)
  2. 사용자 지시 대기: 커밋·머지(백 메인, 프 next-bun-6c, PR+CI → develop → main)
  3. 머지 후 새 세션 권한 탐침: `docker ps` 자동 · `docker build .`·`docker ps -c x`·`docker ps --context x`·`DOCKER_HOST=x docker ps`·`pnpm i foo`·`pnpm -w add foo`·`find . -name x -delete` 확인 · `pnpm test`(프론트)·`pnpm -C . exec typeorm …`·`yarn db:migrate:up` 거부 · `scripts/db-select.ts` Edit·`sed -i` 거부(worktree·루트) · `pnpm db:select` 무프롬프트
  4. 원래 bun 폴더 정렬 방법(현재 `chore-onam-pnpm10` + 미커밋 문서 2개)은 사용자에게 질문

## 진행 체크리스트
- [x] S1 — 백엔드 Claude 설정 전수조사(메인, Opus 감사) — 22건(high 6)
- [x] S2 — 프론트 Claude 설정 전수조사(next-bun-6c) — 23건(high 3)
- [x] S3 — 세션 운영 규칙 → 두 레포 CLAUDE.md: 백엔드 ✅ / 프론트 ✅(r1~r4 패치 사용자 적용)
- [ ] S4 — SELECT 허용: 가드·러너 ✅(단위 50/50) · 가드 거부 5/5 · 실조회·가림·상한 ✅ · READ ONLY ORA-01456 ✅ · settings 적용 후 무프롬프트 실행 확인 대기
- [x] S5 — 전수조사 지적 반영: 백엔드 ✅(C1은 후속) / 프론트 ✅ / 양쪽 settings 사용자 적용 ✅
- [ ] S6 — 검증·리뷰: 백 리뷰 3회+최종 루프 진행 중 / 프 최종 R1 확정 0 · 권한 탐침은 머지 후 새 세션 · 커밋·머지는 사용자 지시 후

## 미해결 질문 · 차단
| # | 질문 | 누구에게 | 권장 디폴트 | 상태 |
|---|---|---|---|---|
| Q1 | SELECT 허용 방식 | 사용자 | — | ✅ 기존 계정 + 앱 가드 (D-003) |
| Q2 | 두 세션이 상대 레포 코드를 읽는 범위 | 사용자 | — | ✅ 질의 기본 + 계약 산출물만 (D-007) |
| Q3 | 권한 강제 항목 목록 | 사용자 | — | ✅ 추천안 (D-008) · 글로벌은 claude-config-7a (D-009) |
| Q4 | 계약 요지 사본 | 사용자 | — | ✅ 사본 없이 항상 질의 (D-004) |
| Q5 | DB 차단 구멍 | 사용자 | — | ✅ 함께 막기 (D-006) |

## 결정 요약 (본문은 DECISIONS.md)
- D-001 세션 운영 규칙 요구사항 원문
- D-002 세션 찾기는 사용자에게 묻는다 · 세션 표는 태스크 STATUS · 프론트 세션 없으면 새 세션 요청
- D-004 계약 요지 사본 없이 질의 · D-006 DB 구멍 함께 막기 · D-007 읽기 경계(질의 기본 + Swagger 등 계약 산출물만) · D-008 권한 변경안 · D-009 글로벌 설정은 claude-config-7a · D-010 프로젝트 allow에 `Bash(docker:*)`(D-012가 supersede) · D-011 `pnpm install *` ask·typeorm pnpm 경유 deny · D-012 docker는 로컬 조회만 allow + `-c` ask · D-013 docker build도 allow 제외 · D-014 러너·가드 Edit/Write deny + 잔여 위험(package.json·node_modules, 근본 대책은 읽기 전용 계정)
- D-003 SELECT는 전용 명령 `pnpm db:select` — 가드(단일 SELECT·WITH, 쓰기·락·패키지 거부) + READ ONLY 트랜잭션 + 행 상한·타임아웃·민감 컬럼 가림. settings.json은 사용자 적용

## 검증 명령 (DoD)
- 이름 노출: `git ls-files -co --exclude-standard | xargs grep -niE '<회사명>|<비교 레포 이름>'` → 0건
- 권한 변경: 탐침으로 시험(CLAUDE.md 라우팅 — 권한 deny 추가 시 필수)
- `pnpm ci:core` · 프론트 `pnpm ci:core` (형제 레포 주입 훅·테스트는 D-007로 삭제)

## 위험 & 롤백
- 문서·설정만 변경 → revert. SELECT 허용은 LOCAL=PROD라 **쓰기 차단이 깨지지 않는지**가 핵심 위험 — 탐침으로 DML·DDL 거부 확인 전 머지 금지

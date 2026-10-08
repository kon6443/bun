# Claude 설정·문서 전수조사 — 결정 로그

> 새 결정은 맨 아래에 추가한다. 기존 항목은 고치지 않고, 뒤집힐 때는 새 항목에 `supersedes D-00N`을 쓴다.

## D-001 — 새 태스크 폴더로 관리, 기존 평면 문서는 쪼개지 않음 (2026-10-07)
- **맥락**: Claude 설정 이력 SSOT는 이미 `docs/tasks/tasks-claude-config.md`(평면)에 있다
- **결정**: 이번 전수조사·추천은 `docs/tasks/claude-config-audit/` 3층 폴더로 만든다. 기존 평면 문서는 손대지 않고 STATUS에서 링크만 한다
- **근거**: 글로벌 `task-folder` 스킬 — "적용 범위: 새로 만드는 문서만. 기존 평면 문서는 그대로 이어 쓴다"
- **버린 대안**: `tasks-claude-config.md`에 절 추가 — 이미 큰 문서이고 다른 세션과 충돌 위험
- **영향**: 없음 (신규 파일만)

## D-002 — 프론트는 next-bun-89 세션에 위임, 결과는 이 세션이 취합 (2026-10-07)
- **맥락**: 사용자 지시 5·6 — 프론트 관점 조사는 프론트 세션이, 사용자 보고는 메인 세션이
- **결정**: `next-bun-89`에 SendMessage로 지시. 프론트 세션은 자기 레포 `docs/tasks/`에 자체 태스크 폴더를 두고, 요약을 이 세션에 회신한다
- **근거**: 사용자 요청 원문 5·6
- **버린 대안**: 이 세션이 `../next-bun`을 직접 조사 — 프론트 세션의 rules·훅 맥락을 잃는다
- **영향**: 프론트 레포 `docs/tasks/` 신규 폴더(프론트 세션 소관)

## D-003 — 설정 파일·커밋 문서에 회사명·타 프로젝트명을 쓰지 않는다 (2026-10-07)
- **맥락**: 사용자 지시(2026-10-07) "설정파일에 회사이름이나 다른 프젝이름이 들어가지 않도록". bun은 공개 저장소(CLAUDE.md Never 표 "Caddyfile 커밋 금지" 근거와 동일)
- **결정**:
  - 대상: `CLAUDE.md`·`.claude/**`(settings·hooks·rules·skills·agents·commands) — 회사명·무관한 타 프로젝트명·개인 절대경로 금지
  - 허용: 짝 레포 `next-bun`(훅 인자·`additionalDirectories`·스킬 이름 등 기능상 필요한 참조)
  - 이 태스크 폴더(커밋 대상 문서)도 같은 기준으로 익명화 — 타 레포는 "비교 레포 B(NestJS)"·"비교 레포 F(Next.js)"로 표기. 실제 경로는 레포 밖(로컬 메모리)에만 둔다
- **근거**: 실측 `git ls-files | xargs grep -niE '<회사명>|<비교 레포 이름>'` → 설정 1건(`.claude/skills/next-bun/SKILL.md:7`) 즉시 제거, 문서 1파일(`tasks-claude-config.md`, 약 20건)은 이력 문서라 추천안으로 분리
- **버린 대안**: git 히스토리 재작성으로 과거 커밋에서도 제거 — 히스토리 재작성 금지 규칙, 사용자 명시 요청 시에만
- **영향**: WORKLOG의 기존 절도 익명화했다(append-only의 예외 — 민감정보 제거 목적). 프론트 세션에도 같은 기준 전달
- **정정**: 에이전트 보고 중 공식 문서와 어긋난 2건 — "`cat .env`가 deny에 안 걸림"(틀림: Read deny는 Bash `cat`·`head`·`tail`·`sed`에도 적용), "`Write(.claude/settings.json)` deny 추가 필요"(불필요: Edit 규칙은 파일을 편집하는 모든 내장 도구에 적용). 출처 code.claude.com/docs/en/permissions

## D-004 — CLAUDE.md에는 수치·날짜·커밋 수·상태값·태스크 ID를 일절 두지 않는다 (2026-10-07)
- **맥락**: 사용자 지시 "클로드엠디파일에 상태값 수치 커밋수 이런거 자체가 들어가면 안 될 것 같다"
- **결정**: CLAUDE.md는 규칙 문장 + 문서 경로만. 근거 수치·날짜는 lessons·태스크 문서에만. **HTML 주석 보관안(추천 B5)도 쓰지 않는다** — supersedes RECOMMENDATIONS B5
- **근거**: 실측으로 CLAUDE.md 커밋 수가 이미 낡아 있었다(WORKLOG S1 절). 공식 memory 문서 "Consistency"
- **버린 대안**: HTML 주석 보관 — 토큰 비용은 0이나 파일 안의 낡는 정보라는 점은 같다
- **영향**: CLAUDE.md 전면 정리. rule 파일의 실측 카운트·줄 번호·날짜도 같은 이유로 제거

## D-005 — 코드 규약을 파일 종류별 rule 7개로 분할 (2026-10-07)
- **맥락**: 사용자 지시 "규칙파일 파일 종류별로 나누는 방식 적용 · 코드패턴 분할·구조화"
- **결정**: `code-patterns.md` 삭제 → `core`(src 전체, rule 지도) · `api-http` · `data-access` · `datetime` · `realtime-ws` · `schema-migrations` · `testing`. CLAUDE.md의 Path Aliases·Date/Time·DB Migrations·Pitfalls는 해당 rule로 이동(SSOT 1곳). 명령어 함정(EPERM·`--testPathPatterns`)은 CLAUDE.md Commands가 SSOT
- **근거**: 모든 glob이 실제 파일과 1개 이상 매칭(`git ls-files ':(glob)…'`). 형제 주입 훅이 rule 파일별 paths를 읽어 분할을 그대로 지원(`inject-sibling-claudemd.sh` 2절). 분할하며 코드 대조로 드리프트 발견·정정: 트랜잭션 위치 수·줄 번호, 스로틀에 로그인 전용 상수(`THROTTLE_AUTH_*`) 누락
- **버린 대안**: 3분할(비교 레포 B 방식) — bun은 WS·스키마·날짜 규약 비중이 커서 더 잘게 나눔
- **영향**: README·architecture·playbook·스킬 `next-bun`의 참조 갱신. 훅 테스트 픽스처 갱신

## D-006 — `pnpm dev`는 현행 유지 (추천 B2 보류) (2026-10-07)
- **맥락**: 사용자 지시 "pnpm dev는 작동 가능하도록 일단 그대로"
- **결정**: ask로 옮기지 않는다. 위험(부팅 = 상용 DB 접속)은 기록만 유지
- **영향**: 없음

## D-007 — `/doctor prompt-audit`는 동일 기준 감사 에이전트로 대체, 사용자 교차 확인 (2026-10-07)
- **맥락**: 내장 명령은 세션이 실행할 수 없다(사용자 입력 전용)
- **결정**: 같은 기준(낡은 지시·없는 참조·상호 모순)으로 감사 에이전트 실행 → 원본 재확인 후 반영. 실제 `/doctor prompt-audit`는 사용자가 돌려 교차 확인
- **영향**: WORKLOG "적용" 절에 결과 기록

## D-008 — D-005 근거 정정: 트랜잭션·QueryBuilder 수치는 낡지 않았다 (2026-10-07)
- **맥락**: D-005 근거에 "트랜잭션 위치 수·줄 번호 드리프트"라고 적었으나, 실측 헬퍼가 출력을 `head -3`으로 잘라 생긴 오판이었다
- **결정**: 정정 — `dataSource.transaction` 4곳(`team.service.ts`·`telegram.service.ts` 각 2), `createQueryBuilder` 5건으로 원 문서가 맞았다. 스로틀 `THROTTLE_AUTH_*` 누락 지적은 유효
- **근거**: `git grep -n 'dataSource.transaction' -- src ':!*.spec.ts' | wc -l` → 4 · `createQueryBuilder` → 5
- **영향**: rule 본문은 개수를 쓰지 않으므로 수정 없음. 교훈은 `docs/lessons.md` 2026-10-07 항목

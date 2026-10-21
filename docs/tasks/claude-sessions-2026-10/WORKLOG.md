# 백·프 2세션 운영 규칙 · Claude 설정 전수조사 · SELECT 허용 — 작업 기록

> append-only. 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 목차를 본다.

## 2026-10-20 — 착수
- 라우팅(CLAUDE.md "Claude 설정·훅·권한 규칙") 따라 `docs/tasks/tasks-claude-config.md` 목차와 `claude-config-audit/STATUS.md` 확인 — 2026-10-08 전수조사·적용 완료(D-001~D-008: 회사명·타 프로젝트명 금지, CLAUDE.md에 상태값 금지, 코드 규약 rule 7개 분할 등). 이번 조사는 그 이후 변경분과 새 요구(세션 운영·SELECT)를 기준으로 한다.
- worktree `bun/.claude/worktrees/claude-sessions`(`chore-onam-claude-sessions`, `origin/develop` `7d56d53`).
- 백엔드 전수조사: Opus 감사 서브에이전트(백엔드 레포만) / 프론트 전수조사: next-bun-6c에 지시(자체 worktree `chore-onam-claude-sessions` 생성 포함)
- 사용자 Q1 답 "기존 계정 + 앱 가드" → D-003

## 2026-10-20 — S4 SELECT 허용 구현 (D-003)
- `src/common/utils/sql-readonly.utils.ts`: `checkReadOnlySql`(문자 스캐너로 주석·리터럴·따옴표 식별자·Oracle `q'[…]'` 제거 → 단일 문장·SELECT/WITH 시작·금지 키워드 단어 경계·`DBMS_`/`UTL_`·리터럴 밖 비ASCII 거부, 닫히지 않은 주석·따옴표 거부) + `redactSensitiveColumns`. spec 33건(허용 9·거부 22·세미콜론 정규화·가림 1).
- `scripts/db-select.ts` + `package.json` `db:select`: guard → oracledb 직접 연결(autoCommit 없음) → `SET TRANSACTION READ ONLY` → 실행(`maxRows` 기본 200·최대 1000, `callTimeout` 30초) → 민감 컬럼 가림 → rollback·close. thick client 초기화는 `migration-datasource.ts`와 같은 조건.
- 검증: 단위 33/33 · `pnpm lint` 0 errors(경고 6, 기존) · scripts 타입체크(임시 tsconfig, rootDir 레포 루트) exit 0. ESLint는 레포 설정상 `src/`만 대상이라 `scripts/`는 루트 `migration-datasource.ts`처럼 범위 밖.
- 글로벌 db-guard 훅이 spec 파일명을 넘긴 eslint 명령을 차단(spec 안의 `drop table` 문자열) — 우회하지 않고 `pnpm lint`(src 전체)로 대체.
- 권한: 프로젝트 `permissions.allow`에 이미 `Bash(pnpm:*)` → 허가 규칙은 불필요. 실제 장벽은 sandbox(`**/.env` 읽기 차단·Oracle 호스트 네트워크 미허용) → `sandbox.excludedCommands: ["pnpm db:select *"]` 추가 diff를 사용자에게 제시(settings.json은 세션 쓰기 차단). `!` 명령은 사용자 셸로 실행돼 sandbox 밖(앞서 스키마 확인 스크립트가 `!`로 DB 접속 성공).
- 러너에 글로벌 db-guard 마커 `claude-db-guard: readonly-runner` 추가 — 훅(2-b)이 "커밋본과 동일·단독 호출·쓰기 SQL 없음"일 때 통과시키는 설계와 맞춤(`pnpm db:select`는 훅 대상 런타임이 아니라 원래 통과).

## 2026-10-20 — S1 백엔드 Claude 설정 전수조사 (Opus 감사 에이전트, 읽기 전용)
| ID | 심각도 | 위치 | 문제 | 수정안 |
|---|---|---|---|---|
| A1 | high | `.claude/settings.json` deny | `./node_modules/.bin/tsx node_modules/typeorm/cli.js migration:run`이 allow(`./node_modules/.bin/tsx:*`)엔 걸리고 deny(`tsx node_modules/…`)엔 안 걸림. 글로벌 db-guard RUNTIMES도 경로 접두 실행어 미인식 | deny에 `Bash(./node_modules/.bin/tsx *typeorm*)`(+ `npx tsx`) — 탐침 필요(존재하지 않는 하위명령) |
| A2 | high | settings allow `tsx:*`·`node:*`·`python:*` + 글로벌 db-guard DB_CONN | ESM `import oracledb` + `getConnection` + `ORACLE_DB_*`는 DB_CONN에 안 걸림 → 임의 DB 스크립트가 프롬프트 없이 실행 가능 | 글로벌 db-guard DB_CONN 보강 diff(사용자 적용) — 탐침은 DB에 붙지 않는 더미 |
| A3 | medium | README "deny로 기술적 차단" vs CLAUDE.md "deny는 스크립트 내부 연결 못 막음" | 서술 충돌 | README를 CLAUDE.md 쪽으로 |
| A4 | medium | CLAUDE.md Never(DB 접속 전부) vs `pnpm dev` 권장·allow(claude-config-audit D-006) | 예외 미명시 | Never 행에 예외 명시(`pnpm dev`·`pnpm db:select`) |
| A5 | medium | README CI 서술 | "CI는 lint·test·E2E 안 함, main push 무검증 배포" — 현행은 PR CI(ci:core+E2E)·배포 `needs: ci` | 갱신 |
| A6 | medium | README 테스트 기준선(2026-09-23) | 이후 채팅·태그 spec 추가로 낡음 | 재측정 또는 태스크 문서로 |
| A7 | low | README 테이블·모듈·WS 목록 | 채팅·태그 테이블, `/fishing` 누락 | 보강 |
| A8 | low | CLAUDE.md 라우팅 표 | 팀 태그 행 없음 | 추가 |
| S1 | high | `.claude/skills/next-bun/SKILL.md` | 메인이 프론트 CLAUDE.md·rules를 직접 읽고 grep, 명시 요청 시 프론트 수정 허용 | 계약 접점 표만, 조사·수정은 프론트 세션에 요청 |
| S2 | high | `.claude/agents/frontend-researcher.md` | 메인의 서브에이전트가 프론트 파일 직접 읽기 — 2026-10-20 교정과 같은 양상 | 폐기 또는 "프론트 세션 없음 + 사용자 승인" 한정 |
| S3 | high | `.claude/skills/review-flow/SKILL.md` | 백·프 전체 grep·프론트 build까지 메인이 수행 | 프론트 단계는 프론트 세션 위임, dev 중 build 금지 |
| S4 | medium | CLAUDE.md | 2세션 운영 규칙 없음, 일부 문장이 메인의 프론트 직접 조작 전제 | 세션 운영 절 추가 |
| S5 | low | `api-http.md`·`realtime-ws.md`·playbook | "프론트 사용처 grep" 지시가 메인 직접 행위로 읽힘 | "프론트 세션에 확인 요청" |
| W1 | medium | `.claude/hooks/inject-sibling-claudemd.sh`·테스트 | `$BASE/../next-bun` 계산이 worktree 안에서 없는 경로 → 테스트 C2-5가 조용히 SKIP | 탐침 필요(worktree 세션의 `CLAUDE_PROJECT_DIR`) |
| W2 | low | `precompact.sh` | 핸드오프가 cwd(worktree) 아래 저장 → worktree 삭제 시 소실 | 저장 위치 명시 |
| P1 | medium | settings `pnpm:*` vs CLAUDE.md Ask "새 의존성" | `pnpm add`가 프롬프트 없이 실행 | ask에 `Bash(pnpm add*)`·`Bash(pnpm install *)` |
| D1 | medium | `docs/tasks/team-chat-persistence/WORKLOG.md` | 타 프로젝트명 1건(claude-config-audit D-003) | 익명화 |
| D2 | low | CLAUDE.md 제목·Commands | 버전·포트 수치(D-004) | 제거·README 링크 |
| C1 | low | 여러 곳 | `db:migrate:fake`·ORA_SDTZ·E2E AppModule·`--testPathPatterns`·스로틀·replicas 중복 서술 | SSOT 한 곳 + 링크 |
| C2 | low | `docs/lessons.md` 머리말 | "append" vs "위에 최신순" vs 하단 주석 "이 줄 위" 모순 | 문구 통일 |
| C3 | nit | `precompact.sh` 주석 | matcher `"*"` 서술이 settings와 다름 | 정정 |
- rules `paths:` 7개 모두 실제 파일과 매칭, 참조 경로 실존, pnpm 10 서술 정상.
- DB 차단 장치 목록(SELECT 허용 설계 근거): CLAUDE.md Never(전부·행동 규칙) / testing.md·E2E `forbid-db.ts`(드라이버 차단, E2E만) / settings deny(migrate up·fake·revert·list, typeorm run·revert·show, `sqlplus*`, `sql *`) / settings allow `pnpm:*`·`tsx:*`·`node:*`(구멍 A1·A2) / 글로벌 db-guard(런타임 경유: 쓰기+접속 deny, 접속만 ask, 신뢰 러너 통과) / 글로벌 CLAUDE.md(쓰기만 금지 — 프로젝트가 우선) / `claude-config-audit` RECOMMENDATIONS "DB 조회 스크립트 제외" 결정 → D-003이 대체.

## 2026-10-20 — S2 프론트 Claude 설정 전수조사 (next-bun-6c 보고, 읽기 전용)
- worktree `next-bun/.claude/worktrees/claude-sessions`(`chore-onam-claude-sessions` = origin/develop `8b2a330`). Opus 서브에이전트 2(A: CLAUDE.md·README·settings·rules·docs / B: agents·skills·hooks·세션 운영), 결론 값은 원본 재확인.
- 정상: 문서가 가리키는 경로 30개 존재, rules 6개 paths 매칭, 스크립트·pnpm 10·Node 24 일치, 회사명·타 프로젝트명·도메인·IP 0건, 훅 테스트 30/30(단 C2-5 worktree에서 미집계).
| ID | 심각도 | 위치 | 문제 | 수정안 |
|---|---|---|---|---|
| F-01 | high | `skills/bun/SKILL.md` | 프론트 세션의 백엔드 수정 허용·사용자 직접 보고·backend-researcher 위임·백엔드 CLAUDE.md/rules 직접 Read | 계약 요지 캐시 + 메인 질의 양식으로 전환 |
| F-02 | high | `agents/backend-researcher.md` | 전체가 `../bun` 직접 읽기, 자동 위임 | 삭제(백엔드 쪽 frontend-researcher·next-bun 스킬과 대칭 결정) |
| F-03 | high | `hooks/inject-sibling-claudemd.sh` | `$CLAUDE_PROJECT_DIR/../bun` 기준 — worktree 세션에선 형제를 못 찾고 조용히 exit 0 | (a)면 등록 해제, 유지 시 git common dir 기준 + 경고 |
| F-04 | medium | 훅 테스트 C2-5 | 형제 없으면 조용히 continue | SKIP 출력 |
| F-05 | medium | CLAUDE.md·rules·skill·agents의 `../bun` 상대경로 | worktree cwd에서 안 열림, `Read ../bun/CLAUDE.md`는 Read 도구 형식에도 안 맞음 | (a)면 삭제·메인 질의 |
| F-06 | medium | settings `additionalDirectories: ["../bun"]` | worktree 해석 기준 미확인 + 백엔드 쓰기 경로까지 엶 | (a)면 제거(사용자 적용) |
| F-07 | medium | settings 훅 등록(PreToolUse·SessionStart) | 백엔드 규약 수천 자 주입 + "사용자에게 묻는다"·"사용자 승인" 문구 혼입 | (a)면 등록 제거 |
| F-08 | medium | `agents/review-front.md` | 리뷰어가 `../bun`까지 grep, :3과 자기모순 | 프론트로 한정, 백엔드 영향은 "메인 확인 필요" |
| F-09 | medium | CLAUDE.md 백엔드 레포 절·Ask·`rules/services.md` | 승인을 누구에게 받는지 불명(사용자 직접으로 읽힘) | "승인·질의는 메인 경유" + 세션 절 |
| F-10 | medium | settings ask ↔ CLAUDE.md Ask·Never | 커밋·푸시·머지·docker·삭제가 설정에 없음(ask는 ssh·scp·redis-cli뿐) | ask에 git commit·push·merge·docker(rm은 문서만) |
| F-11 | low | Never `pnpm test`(watch) | deny 없음 | `Bash(pnpm test)` 정확 일치 deny 또는 문서만 명시 |
| F-12 | low | settings ask scp·redis-cli | 문서 Ask에 없음 | 문서 보강 |
| F-13 | low | deny `Edit(.claude/settings.json)`만 | Write 덮어쓰기 미차단 | `Write(.claude/settings.json)` (백엔드도 대조) |
| F-14 | low | 커밋 리마인더 훅 ↔ DoD | DoD에 typecheck 없음 | DoD 1번에 `pnpm typecheck` |
| F-15 | low | CLAUDE.md Never·Ask | 커밋·푸시 이중 등재 | 한 등급 |
| F-16 | low | CLAUDE.md 상단 | Node·pnpm 버전 수치 | README로 |
| F-17 | low | README :20·:14 | 규약 문장 중복(auth.md), docs 설명이 문서 경계와 불일치 | 삭제·문구 수정 |
| F-18 | low | rules services·socket ↔ bun 스킬 | 계약 값 복제(현재 값은 정확) | 의도된 캐시로 명시, rules는 표 참조 일원화 |
| F-19 | low | `rules/socket.md` | 근거 경로가 백엔드 현재 체크아웃 브랜치엔 없음(develop엔 있음) | (a) 정리 때 표기만 |
| F-20 | nit | socket.md·훅 주석 | 리뷰 ID·날짜 | 문서 경로만 |
| F-21 | nit | tests.md·CLAUDE.md | 글로벌 규칙·README와 중복 | 삭제·README 링크 |
| F-22 | nit | `docs/KAKAO_LOGIN_ISSUE.md` | 고아 문서, 미체크 3항목 | archive 이동·삭제 검토 |
| F-23 | nit | `.gitignore` | `.claude/worktrees/`가 `.git/info/exclude`로만 제외 | .gitignore 추가 |
- 범위 밖: 사용자 auto memory(프론트 프로젝트) "Runtime: Bun"·"Dockerfile: Bun 기반" 낡음 — 쓰기 차단, 사용자 확인 대상.
- 프론트 권장: (a) 프론트 세션은 백엔드 코드를 읽지 않는다(D-001 문자 그대로, 현행 교차 장치는 worktree에서 이미 조용히 고장), 메인 답변은 `파일:라인 + 인용`, 정확성 책임은 메인.

## 2026-10-20 — 권한 변경안(D-005) 정리
- 프론트 초안(next-bun-6c, 적용 안 함, diff는 그 세션 scratchpad `settings-perm-draft.diff`): allow 읽기(git rev-parse·ls-files·ls-remote·worktree list·blame·grep·check-ignore·merge-base, gh run watch, rg·pwd·which·stat·file·tree·realpath·cut·tr, `pnpm install --frozen-lockfile`, `docker:*`) / deny(`Write(.claude/settings.json)`, settings.local.json Edit·Write, `pnpm test`·`npm test`·`pnpm vitest`·`npx vitest` 정확 일치) / ask(git commit·push·merge·rebase·tag·stash·cherry-pick·revert·worktree remove, gh pr create·merge·close·edit·comment·review·issue·workflow run·run rerun·cancel·api, pnpm add·remove·update·install(정확)·i·dlx 등, npm·yarn 동등, docker 원격·운영·대량 삭제).
- **우선순위 점검으로 드러난 제약**: 규칙은 범위와 무관하게 deny > ask > allow. ① 글로벌 ask에 `Bash(docker *)`가 있어 프로젝트 allow로는 docker를 풀 수 없다 → 글로벌에서 빼고 원격·운영 docker ask를 둬야 함(글로벌 = 다른 프로젝트에도 적용). ② `pnpm install*`를 ask에 두면 `--frozen-lockfile` 예외를 allow로 못 만든다 → ask는 `pnpm install`(정확)·`pnpm i`·`--no-frozen-lockfile*`·`--fix-lockfile*`만. 백엔드 안도 같은 기준으로 수정.
- 미확인(탐침 필요): 복합·래핑 명령(`cd x && git push`, `env VAR=… docker`, `sh -c`)의 매칭, 상대 경로 패턴(`Edit(.claude/settings.json)`)의 기준점, docker 소켓의 sandbox 차단.

## 2026-10-20 — 백엔드 적용 (S3·S5, 메인)
- `CLAUDE.md`: "세션 운영" 절 신설(메인·역할 경계·메인의 몫·세션 찾기는 STATUS 표→사용자 질문·없으면 새 세션 요청·소통) / 자동 로드에서 형제 레포 주입 줄 삭제, 스킬 `next-bun` 설명 교체 / 라우팅: Claude 설정 행에 이 태스크 STATUS 추가, 팀 태그 행 추가(A8), handoff 행에 worktree 저장 위치 주의(W2) / Never DB 행에 예외 2개(① `pnpm db:select` ② `pnpm dev` — A4·D-003) / Never의 "무지시 commit·push"를 Ask 커밋 행으로 합침(F-15와 같은 중복) / Ask docker 행을 원격·운영만으로(D-005) / API 계약 행 "프론트 세션에 확인" / Commands: jest·포트 수치 제거(D2), `pnpm db:select` 추가 / 제목 줄 NestJS 버전 제거(README 링크).
- `.claude/skills/next-bun/SKILL.md`: 프론트 Read·grep·수정 허용·frontend-researcher 위임 제거 → 프론트 세션 질의 양식 + 세션 찾기 + 계약 산출물(Swagger)만 직접 + 계약 접점(백엔드 SSOT만, 프론트 사용처 사본 없음 — D-004) (S1).
- `.claude/skills/review-flow/SKILL.md`: 백엔드만 읽기, 프론트 대조는 프론트 세션 질의, 프론트 검증은 프론트 세션, dev 중 build 금지 (S3).
- 삭제(D-007, 사용자 "전부 추천대로"): `.claude/agents/frontend-researcher.md`(S2), `.claude/hooks/inject-sibling-claudemd.sh`·`test-inject-sibling-claudemd.sh`(W1·F-03·F-04). 등록 해제는 settings diff.
- rules·playbook: `api-http.md`·`realtime-ws.md`·`recurring-issues-playbook.md`의 "프론트 grep/확인"을 "프론트 세션에 질의"로(S5).
- `README.md`: 프로젝트 맵 프론트 행(낡은 "Bun" 제거), WS namespace에 `/fishing`, team 모듈에 채팅·태그, 주요 테이블 4개 추가(A7), 로컬 Redis 포트 충돌·NOAUTH 안내, CI 게이트 현행화(A5 — `ci.yml` PR·`workflow_call`, 배포 `needs: ci`), 기준선 재측정(A6 — 2026-10-20: lint 경고 6·스텁 0·단위 843/843(38 스위트)·E2E 117 통과·2 skip·build ✅), `pnpm db:select` 명령, DB 절 "deny로 기술적 차단" 정정(A3), AI 가이드 2단계 문구.
- `docs/lessons.md` 머리말·하단 주석 모순 정리(C2), `.claude/hooks/precompact.sh` matcher 주석 정정 + 저장 위치 주석(C3·W2), `docs/tasks/team-chat-persistence/WORKLOG.md` 타 프로젝트명 익명화(D1).
- 후속(C1 문서 중복): `db:migrate:fake`·ORA_SDTZ·E2E AppModule·`--testPathPatterns`·스로틀·replicas가 README(사람용)·CLAUDE.md·rules에 겹침 — README는 사람이 처음 보는 사실 문서라 핵심 경고를 의도적으로 두고, 정리는 claude-config-audit 후속 "문서 중복"과 묶어 별건.
- settings diff(사용자 적용): 세션 scratchpad `bun-settings.diff`(→ `bun-settings.proposed.json`) — `additionalDirectories`·`Read(../next-bun/**)` 제거, 주입 훅 등록(PreToolUse·SessionStart) 제거, allow 읽기 보강·`pnpm install --frozen-lockfile`, ask에서 `docker *` 제거(D-009) + git·gh·pnpm/npm/yarn 쓰기 추가, deny에 typeorm 경로 접두 실행(A1)·settings Write·settings.local Edit/Write, `sandbox.excludedCommands: ["pnpm db:select *"]`.

## 2026-10-20 — S4 SELECT 탐침 (메인)
- sandbox 안에서는 `tsx`가 IPC 파이프 `listen`에 EPERM → `pnpm db:select`는 sandbox 밖 실행이 필수(= `sandbox.excludedCommands` 근거 재확인).
- 가드 거부(DB 접속 전 종료, exit 2) 5/5: `DELETE …`(SELECT/WITH 아님) · `SELECT …; DROP …`(다중 문장) · `… FOR UPDATE`(UPDATE 키워드) · `BEGIN NULL; END;`(다중 문장) · `DBMS_LOCK.SLEEP`(내장 패키지).
- 실제 조회(worktree에 `.env` 심볼릭 링크 — gitignore): `SELECT COUNT(*) … TEAM_TAGS` 정상 · `DISCORD_WEBHOOK_URL` 값 `[REDACTED]` · `--max-rows=3 --json`에서 상한 잘림 안내 정상.
- 남은 탐침(사용자 실행 — 쓰기 시도라 AI 금지): READ ONLY 2차 방어선 — 세션 scratchpad `readonly-probe.ts`(`UPDATE … WHERE 1 = 0` → 기대 ORA-01456, 끝에 rollback).
- READ ONLY 2차 방어선 탐침(사용자 `!` 실행, 2026-10-20): `UPDATE TEAM_TAGS … WHERE 1 = 0` → **✅ ORA-01456** — 가드를 우회한 쓰기도 READ ONLY 트랜잭션이 거부. (1차 실행은 탐침 스크립트가 scratchpad에서 의존성을 못 찾아 실패 → worktree 기준 `createRequire`로 수정 후 재실행.) D-003 머지 전 차단 조건 중 탐침 충족, 남은 것은 settings 적용 후 "허가 프롬프트 없이 실행" 확인.

## 2026-10-20 — 프론트 적용 보고 (next-bun-6c)
- 프론트 세션은 **Claude 설정(CLAUDE.md·`.claude/**`)을 다른 세션 요청만으로 고치지 않는다**는 자기 세션 규칙에 따라, 설정 변경 전부를 패치로 만들고 적용하지 않았다(사용자 직접 `git apply` 또는 사용자가 그 세션에 직접 지시). 패치: 프론트 세션 scratchpad `claude-sessions-front.patch`(11파일 +96 −454, `git apply --check` OK) · settings만 `claude-sessions-front-settings.diff`.
  - CLAUDE.md: 세션 운영 절(메인 초안 그대로 + 질의 양식 1줄), 자동 로드의 훅·bun 스킬 줄 삭제, 라우팅 정리, "백엔드 레포" 절 삭제, Ask "메인을 거친 사용자 승인"·이중 등재 정리·scp/redis-cli, 버전 수치 제거, Commands README SSOT, DoD에 typecheck.
  - 삭제: `agents/backend-researcher.md`, 훅 2개, **`skills/bun/SKILL.md`(질의 양식으로 바꾸면 3줄뿐이라 CLAUDE.md 세션 절로 대체 — 삭제 제안)**. review-front 백엔드 grep 제거, rules services·socket·auth·tests 정리.
  - settings: allow 20 · deny 32 · ask 45, additionalDirectories·주입 훅 등록 제거, git commit 리마인더 훅 유지, docker 항목 없음(D-009).
- 직접 적용(설정 아님, 미커밋): README(F-17 등), `.gitignore`에 `.claude/worktrees/`(F-23), `docs/KAKAO_LOGIN_ISSUE.md` → `docs/archive/`(F-22, 이동만).
- 메인 확인: 패치·settings diff·README/.gitignore 추가 줄의 회사명·타 프로젝트명·IP 패턴 0건, 백엔드 변경 추가 줄도 0건.
- 백엔드와 짝 맞춤: 주입 훅·상대 레포 조사 에이전트 양쪽 삭제 ✅, 백엔드 `next-bun` 스킬은 계약 접점 표(백엔드 SSOT 경로)가 남아 있어 질의 양식 스킬로 유지(프론트 `bun` 스킬은 남길 내용이 없어 삭제 — 비대칭이지만 각 레포 사정), git·gh·패키지 ask 양쪽 동일 ✅.

## 2026-10-20 — 글로벌 설정 결과 수신 (claude-config-7a, D-009)
- ① docker: 글로벌 ask `Bash(docker *)` 제거 → 원격·운영·대량 삭제 18패턴(stack·service·swarm·node·context·push·login*·secret·config, `-H*`·`--host*`·`--context*`·`* --context*`·`* -H *`, `DOCKER_HOST=*`·`DOCKER_CONTEXT=*`, `* prune*`, `volume rm*`)만 ask. 글로벌 allow에는 docker 없음 → **프로젝트 allow 필요(D-010)**.
- ② db-guard: RUNTIMES 경로 접두 허용, DB_CONN에 ESM `import … oracledb`(+mssql·tedious·better-sqlite3·pg)·`getConnection`·`ORACLE_DB_` 추가, 테스트 8건(수정 전 6건 실패 재현) → 90/90. dotfiles `ft-work` `583798e` push, main 머지 전.
- 주의(그 세션 보고): 읽기 전용 러너 통과는 **경로 없는 런타임**(`tsx scripts/db-select.ts`) 호출일 때만 — `./node_modules/.bin/tsx …`는 이제 ask. 우리 사용 경로 `pnpm db:select`는 db-guard 대상 런타임이 아니라 영향 없음. 러너는 HEAD blob과 같아야 통과(커밋 후).
- D-010 백엔드 적용: 사용자가 `bun-settings.docker.json` cp 적용 (allow73, JSON 유효 확인).

## 2026-10-20 — 백엔드 리뷰 1회차 (Opus 서브에이전트, 글로벌 /review 절차)
- 실행: lint 0err/6warn, 단위 843/843, scripts 타입체크 0, 가드 순수 함수 탐침(DB 접속 없음). `git fetch`는 원격 권한 오류로 로컬 `origin/develop` 기준.
- 지적과 조치(메인 교차검증):
  - D1 중 — `stripLiteralsAndComments`가 `Nq'…'`(국가 문자셋 대체 인용)을 일반 따옴표로 처리 → Oracle이 코드로 읽는 구간을 문자열로 지워 `DBMS_`·`UTL_`·`FOR UPDATE` 거부 우회. **수정**: `startsAltQuote()`로 단어 경계 뒤 `N`/`n` 접두 인정, spec 3건 추가(허용 1·거부 2) → 36/36.
  - D2 중 — `pnpm install <pkg>` ask 누락 / D3 중하 — typeorm pnpm 경유 실행 deny 누락 → **D-011** settings diff(사용자 적용).
  - D4 하 — docker allow 미반영 → 리뷰 도중 사용자가 D-010 적용(allow73) — 해소.
  - D5 하 — `docs/lessons.md`의 삭제된 주입 훅 현재형 서술 → 과거형 + D-007 경로.
  - D6 하 — `team-chat-persistence/WORKLOG.md` 타 프로젝트명 1건 → "다른 프로젝트 서버"로 익명화(과거 커밋 이력에는 남음).
- 수정 후 `pnpm ci:core` exit 0: lint 0err/6warn, 단위 846/846(38), build ✅. README 기준선 846으로 갱신.
- 미확인(DB 접속 금지): `Nq` 실제 파싱, DB 내 autonomous transaction 함수 존재, READ ONLY에서 NEXTVAL 동작, `excludedCommands`의 복합 명령 처리 / 후속: 민감 컬럼 가림이 별칭(`AS x`)에 약함.
- D-011 백엔드 적용: 사용자가 `bun-settings.d2d3.json` cp 적용 (allow72·ask48·deny87, JSON 유효 확인).

## 2026-10-20 — 백엔드 리뷰 2회차 · 프론트 리뷰 1·2R 결과
- 백엔드 2회차(Opus): D1 `Nq` 4변형·오탐·D-011 패턴 판정 통과. **R2-1 낮음** — `startsAltQuote()` 경계가 JS `\w`라 Oracle 식별자 문자 `$`·`#`과 숫자 뒤 `q'`에서 가드·Oracle의 따옴표 범위가 어긋남(`x$q'…'`·`x#q'…'`·`1q'…'` 통과). **수정**: 경계 `/[\w$#]/` + 경계 밖 `q'`는 fail-closed(거부), spec 3건 → `pnpm ci:core` exit 0, lint 0err/6warn, 단위 849/849(38), build ✅, README 849.
- 프론트(next-bun-6c 보고): ci:core exit 0(lint 0·typecheck 0·360/360·build 36). 1R 확정 2건 직접 수정(docs/archive/KAKAO_LOGIN_ISSUE.md 깨진 링크·백엔드 문서 유도 → 메인 질의 문구, README 없는 skills 안내 삭제) + docs/swagger_info.md에 docs-json 주소. 2R: docker `-c` 단축형·pnpm install 구멍 → 패치 `claude-sessions-front-r2.patch`(프론트 scratchpad, 앞선 docker 패치 대체). docker 폭은 사용자 결정 → **D-012**.
- 프론트 후속(범위 밖): src/lib/auth.ts:73·src/app/utils/tagUtils.ts:4 백엔드 문서 참조 주석, kakao-login-latency-front.md:3·claude-config-audit/STATUS.md:5,48 현재형, vitest watch 변형, 경로 패턴 cwd 기준 탐침.
- 참고: 프론트가 "백엔드 CLAUDE.md는 docker 전체 Ask"라 했으나 worktree CLAUDE.md:80은 "원격·운영 docker만 Ask, 로컬 테스트용은 확인 없이" — 원래 체크아웃(머지 전) 기준으로 읽은 것으로 보임. D-012 후 문구 수정 필요.
- 프론트 r3 패치(`claude-sessions-front-r3.patch`, r2·docker 패치 대체, apply --check OK, allow31·deny35·ask47) 수신. `-c` 지적을 백엔드 d012 제안에도 반영(allow81·ask50·deny87).
- D-012 백엔드 적용: 사용자가 `bun-settings.d012.json` cp 적용 (allow81·ask50·deny87, JSON 유효 확인).

## 2026-10-20 — 백엔드 리뷰 3회차
- R2-1 수정: 지적 없음 — 정상 SELECT 16건(`colq='x'` 포함) 통과, 대체 인용 분기는 `q` 바로 뒤가 `'`일 때만 진입. 단위 39/39(sql-readonly).
- R3-1 보통 — docker build의 컨텍스트 읽기·`-o` 쓰기 우회 → **D-013**. R3-2 낮음 — fail-closed 거부 사유가 "닫히지 않은 따옴표"로만 나옴 → 사유 문구 확장. R3-3 낮음 — CLAUDE.md docker 행에 version·info·`-c`/`--context` 누락 → 반영(+ build 제외).
- 수정 후 `pnpm ci:core` exit 0: lint 0err/6warn, 단위 849/849(38), build ✅.
- 미확인: sandbox 밖으로 도는 Bash에도 allow 자동 승인이 적용되는지(하네스 동작), `docker inspect`·`logs`가 컨테이너 env 시크릿을 응답에 노출할 가능성(읽기 허용의 잔여 위험, 기록만).
- 글로벌 후속(claude-config-7a, ft-work `78e89f8` push, main 머지 전): db-guard ESM 드라이버 판정을 줄머리 import/export·`import("…")`·`getConnection(` 호출 형태로 좁혀 회귀 제거(95/95). docker 글로벌 ask 18→36(`-c`, image push·`--push`·manifest·buildx imagetools·compose push, `compose down -v`, `rm … $(…)`, `--privileged`·`-v /:`·docker.sock, `DOCKER_*` export). 로컬 docker는 글로벌 ask 없음 → 프로젝트 allow(D-012·D-013)가 결정. 탐침 요청: 새 세션에서 `docker ps` 통과 / `docker --context x ps` ask / `docker rm -f $(docker ps -aq)` ask.
- 프론트 r3 패치 사용자 적용(git apply 성공). D-013 보정은 r4 증분 패치로 요청.
- 프론트 r4(`claude-sessions-front-r4.patch`, D-013 반영, allow29·deny35·ask47)는 "r3 미적용" 판단 기준으로 만들어져 사용자 r3 적용과 엇갈림 → 프론트 세션에 재확인·증분 패치 요청. 프론트 참고: `docker inspect`·`logs`가 컨테이너 env·로그의 시크릿을 컨텍스트로 가져올 수 있음(사용자 결정 대기, 현재 유지).
- 프론트 재확인: r3 적용 상태 확인(allow31·deny35·ask47). r4를 증분 패치로 재작성(같은 경로 덮어씀, settings −2·CLAUDE.md 1줄, apply --check OK, 적용 후 allow29·deny35·ask47).
- D-013 백엔드 적용: 사용자가 `bun-settings.r31.json` cp 적용 (allow79·ask50·deny87, JSON 유효 확인).
- 프론트 r4(증분) 사용자 적용(git apply 성공). 적용 대기 변경 0건 — 남은 것은 커밋·머지 지시와 머지 후 새 세션 권한 탐침.

## 2026-10-20 — 최종 리뷰 루프 (사용자 지시 "늘 하던대로")
- 프론트(next-bun-6c) R1: review-front + /review(Opus), r4 적용 15파일, 확정 0 → 루프 종료, 대기 패치 0. ci:core exit 0(lint 0·typecheck 0·360/360·build 36/36).
- 프론트 PLAUSIBLE(한쪽만, 미확정 — 머지 후 탐침 권장): ① 앞쪽 전역 플래그로 ask/deny 우회(`pnpm -w add`·`pnpm --filter x add`·`pnpm -C . install`·`pnpm -s test`) — 백엔드 settings에도 같은 구조 ② allow 읽기 명령의 실행·쓰기 플래그(`rg --pre`·`git ls-remote --upload-pack`·`git grep -O`·`tree -o`) ③ auto mode에서는 미매칭 docker가 분류기 판단 ④ test 별칭(`npm run test`·`npm test *`·`pnpm t`·`npm t`) deny 누락 ⑤ 프론트 CLAUDE.md "백엔드 소스" 범위 모호 ⑥ 프론트 README `pnpm test` 표기 ⑦ rules/tests.md 삭제 줄 기록. 참고: docker 조회도 sandbox 안에선 docker.sock 차단으로 실패 → sandbox 밖 승인 필요.
- 백엔드 최종 리뷰 R1(리뷰어 A=review-flow, B=/review, Opus): 교차 확정·조치
  - 코드: 따옴표 식별자 패키지명 우회(`"DBMS_LOCK".SLEEP`, A-1·B 공통) → 따옴표 식별자가 패키지명이면 남겨 검사. `HTTPURITYPE`·`DBURITYPE`·`XDBURITYPE`(B-1) → 금지 패턴 추가. JSDoc 위치(B-6). spec +3 → 42.
  - 러너 무결성(A-3·B-2) → **D-014**. 문서: STATUS 결정 요약·체크리스트(A-4), 옛 태스크 문서 머리말 폐기 표시(A-5), lessons 4필드(A-6·B-3), db:select 따옴표 안내(A-10), 기준선 852(B-4), D-003 보정(B-5).
  - settings 일괄 대기(`bun-settings.final.json`, allow79·ask60·deny99): yarn 경유 마이그레이션 deny(A-2), `pnpm *` 앞 플래그 경유 typeorm deny·add/install ask(A-9·프론트 PLAUSIBLE ①), docker `--context`·`-H` ask(A-7), `find -delete/-exec/-execdir` ask(A-8), `npm add` ask(A-9), 러너·가드 Edit/Write deny(D-014). `pnpm * i *`·`pnpm * remove *`는 `pnpm db:select` SQL 본문(별칭 `i` 등)과 충돌해 제외.
  - 수정 후 `pnpm ci:core` exit 0: lint 0err/6warn, 단위 852/852(38), build ✅.
- 프론트 r5 패치(`claude-sessions-front-r5.patch`, 미적용, ask+12·deny+13 → allow29·deny48·ask59): 같은 구멍 + test 별칭·yarn 변형 deny. env 접두 원격 docker(`DOCKER_HOST=*`·`DOCKER_CONTEXT=*`)는 양쪽 프로젝트 ask에 추가하기로(백엔드 final 제안 ask62).
- 프론트 r5 갱신(DOCKER env 접두 ask 2줄): 적용 후 allow29·deny48·ask61, apply --check OK, 미적용.
- 백엔드 최종 리뷰 R2(Opus): 가드·settings 판정 지적 없음(spec 42/42, 탐침 23건). low 2건(STATUS D-014·S4 수치·다음 할 일에 일괄 적용 누락) → 반영. info(yarn 앞 플래그 typeorm 변형) → deny 2줄 추가(final: allow79·ask62·deny101). CLAUDE.md docker 행에 `-H`·`DOCKER_HOST`/`DOCKER_CONTEXT` 접두 명시.
- 실동작 확인(메인, sandbox 밖, CLAUDE.md 예외): `pnpm db:select "SELECT COUNT(*) AS CNT FROM TEAM_TAGS"` → 1행 정상 / `HTTPURITYPE(…)`·`"DBMS_LOCK".SLEEP` → 가드 거부(exit 2, DB 연결 전). 민감 컬럼 가림 재확인은 auto mode 분류기가 민감 컬럼 조회 준비를 막아 생략 — 가림은 S4 실측 ✅ 인용.
- 백엔드 최종 리뷰 R3(Opus, 확인 전용): **지적 없음** → 백엔드 리뷰 루프 종료. 참고: 리뷰어의 `python3 -c`(DB 접속 코드 없음)가 글로벌 db-guard에 "drop table" 근거로 차단 — 메인도 같은 오탐 2회(파일 경로에 SQL 키워드 든 spec이 걸린 명령). claude-config-7a에 전달.
- 백엔드 final settings 사용자 적용(allow79·ask62·deny101, JSON 유효 확인).
- 프론트 r5 사용자 적용(git apply 성공). 적용 대기 변경 0건 — 남은 것: 커밋·머지 지시, 머지 후 새 세션 탐침.

## 2026-10-20 — 머지 전 최종 리뷰 (사용자 지시 "늘 하던대로 → 문제 없으면 커밋·머지")
- 백엔드 A(review-flow)·B(/review), Opus, 각자 `pnpm ci:core` exit 0(852/852). 교차 확정 1: **`--` 줄 주석이 CR 단독 줄바꿈에서 안 끝나** 주석 뒤 `DBMS_LOCK.SLEEP`·`FOR UPDATE`가 통과(두 리뷰어 독립 탐침). A 단독 I-2: 러너가 `process.exit()`로 끝나 파이프 stdout이 64KB에서 잘림(탐침 재현). B 단독: STATUS 수치 낡음 → 반영.
- 가드·러너는 D-014 deny 대상이라 메인이 직접 고치지 않고 패치 작성(`guardfix.patch`: 줄 주석 `[\r\n]` 종료, `process.exitCode`, spec +2). scratch 복사본에 적용해 sql-readonly 44/44, tsc(src+scripts) 0.
- 프론트 R1: 교차 확정 2(의존성 변경 별칭·앞 플래그 변형 ask 누락, CLAUDE.md docker 문구 `-H`·DOCKER_* 누락) + 실측 확정 `pnpm it` → r6. 백엔드도 같은 구멍 → **D-015**.
- 사용자가 `guardfix.patch` 적용. `pnpm ci:core` exit 0: lint 0err/6warn, 단위 854/854(38), build ✅. README 기준선 854.
- 백엔드 settings final2 사용자 적용(allow79·ask87·deny101).
- 프론트 r6 사용자 적용. 실동작(메인, sandbox 밖): exitCode 변경 후 `pnpm db:select … --json | tail` 2.6초에 정상 종료(hang 없음) · 줄 주석 뒤 `FOR UPDATE` 거부 확인.
- 글로벌(claude-config-7a): db-guard 오차단 3건 원인(PR #19 시그니처 확장으로 명령 내 모든 .ts/.py 스캔이 deny로 격상된 회귀) 수정·main 머지(PR #20, 9822760, 98/98) — 런타임으로 시작하는 조각의 파일만 스캔. 남은 한계: heredoc 등 명령 본문 텍스트는 여전히 스캔 → PR 본문은 `--body-file`로. docker build 우회는 그쪽 사용자 판단 대기.
- 머지 전 리뷰 2R: 백엔드 R2-1 High — 1R의 "CR에서 줄 주석 종료"가 반대 방향 우회를 만듦(`--\r'\n … DBMS_LOCK … --'` 통과). Oracle의 CR 처리 미확인이라 어느 쪽 종료도 안전하지 않음 → **CR 단독 줄바꿈 입력 자체를 거부**(fail-closed), 줄 주석은 `\n` 종료로 복귀, spec +3(CRLF 허용 1·거부 2) → `guardfix2.patch`(scratch 복사본 47/47·tsc 0·eslint 0). R2-2 STATUS 수치 → 반영. 참고: 앞 실동작의 "FOR UPDATE 거부"는 `\n` 입력에 대한 가드 거부(사유 "조회 외 동작 키워드(UPDATE)")였다.
- 프론트 2R: npm 설치·테스트 별칭(`npm in/ins/isnt*/ic/clean-install/it/cit/sit`, `pnpm -C . it`) 우회 교차 확정 → r7. 백엔드 동일 → `bun-settings.final3.json`(ask101; 백엔드 test는 watch가 아니라 it 계열도 ask).
- 판단: 별칭 열거는 수확체감 — 근본 원인은 글로벌 allow `pnpm:*`·`npm:*`·`yarn:*`가 넓은 것. 이번 라운드 반영 후 남는 별칭은 머지 후 탐침·후속(글로벌 allow 축소는 claude-config-7a 몫)으로 넘기는 종료 조건을 사용자에게 제안.
- **D-016**(사용자): 리뷰 종료 기준 = 코드 결함만 차단. 별칭 우회 잔여는 후속.
- 사용자가 `guardfix2.patch` 적용. `pnpm ci:core` exit 0: lint 0err/6warn, 단위 857/857(38), build ✅. README 기준선 857.
- 백엔드 settings final3 사용자 적용(allow79·ask101·deny101).
- 확인 리뷰(백엔드, D-016): CR 조치 정확·러너 결함 없음. **R-1 중** — `URIFACTORY.GETURI(…).GETCLOB()`(HTTPURITYPE 반환) 통과, `APEX_WEB_SERVICE` 통과 → 금지 패턴에 `\w*URITYPE`·`URIFACTORY`·`APEX_WEB_SERVICE` + 거부 목록은 완전할 수 없다는 주석(근본은 계정 권한·네트워크 ACL). 같은 fail-closed로 VT·FF·NEL·U+2028/2029 입력도 거부. `guardfix3.patch`(scratch 복사본 50/50·tsc 0·eslint 0).
- 프론트 확인 리뷰: 차단 0, ci:core exit 0(lint 0·typecheck 0·360/360·build 36/36), 커밋 3개 계획(settings / CLAUDE.md·삭제 자산 / README·archive). 후속 9건은 프론트 보고 그대로 후속.
- 사용자가 `guardfix3.patch` 적용. `pnpm ci:core` exit 0: lint 0err/6warn, 단위 860/860(38), build ✅. README 기준선 860.

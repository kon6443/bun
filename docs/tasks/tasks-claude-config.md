# Claude Code 설정 고도화 — 백엔드(bun) · 프론트(next-bun) · 글로벌

> 작성일: 2026-09-23 | 최종 수정: 2026-09-23 (전수 조사 완료 · 실행 계획 수립 · Q1 결정 = (A) · nerd-back·mobigo-web 패턴 분석 반영 · 추천 항목 전부 채택 확정 · **C0 완료 `4e28936`** · 레포 쪽 전부 완료·커밋(push 안 함) · C6 3건은 사용자 별도 세션 · F1·F8·F9 실측)
> 브랜치: `feat-onam` (백엔드) / 프론트는 별도 레포 `../next-bun`
> 목표: ① 글로벌 설정의 검증된 패턴을 두 프로젝트에 전파 ② **교차 프로젝트 규약의 조건부 로드**를 양방향으로 동작시키기 ③ 설정·문서 드리프트 정리
> **SSOT**: 이 파일이 두 레포 공통의 Claude 설정 작업 SSOT다. 프론트 레포에는 이 파일로 가는 링크만 둔다(C2-4). 복사본을 만들지 않는다.

---

## 환경 제약사항

| 항목 | 상태 | 영향 |
|---|---|---|
| `bun/.claude/settings.json`·`bun/.claude/hooks/` | AI 쓰기 불가 (프로젝트 deny `Edit/Write(.claude/settings.json)` + sandbox denyWithinAllow) | 초안은 AI가 scratch에 작성 → `diff -u` 제시 → **사용자가 적용** |
| `~/dotfiles/claude-config/**`, `~/.claude/**` | AI 쓰기 불가 (글로벌 deny + sandbox) | 동일 — 사용자 적용 |
| `next-bun/.claude/` | 현재 `settings.local.json`(git 미추적, allow만)만 존재. 팀 공유 `settings.json` 없음 | 신설 필요. 쓰기 가능 여부는 착수 시 확인 |
| 권한 배열 병합 | 공식 문서: *"Arrays merge across layers"* (settings.md) — user·project·local의 allow/deny/ask는 **합쳐지고 deny가 우선** | 글로벌 deny는 프로젝트에서도 살아 있다. 단 **프로젝트 전용 deny는 그 프로젝트에서 세션을 열 때만** 적용된다 (→ C2-2) |
| 추가 디렉터리의 CLAUDE.md·`.claude/rules`·skills | **추가 방식에 따라 다르다** (large-codebases.md "Grant access across packages or repositories" 표): `additionalDirectories` **설정** → CLAUDE.md·rules **Never**, skills **Never**, 환경변수도 *"has no effect"*. `--add-dir` 플래그·`/add-dir` → skills **Yes**, CLAUDE.md·rules는 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`일 때만(세션 시작 시 전부) | 우리는 설정 방식이라 env로는 **아예 안 된다**(2026-09-23 정정 — 이전 서술 "env면 로드"는 `--add-dir`에만 맞다. mobisell-back F37이 먼저 발견). 어느 쪽이든 "필요할 때만"은 불가 → 훅 방식 유지 |
| `@import` | 세션 시작 시 항상 로드 (조건부 불가) | 기각 |
| `.claude/rules` `paths:` | 프로젝트 루트 기준 상대 glob. **추가 디렉터리의 rules는 로드되지 않음** | 교차 세션에서 필요한 규칙을 path-scoped rule로 옮기면 형제 세션에선 **안 보이게 된다** → **C1-5(형제 rules 주입)가 두 레포에 배포된 뒤에만** 옮긴다 (C3-4) |

---

## 진행률

```
완료: 28/31 (C0 `4e28936` · C1-1~5 · C2-1~5 · C3-1~6 · C4-1~6 · C5-1~3 · C6-3 조건 미충족 종료 · C6-5)  |  **보류: C6-1·C6-2·C6-6 — 사용자가 글로벌 설정을 별도 세션에서 작업**(2026-09-23 결정)  |  제외: C6-4  |  **커밋은 전체 완료 후 일괄**(2026-09-23 사용자 결정)  |  제외: 1 (C6-4)   (결정 대기: 0)   ※ 하위 항목 기준: C0 · C1-1~5 · C2-1~5 · C3-1~6 · C4-1~6 · C5-1~3 · C6-1~3·5·6
```

---

## 결정 사항

| ID | 질문 | 권장 디폴트 | 답에 따라 달라지는 것 |
|---|---|---|---|
| **Q1** ✅ 2026-09-23 **(A) 확정** | 교차 주입 훅을 어디에 둘 것인가 | **(A) 각 레포에 동일 스크립트 커밋** (`.claude/hooks/inject-sibling-claudemd.sh`, 인자로 형제 디렉터리명) | (A) 레포 단독으로 재현 가능·다른 클론에서도 동작, 대신 두 벌 동기화 필요(C2-5 diff 검사로 보완). (B) 글로벌 dotfiles 훅 1벌이 프로젝트의 `additionalDirectories`를 읽어 자동 판별 — DRY·모든 프로젝트에 적용, 대신 개인 설정에 종속되어 다른 사람 클론에선 미동작 |

---

## 조사 결과 요약 (2026-09-23 실측)

### 현재 교차 로드 장치 (백엔드 → 프론트 한 방향만 존재, **미커밋**)

- `bun/.claude/hooks/inject-frontend-claudemd.sh` + `bun/.claude/settings.json` PreToolUse 등록 + `CLAUDE.md` 라우팅 표 갱신 — 전부 `git status`상 미커밋(untracked / modified). 같은 워킹트리에 무관한 `src/modules/auth/auth.service.ts` 변경도 섞여 있다 → 커밋 시 분리 필요.
- 메커니즘: PreToolUse에서 `tool_input`의 `file_path`/`path`/`notebook_path`/`command`/`edits[].file_path`에 `next-bun`이 있으면 프론트 `CLAUDE.md`를 `hookSpecificOutput.additionalContext`로 주입, `$TMPDIR/claude-frontend-claudemd-<session_id>` 마커로 세션당 1회, 마커 60분 경과 시 재주입.
- PreToolUse `additionalContext` 지원은 **공식 문서로 확인됨** — *"Supported on: PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, UserPromptSubmit, Stop, SubagentStop"* (hooks.md, Decision control). 조사 서브에이전트 1건이 "PreToolUse 미지원"이라 보고했으나 **원문과 불일치 — 반증됨**.

### 발견한 결함

| # | 결함 | 근거 |
|---|---|---|
| F1 | **서브에이전트가 세션당 1회 마커를 먼저 소비하면 메인 컨텍스트는 주입을 못 받는다** — ✅ **재현 확정**(2026-09-23 14:0x): 마커 삭제 → 서브에이전트가 프론트 파일 Read(주입 받음) → 직후 메인 Read에 주입 없음 | 최초 관측: 마커 `…/T/claude-frontend-claudemd-850f9a74-…` 생성 11:47 = 프론트 조사 서브에이전트 실행 시각. 이후 메인의 `next-bun` 경로 Bash 호출에 주입 문구 없음. 훅 입력엔 서브에이전트 식별자 `agent_id`가 있다(hooks.md Common input fields) → 마커 키에 미포함 |
| F2 | Glob의 `pattern` 필드 미검사 — `Glob(pattern: "../next-bun/src/**")`처럼 `path` 없이 부르면 감지 누락 | `inject-frontend-claudemd.sh` jq 필드 목록 |
| F3 | 재주입 기준이 "60분 경과"라는 휴리스틱 — compact와 무관하게 매시간 재주입하거나, 60분 안에 compact되면 누락 | `SessionStart` matcher `compact` 존재(hooks.md Matcher patterns) → 정확한 트리거로 대체 가능 |
| F4 | **역방향 없음** — 프론트에서 세션을 열면 백엔드 CLAUDE.md(Never 표 포함)가 로드되지 않는다 | `next-bun/.claude/`에 settings.json·hooks 없음, `settings.local.json`에 `additionalDirectories` 없음 |
| F5 | **프론트 세션에서 백엔드 DB 명령 deny가 사라진다** — `pnpm db:migrate:up` 등의 deny는 `bun/.claude/settings.json`에만 있어, 프론트에서 연 세션이 `../bun`에서 실행하면 막히지 않는다 (글로벌 `db-guard.sh`는 스크립트 내 SQL만 판정) | `bun/.claude/settings.json` deny 블록 vs `next-bun/.claude/settings.local.json`(allow만) · 권한은 세션 프로젝트 기준 병합 |
| F6 | 프론트 CLAUDE.md(20줄)가 자체 규칙 문서(`docs/assistant_rules_ui.md` 139줄 등 4개)로 가는 라우팅이 없다 → 주입돼도 UI·next-auth 규칙은 누락 | `next-bun/CLAUDE.md` 전문, `next-bun/docs/project_readme.md:24-27`에만 목록 |
| F7 | 프론트 CLAUDE.md의 `bun run test`는 watch 모드(`vitest`) — AI가 실행하면 종료되지 않는다. 1회 실행은 `test:run` | `next-bun/package.json` scripts |
| F8 | 훅 주입 크기 상한이 **문서에 없다** — 백엔드 CLAUDE.md는 10,836자 | ✅ **실측**(2026-09-23, 프론트 CLAUDE.md를 임시로 키워 주입 후 원복): 총 9,901자 → 전문 도착 / 15,088자 → `<persisted-output>`으로 파일에 저장되고 **앞 2KB 미리보기만** 컨텍스트에 남음. 상한은 그 사이 → LIMIT 9,000자(누적) 채택. **백엔드 CLAUDE.md(10,836자)는 역방향에서 전문 주입 불가 → Read 지시로 대체**된다 |
| F9 | `PreToolUse additionalContext`가 서브에이전트 컨텍스트로 들어가는지 **문서에 없음** — ✅ **실측: 들어간다**(서브에이전트가 주입 본문의 `glass-morphism` 줄을 그대로 인용) | hooks.md *"When a subagent calls a tool, tool events such as PreToolUse … fire the same configured hooks"* |

### 타 프로젝트 패턴 분석 (2026-09-23 — nerd-back · mobigo-web)

대상: `../wanted_ai_2026/nerd-back`(pnpm 모노레포 apps/back·apps/front), `../mobisell/mobigo-web`(PHP, rules 15·skills 2·agents 5·templates 6). 채택한 것은 각 태스크에 근거와 함께 반영했다.

| 패턴 | 출처 | 판정 | 반영 위치 |
|---|---|---|---|
| 코드 규약을 `.claude/rules/` + `paths:`로 자동 로드, 라우팅 표는 폴백 | nerd-back `.claude/rules/back-code-patterns.md:1-6`, `CLAUDE.md:59` · mobigo rules 8/15 | **채택** | C3-4 (+ 형제 세션 보완 C1-5) |
| rule과 CLAUDE.md 요약의 **의도된 중복**을 이유와 함께 명시 | nerd-back `apps/back/CLAUDE.md:16-19` | **채택** | C3-4 |
| DoD 잔여 항목 게이트 3분류 · "결정 바뀌면 태스크 문서 먼저" | nerd-back `CLAUDE.md:126-139` | **채택** | C3-5 |
| Never 규칙에 "근거의 유효기간" | nerd-back `apps/back/CLAUDE.md:14` | **채택** | C3-5 |
| Never 표 ↔ deny 배열 1:1 대조 | nerd-back에서 `db:migrate:list` 누락 독립 재현 → bun에도 같은 불일치 있음 | **채택** | C2-2 · C4-6 |
| 훅 헤더 표준 주석(역할/트리거/입출력/실패 정책/의존성) | mobigo `.claude/hooks/check-secrets.sh:1-32` | **채택** | C1-1 |
| 팀 공유 목적의 훅·에이전트는 프로젝트에 커밋 | mobigo `.claude/hooks/README.md:16-19` | **Q1=(A) 보강 근거** | Q1 |
| 형제 레포 **안내 스킬**(`/mobisell-front`) — 로드 절차 + 형제 rules 색인 + 계약 접점, `paths` 의도적 미사용 | mobisell-back `.claude/skills/mobisell-front/SKILL.md` · 같은 레포 `docs/tasks/claude-config-improvement-round2-tasks.md` F37~F42 | **채택(훅의 보조)** — 2026-09-23 사용자 결정 | C3-6 |
| 명령·스킬 역할을 "도구 \| 종류 \| 언제" 표로 명문화 | mobigo `.claude/CLAUDE.md:119-127` | 채택 안 함 — 이름 충돌이 남는다. **개명으로 확정** | C4-1 |
| 글로벌 훅의 프로젝트 사본 | nerd-back `check-secrets.sh` — 글로벌보다 구버전·이중 실행 | **반면교사** | C6-5 |
| 중첩 CLAUDE.md on-demand 로드 | nerd-back `apps/*/CLAUDE.md` | 적용 불가 — 같은 레포 하위 트리 전용. 별도 레포는 훅으로 흉내낸다(C1). 모노레포 통합은 C1-5에 대안으로만 기록 | — |
| `.claude/CLAUDE.md`(AI 절차) / 루트 `CLAUDE.md`(코드 지식) 이원화 | mobigo `.claude/CLAUDE.md:3` | 채택 안 함 — bun은 README(사실)/CLAUDE.md(규약) 경계가 이미 같은 역할이고 168줄로 한도 내. 파일을 늘리면 경계만 하나 더 생긴다 | — |
| `role-*.md` 상시 로드 역할 규칙 | mobigo `rules/role-*.md` | 채택 안 함 — bun/next-bun은 **레포 자체가 역할 경계**. 상시 로드라 토큰만 는다 | — |
| 글로벌 rules(context/workflow/git-hygiene 등)의 프로젝트 사본 | mobigo `rules/` 7개 | 채택 안 함 — 글로벌이 이미 매 세션 로드. 사본은 드리프트 확정 | — |
| `deploy-qa-report` 생성자/평가자/판정자 하네스 | mobigo `.claude/skills/deploy-qa-report/` | 채택 안 함 — 대응 프로세스(비개발자 stag QA → Notion)가 없다. 과설계 | — |
| plan/bugfix 템플릿을 레포에 커밋 | nerd-back·mobigo `.claude/templates/` | **보류** — 팀 전파가 필요할 때만 의미. 현재 글로벌 스킬 `/plan`·`/bugfix`로 충족 | — |

| F10 | (미재현 관측) 13:41 메인 Bash 호출 2건에서 마커는 갱신됐는데 주입 문구가 보이지 않았다 | 이후 같은 조건(단일 명령·여러 줄 복합 명령·`cd` 포함·Read)으로 4회 재시도 → 모두 정상 주입. 원인 미확정. C1-4 V4 실세션 검증 때 다시 관찰한다 |

| F11 | **🔴 권한 규칙 끝이 `:*`이면 옛 접두사 문법으로 해석돼 `db:migrate:fake-probe` 같은 이어진 이름을 못 잡는다** — C2 초안의 `Bash(npm run db:migrate:*)`·`Bash(npm * db:migrate:*)`·`Bash(tsx … migration:*)`가 전부 무효였다 | 실측(2026-09-23, 프론트 headless 세션): `npm run db:migrate:fake-probe`·`npm --prefix ../bun run …` **실행됨**(`Missing script`) vs 끝이 `…up*`인 pnpm 패턴은 전부 거부. 동사별 `…:up*` 형태로 재작성 후 5개 형태 전부 거부. 접두사 뒤 경계 규칙은 공식 문서 확인 전 **추정** — 결론(끝을 `:*`로 쓰지 않는다)은 실측으로 충분 |
| F12 | **🔴 백엔드 세션에서 `pnpm run db:migrate:up`이 차단되지 않는다** — deny가 `pnpm db:migrate:up*`(스크립트명 바로 앞 `pnpm`)만 있어서, `run`·`--dir` 같은 토큰이 끼면 `Bash(pnpm:*)` allow로 통과한다. 실제 이름이면 **상용 DB에 적용** | 실측(백엔드 headless 세션, 탐침명): b1 `pnpm db:migrate:up-probe` 거부 / **b2 `pnpm run …` 실행됨** / **b3 `pnpm --dir . …` 실행됨** / b4 `npm run …` 거부 → **C4-6 수정안**(`scratchpad/c2/bun-settings.json`)으로 해소 예정 |
| F13 | `Write(path)` deny는 파일 권한 검사에 **쓰이지 않는다** — 하네스 경고: *"Write(...) is not matched by file permission checks — only Edit(path) rules are. Use Edit(...) instead (Edit rules cover all file-editing tools)"* | headless 세션 시작 로그. 백엔드·프론트는 `Edit`가 이미 있어 `Write` 줄만 제거. **글로벌 `Write(~/dotfiles/**)`·`Write(~/.claude/**)`도 같은 경고** → C6-6 |
| F14 | ✅ 해소(2026-09-23 사용자 신뢰 수락) — headless(`claude -p`)로 처음 연 레포는 "신뢰하지 않은 작업공간"이라 `additionalDirectories`를 무시한다 — *"Run Claude Code interactively here once and accept the trust dialog"* | 프론트 headless 로그. 프론트 레포를 대화형으로 한 번 열어 신뢰 수락 필요(C2-3 잔여) |

---

## 실행 순서

| 순서 | 태스크 | 난이도 | 위험도 | 효과 | 선행 |
|:---:|---|:---:|:---:|:---:|:---:|
| 1 | **C0** 현재 미커밋 훅 변경을 단독 커밋으로 분리 | 낮음 | 🟢 | 기준선 확보 | — |
| 2 | **C1** 교차 주입 훅 일반화 + F1·F2·F3 수정 (C1-5 포함) | 보통 | 🟢 | 높음 | C0, Q1 |
| 3 | **C2** 역방향(프론트 세션) 적용 + 프론트 보안 설정 | 보통 | 🟡 | 높음 | C1 |
| 4 | **C3** CLAUDE.md 정비 (양쪽) | 낮음 | 🟢 | 중간 | C2 · **C3-4는 C1-5가 두 레포에 배포된 뒤에만** |
| 5 | **C4** 설정 위생 정리 | 낮음 | 🟢 | 낮음 | — (병행 가능) |
| 6 | **C5** 프론트 검증 체계 | 보통 | 🟡 | 중간 | — (코드 영역, 별도 PR) |
| 7 | **C6** 글로벌 dotfiles 개선 | 낮음 | 🟢 | 낮음 | — (사용자 적용) |

---

## C0. 기준선 — 기존 훅 변경 분리 커밋

- **무엇**: 현재 미커밋인 `.claude/hooks/inject-frontend-claudemd.sh`, `.claude/settings.json` PreToolUse 블록, `CLAUDE.md` 라우팅 2행을 `auth.service.ts`·태스크 문서 변경과 **분리해** 한 커밋으로.
- **왜**: C1이 이 파일을 대체하므로 "대체 전 상태"를 이력에 남겨 롤백 지점을 만든다.
- **수용 기준**: `git show --stat`에 위 3파일만. 커밋은 **사용자 지시 후** 실행.

## C1. 교차 주입 훅 일반화 (양방향 공통 스크립트)

> **상태 (2026-09-23)**: C1-1·C1-2·C1-5 스크립트 + 픽스처 테스트 작성 완료 → **`sh test-inject-sibling-claudemd.sh` PASS 24 / FAIL 0**(sandbox `TMPDIR`·macOS 기본 `TMPDIR` 둘 다), `shellcheck -s sh` 경고 0.
> **1차 적용 시 사용자 셸에서 10건 실패** → 원인: macOS 기본 `TMPDIR`가 `/`로 끝나(`…/T/`) 픽스처 경로에 `//`가 생겼고, 훅은 `pwd`로 정규화된 경로와 문자열 비교했다. sandbox의 `TMPDIR`(`/tmp/claude-501`)엔 끝 `/`가 없어 드러나지 않았다. `TMPDIR="$TMPDIR/"`로 재현 확인 → 훅에 연속 `/` 정규화 + 물리 경로(`pwd -P`) 비교 추가, 회귀 케이스 "V1 연속 슬래시 경로" 추가(정규화를 빼면 실패함을 변이로 확인). 실제 레포 경로엔 심볼릭 링크 없음(`pwd` = `pwd -P`).
> **실세션 부분 확인(V4 절반)**: 적용 직후 **이 세션에서** `cd …/next-bun` Bash 호출에 새 형식 주입이 붙었다 — settings.json 훅 변경은 세션 재시작 없이 반영된다.
> **변이 검증**(Pitfall #8): 방어를 하나씩 제거하면 테스트가 깨진다 — agent_id 마커 제거 → V2 실패, `pattern` 필드 제거 → Glob 실패, 부분문자열 매칭 → 7건 실패.
> **사용자 적용 완료**(2026-09-23 14:27): 레포 파일 = 검증본(`cmp` 동일), 레포 경로에서 `PASS=24 FAIL=0`. 옛 `inject-frontend-claudemd.sh` 삭제, 참조 잔존 0건(grep). CLAUDE.md 라우팅 행 갱신. **미커밋.**
> **V4 통과(백엔드→프론트 방향)**: 적용 후 이 세션에서 백엔드 경로만 다룬 호출엔 주입 없음, 프론트 경로 호출에만 주입. 프론트→백엔드 방향 V4는 C2-3에서 확인.

### C1-1. 스크립트 `inject-sibling-claudemd.sh <sibling-name>`

설계:

```
입력: 훅 stdin JSON, 인자 $1 = 형제 디렉터리명 (bun 레포에선 next-bun, next-bun 레포에선 bun)
SIBLING_ABS = realpath("$CLAUDE_PROJECT_DIR/../$1")
대상 필드: file_path, path, notebook_path, pattern(← F2), command, edits[].file_path
매칭:     "$SIBLING_ABS/" 또는 "$SIBLING_ABS" 끝 | "../$1/" | "../$1" 뒤가 공백·따옴표·끝
          ↳ 부분문자열 "bun" 매칭 금지 — "next-bun"·"bun run"이 오탐된다 (역방향의 핵심 함정)
마커:     $TMPDIR/claude-sibling-md-<session_id>-<agent_id|main>-<sibling>   (← F1)
주입:     [자동 주입] 헤더 + 형제 CLAUDE.md 전문
          전문 길이 > LIMIT(C1-4 실측값)이면 → "지금 <경로>를 Read하라" 지시만 주입 (폴백)
실패:     언제나 exit 0 (도구 호출을 막지 않는다) — 글로벌 훅 fail-open 원칙과 동일
```

- 스크립트 헤더 주석은 **역할 / 트리거(등록 위치) / 입출력 / 실패 정책 / 의존성(jq) / 출처** 형식으로 쓴다 (mobigo-web `.claude/hooks/check-secrets.sh:1-32` 형식). 등록 timeout 같은 **설정값은 주석에 숫자로 복제하지 않는다** — bun `precompact.sh:13`이 "600s"라 적고 실제는 20인 드리프트(C4-2)의 원인이다.

### C1-2. compact/clear 시 재주입 — SessionStart 훅

- `SessionStart` matcher `compact|clear`에서 해당 `session_id`의 `…-main-*` 마커 삭제 → 다음 형제 경로 접근 시 재주입 (← F3, 60분 휴리스틱 제거).

### C1-3. settings.json 등록 (bun 쪽, 사용자 적용)

- PreToolUse matcher `Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|Bash` → `sh "$CLAUDE_PROJECT_DIR/.claude/hooks/inject-sibling-claudemd.sh" next-bun`
- SessionStart matcher `compact|clear` → 같은 스크립트 `--reset` 모드
- 기존 `inject-frontend-claudemd.sh` 삭제(사용자 승인 후), CLAUDE.md 라우팅 표 마지막 행의 파일명 갱신

### C1-4. 검증 (수용 기준)

| # | 시나리오 | 기대 |
|---|---|---|
| V1 | 픽스처 JSON으로 스크립트 단독 실행 — 매칭/비매칭 경로 표 (`../next-bun/x`, 절대경로, `bun run test`, `next-bun`이 든 커밋 메시지 grep 등) | 매칭 케이스만 JSON 출력, 나머지 무출력·exit 0 |
| V2 | 같은 session_id, `agent_id` 유무만 다른 두 입력 | 둘 다 1회씩 주입 (F1 회귀 방지) |
| V3 | `--reset` 후 재호출 | main 마커만 재주입 |
| V4 | **실세션**: 백엔드만 작업하는 프롬프트 → 주입 없음 / 프론트 파일 Read → 주입 문구가 메인 컨텍스트에 보임 | ✅ 백엔드 세션 방향 통과(2026-09-23). 역방향은 C2-3 |
| V5 | **크기 상한 실측**: 10,000자 이상 더미 파일 끝에 표식 문자열을 두고 주입 → 모델이 표식을 인용할 수 있는지 | ✅ 실측 완료(F8). 픽스처로 "상한 초과 → Read 지시" 경로도 고정 |
| V6 | 서브에이전트(frontend-researcher)가 프론트 파일 Read → 서브에이전트가 주입 내용을 인용 가능한지 | ✅ 인용 가능(F9) — 에이전트 프롬프트 수정 불필요 |

- V1~V3·V5·C1-5는 `.claude/hooks/test-inject-sibling-claudemd.sh`로 남겨 재실행 가능하게 한다 (실제 이름 `bun`/`next-bun`으로 가짜 트리를 만들어 부분문자열 함정을 재현).
- 설계 보강(초안 작성 중 발견): 상한은 파일별이 아니라 **주입 누적 크기**로 판정한다 — CLAUDE.md와 rule이 각각은 작아도 합치면 잘린다. rule glob 매칭 루프는 `set -f`로 파일명 확장을 막는다.
- **롤백**: settings.json의 훅 블록 2개 제거 → 즉시 원복. 훅은 fail-open이라 실패해도 작업은 막히지 않는다.

### C1-5. 형제 레포의 path-scoped rules도 주입 — **채택** (C3-4의 선행 조건)

- **왜**: C3-4로 `code-patterns.md`를 `.claude/rules/` + `paths:`로 옮기면 **자기 레포 세션에선 자동 로드되지만, 형제 세션에선 로드되지 않는다**(추가 디렉터리 rules 미로드 — 환경 제약 표). 그러면 프론트 세션에서 `../bun/src/**/*.ts`를 고칠 때 백엔드 코드 규약이 빠진다.
- **무엇**: 매칭된 대상 경로를 형제 루트 기준 상대경로로 바꾼 뒤, 형제 `.claude/rules/*.md` 중 `paths:` glob이 맞는 파일을 규칙별 1회 주입 (마커에 규칙 파일명 포함). glob은 `**/`→`*` 치환 후 `case` 매칭 수준의 근사로 충분(과매칭은 토큰 비용만, 누락은 규약 누락이므로 과매칭 쪽으로 기운다).
- **채택 이유**: C3-4만 단독 적용하면 프론트 세션에서 백엔드 코드 규약이 사라지는 **회귀**가 생긴다. 그래서 C1-5는 선택이 아니라 C3-4의 선행 조건이다. 현재 next-bun엔 `.claude/rules/`가 없어 bun 세션에선 아무 동작도 하지 않지만 무해하고, 두 벌 스크립트를 같게 유지하기 위해(C2-5) 같은 코드를 둔다.
- **수용 기준**: 프론트 세션에서 `../bun/src/x.ts` Read → `code-patterns` 주입 1회, `../bun/docs/x.md` Read → 미주입.
- **대안(채택 안 함)**: 두 레포를 모노레포로 합치면 중첩 CLAUDE.md·path rules가 네이티브로 동작한다(nerd-back `docs/tasks/tasks-monorepo.md`가 실제 선례). 배포 파이프라인·레포 이력 통합 비용이 이 과제 범위를 넘으므로 참고로만 남긴다.

## C2. 역방향 — 프론트에서 세션을 열 때

> **상태 (2026-09-23)**: C2-1~5 적용(프론트 `.claude/`는 AI 쓰기 가능). 프론트 레포에서 `test-inject-sibling-claudemd.sh` → 백엔드 사본이 구버전이라 C2-5 검사 1건 FAIL(의도된 검출 — 백엔드 테스트 파일 재복사로 해소).
> **C2-3 실측(프론트 headless 세션)**: 프론트 파일만 Read → 주입 없음 ✅ / `../bun/src/main.ts` Read → 백엔드 CLAUDE.md가 상한 초과라 **"지금 Read하라" 지시 주입** ✅ / deny 탐침: pnpm 4형태·`cd ../bun && pnpm …`·`sqlplus` 거부 ✅, npm 형태는 F11로 1차 실패 → 재작성 후 5형태 전부 거부 ✅.
> **잔여**: 프론트 레포 신뢰 수락(F14) 후 `../bun` 실제 Read 권한 확인.
>
> **Never 표 ↔ deny 1:1 대조** (C2-2 수용 기준, 백엔드 CLAUDE.md Never 표 DB 행 기준)
>
> | Never 항목 | 프론트 deny | 백엔드 deny (현재 → C4-6 후) |
> |---|---|---|
> | `db:migrate:up`·`fake`·`revert` | ✅ pnpm·`pnpm *`·npm run·`npm *` × 동사별 | ⚠️ `pnpm run`/`--dir` 미포함(F12) → ✅ |
> | `db:migrate:list` | ✅ | ❌ ask → ✅ deny |
> | `sqlplus` | ✅ (`sqlplus*`, `sql *`) | ❌ ask → ✅ deny |
> | typeorm CLI 직접 호출 | ✅ run·revert·show | ⚠️ show 없음 → ✅ |
> | DataSource를 여는 `tsx`·`node` 스크립트 | 규칙으로 표현 불가 — 글로벌 `db-guard.sh`(SQL+DB 접속 동시 검출)가 담당 | 동일 |

### C2-1. 스크립트 배치
- Q1=(A)면 C1-1 스크립트를 `next-bun/.claude/hooks/`에 **동일 파일**로 커밋, 인자 `bun`.

### C2-2. `next-bun/.claude/settings.json` 신설 (팀 공유, 커밋)
- `permissions.additionalDirectories: ["../bun"]`
- **백엔드 전용 deny 미러링** (F5): `pnpm db:migrate:up/fake/revert`, `npm run db:migrate:*`, `npx typeorm migration:run/revert`, `tsx node_modules/typeorm/cli.js migration:*`
- **백엔드 전용 ask 미러링**: `ssh`, `scp`, `sqlplus`, `redis-cli`
- `pnpm db:migrate:list*`는 **deny**로 둔다 (C4-6과 같은 이유)
- **수용 기준 추가**: 백엔드 CLAUDE.md Never 표의 명령이 **전부** deny 배열에 있는지 1:1 대조표를 이 문서에 남긴다 (nerd-back에서도 같은 누락이 독립 재현됨 — `nerd-back/apps/back/CLAUDE.md:12` "4개 전부" vs `.claude/settings.json` deny에 `list` 없음)
- `Edit/Write(.claude/settings.json)` deny (백엔드와 동일한 자기보호)
- hooks: C1-3과 동일 구조, 인자만 `bun`
- 기존 `settings.local.json` allow는 건드리지 않는다 (개인 설정)

### C2-3. 검증
- 프론트 레포에서 새 세션: 프론트만 작업 → 백엔드 주입 없음 / `../bun/src/...` Read → 백엔드 CLAUDE.md 주입 (V4 대칭)
- 프론트 세션에서 마이그레이션 명령이 **deny로 거부**되는지 확인한다. ⛔ **실제 스크립트 이름으로 시험하지 않는다** — `Bash(pnpm:*)`가 글로벌·백엔드 allow에 있으므로(`~/.claude/settings.json:21`, `bun/.claude/settings.json:18`) deny가 매칭에 실패하면 **그대로 상용 DB에 실행된다**. 대신 deny 패턴 `db:migrate:up*`에는 걸리지만 실존하지 않는 **탐침 스크립트명**을 쓴다: `pnpm db:migrate:up-probe`, `pnpm --dir ../bun db:migrate:up-probe`, `cd ../bun && pnpm db:migrate:up-probe` (bun `package.json`에 `db:migrate:up-` 접두 스크립트 0건 — 확인함). 판정: 권한 거부 메시지 = 통과 / `Missing script` = deny 미매칭(DB 접속은 없음). fake·revert·list도 같은 방식으로 시험한다.
- 미매칭 형태가 하나라도 나오면 글로벌 `db-guard.sh`에 명령 패턴을 추가한다 (C6-3)
- **롤백**: `next-bun/.claude/settings.json` 삭제로 원상복구 (신규 파일)

### C2-4. 프론트 쪽 SSOT 링크
- `next-bun/CLAUDE.md`에 1줄: 교차 설정 작업 이력은 `../bun/docs/tasks/tasks-claude-config.md`가 SSOT.

### C2-5. 두 벌 스크립트 드리프트 검사 (Q1=A일 때)
- 각 레포 검증 스크립트 또는 훅 테스트에 `cmp ../<sibling>/.claude/hooks/inject-sibling-claudemd.sh` 추가 (형제 레포가 없으면 skip).

## C3. CLAUDE.md 정비

> **상태 (2026-09-23)**: C3-1~6 적용.
> - C3-1 프론트 CLAUDE.md 재구성: 59줄·2,774자(상한 이하라 백엔드 세션에서 전문 주입 가능). 참조 파일 전부 실존, 배포 트리거(`push: main`) 확인.
> - C3-2 `architecture.md` 날짜 섹션을 현행 정책으로 정정(최종 확인일·근거 헤더), 경고 문구 4곳(CLAUDE.md·README·code-patterns·playbook) 정리, 라우팅 표에 이 문서 행 추가.
> - C3-3 Swagger 경로·README 충돌 표시·KAKAO 정정 링크 — 충돌 표시 0 · `api-docs` 0 · 링크 유효. **잔여**: `docs/project_readme.md` 삭제(내용은 README로 이동, 참조 0건) — 삭제 승인 대기.
> - C3-4 `git mv docs/conventions/code-patterns.md .claude/rules/code-patterns.md` + `paths: [src/**/*.ts, test/**/*.ts]`. 옛 경로 참조 0건, 편집 문서 8개 상대 링크 깨짐 0건. **실측: 이 세션에서 `src/main.ts` Read 시 rule 자동 로드 확인.**
> - C3-5 DoD 6·7항(태스크 문서 우선, 게이트 3분류) + Never DB 행에 근거의 유효기간. CLAUDE.md 175줄.
> - C3-6 프론트 `.claude/skills/bun/` 작성 → **프론트 headless 세션에서 스킬 인식 + 설계 요청에 `Skill(bun)`이 첫 도구로 발동** 확인. 백엔드 `.claude/skills/next-bun/`은 쓰기 차단 경로라 `scratchpad/c3/skills/next-bun/SKILL.md` 준비 — 사용자 적용 대기. ✅ 사용자 적용(2026-09-23 15:2x) — **세션 재시작 없이** 스킬 목록에 `next-bun` 즉시 등록(최상위 `skills/`가 새로 생겼는데도 반영됨 — "재시작 필요" 예상은 틀렸다).
> - 작성 중 바로잡은 사실: 에러 DTO 파일명은 `*-error.dto.ts`(하이픈) — `code-patterns.md` §4 주석도 `{module}.error.dto.ts`로 틀려 있어 함께 정정. 검증 실패 응답은 400이 아니라 **422 `VALIDATION_ERROR`**(`src/common/dto/api-error.dto.ts:9-11`).

### C3-1. 프론트 CLAUDE.md를 라우팅 진입점으로 (F6·F7)
- 백엔드와 같은 골격: 라우팅 표(→ `docs/assistant_rules_ui.md`·`_nextauth.md`·`_diagnostics.md`·`assistant_workflow.md`), Never/Ask, DoD, Commands(`test` → `test:run`).
- 프론트 규칙 문서는 **이번 범위에선 라우팅 표 → 문서 Read 방식을 유지**한다. `.claude/rules/` + `paths:` 이관은 백엔드 C3-4를 먼저 적용해 C1-5 주입이 실제로 동작하는지 본 뒤 별건으로 판단한다 (C1-5 없이 옮기면 백엔드 세션에서 프론트 규칙이 사라진다).
- 수용 기준: 200줄 이하(공식 권장 *"target under 200 lines"*), "이걸 모르면 틀리게 행동하는가" 기준(`docs/lessons.md` 2026-08-12 항목) 통과.

### C3-2. 백엔드 CLAUDE.md
- 168줄 — 권장 한도 내. 대규모 슬림화는 하지 않는다.
- `docs/architecture.md` 날짜 처리 섹션을 **문서 자체에서 정정**하고 CLAUDE.md 라우팅 표의 ⚠️ 경고 제거 (경고로 우회하는 대신 원인 제거). 근거: 커밋 `2c86d73`이 architecture.md를 건드리지 않았음(`git show --stat 2c86d73`).
- 라우팅 표에 이 태스크 문서 행 추가: "Claude 설정·훅·권한·교차 프로젝트 로드".

### C3-3. 프론트 문서 드리프트 (문서만, 코드 무관)
- `next-bun/docs/swagger_info.md:8` `/api-docs` → `/api/v1/docs`
- `next-bun/README.md` merge conflict 마커(1·3·40행, HEAD에 커밋됨) 해소 — **확정**: HEAD 쪽은 제목 `# next-bun` 한 줄뿐이고 나머지는 create-next-app 기본 템플릿이다. 템플릿을 버리고, `docs/project_readme.md`(32줄, 프로젝트 개요)의 내용을 README로 옮긴다 (백엔드 문서 경계 "README = 사실"과 맞춘다). `project_readme.md`를 참조하는 파일은 0건이다(`grep -rln project_readme` 실측) — 파일 삭제는 사용자 승인을 받는다
- **수용 기준**: `grep -n '^<<<<<<<\|^=======\|^>>>>>>>' README.md` 0건, `grep -rn 'api-docs' docs/` 0건
- `next-bun/docs/KAKAO_LOGIN_ISSUE.md` 상단에 "부분 정정됨 → `../bun/docs/tasks/tasks-kakao-login-latency.md`" 링크 1줄

### C3-4. 백엔드 `code-patterns.md`를 path-scoped rule로 전환 (nerd-back 패턴)
- **무엇**: `docs/conventions/code-patterns.md` → `.claude/rules/code-patterns.md`, frontmatter `paths: ["src/**/*.ts", "test/**/*.ts"]`. 라우팅 표 1행("MUST OBEY — 모든 src 작업 전 Read")은 **폴백**으로 강등.
- **왜**: 지금은 "라우팅 표를 기억해서 Read"하는 모델 준수에 의존한다. path rule은 `.ts`를 읽는 순간 하네스가 로드한다. 근거: `nerd-back/.claude/rules/back-code-patterns.md:1-6`, `nerd-back/CLAUDE.md:59`("rules는 자동 로드, 라우팅 표는 폴백"), mobigo-web rules 15개 중 8개가 `paths:` 사용.
- **함께 할 것**: CLAUDE.md Key Patterns 요약은 유지하고 **"이 요약이 code-patterns와 겹치는 것은 의도된 것 — 설계 단계(코드 미접촉)엔 rule이 로드되지 않는다"** 1줄을 단다 (`nerd-back/apps/back/CLAUDE.md:16-19`). 파일 이동이므로 참조를 전부 갱신한다 — 현재 참조 3곳: `CLAUDE.md`, `README.md`, `docs/playbooks/recurring-issues-playbook.md` (`grep -rln code-patterns.md` 실측).
- **수용 기준**: 이동 후 `grep -rn 'docs/conventions/code-patterns' .` 0건 · 백엔드 세션에서 `src/*.ts` Read 시 rule 로드 확인(`/context` 또는 `InstructionsLoaded`) · 프론트 세션에서 C1-5 수용 기준 통과. `.claude/rules/` 쓰기 가능 여부는 착수 시 확인(불가면 사용자 적용).
- **롤백**: 파일 이동 커밋 1개를 revert.
- **주의**: playbook·lessons처럼 **대화 트리거**("버그", "교정 직후")로 읽는 문서는 경로로 표현할 수 없으므로 라우팅 표에 그대로 둔다 (mobigo-web `.claude/rules/README.md:16-32`의 상시/경로 구분과 같은 판단).
- **연계**: 형제 세션 누락은 C1-5로 보완.

### C3-5. 백엔드 DoD·Never 보강 (nerd-back 패턴)
- DoD에 **잔여 항목 게이트 3분류** 추가 — 머지 전 차단 / 배포 직후 조치 / 후속. 코드 결함과 배포 환경 의존성을 섞지 않는다. 근거: `nerd-back/CLAUDE.md:126-139` (bun CLAUDE.md DoD엔 없음 — 확인함)
- DoD에 "결정이 바뀌면 코드보다 태스크 문서를 먼저 고친다" 1줄 (같은 위치 3항)
- Never 표의 DB 금지 행에 **근거의 유효기간** 1줄 — "LOCAL=PROD 동일 DB가 분리되면 재검토" (`nerd-back/apps/back/CLAUDE.md:14`). 규칙이 전제를 잃었을 때 알아챌 신호가 된다.
- 수용 기준: CLAUDE.md 200줄 이하 유지.

### C3-6. 형제 레포 안내 스킬 — 훅의 보조 (mobisell-back 패턴, 2026-09-23 채택)
- **무엇**: `bun/.claude/skills/next-bun/SKILL.md`, `next-bun/.claude/skills/bun/SKILL.md` 신설. 내용은 ① 형제 `CLAUDE.md`를 먼저 Read하라는 절차(본문 복사 금지 — 정본을 가리킨다) ② 형제 쪽 rules 색인(있을 때) ③ **백엔드↔프론트 계약 접점** 표 — 응답 `{code, data, message}`, 에러 `{code, message, timestamp}`(`statusCode` 없음), 날짜(UTC 저장·로컬 표시), 인증 쿠키 `access_token`, WS namespace·room 규칙 ④ 수정 범위 규칙(형제 레포는 별도 커밋).
- **왜 훅과 둘 다**: 훅은 **파일을 건드린 뒤에만** 발동한다 — 계획 단계("프론트에서 어떻게 쓰는지 보고 설계하자")엔 없다. 스킬은 요청 의도(description)로 발동하고 크기 상한이 없다(Read). 반대로 스킬은 모델 판단에 달려 누락될 수 있으므로 훅을 대체하지 않는다. 비교 근거: 2026-09-23 mobisell-back 분석(훅=확실성·서브에이전트 도달 / 스킬=계획 단계·상한 없음·계약 지식).
- **제약**:
  - frontmatter에 `paths`를 **넣지 않는다** — 스킬 `paths`도 레포 루트 기준이라 `../`를 매칭하지 못해 자동 발동이 영구히 죽는다(mobisell-back F39, 이유를 파일 안 주석으로 남긴다).
  - 이름이 글로벌 스킬과 겹치지 않게 한다 — 겹치면 글로벌이 이기고 프로젝트판은 가려진다(C4-1과 같은 원인). `next-bun`·`bun`은 현재 글로벌에 없음(착수 시 재확인).
  - 계약 접점 표의 사실은 백엔드 `docs/conventions/code-patterns.md`(C3-4 이후 `.claude/rules/code-patterns.md`)가 SSOT — 스킬엔 요지 + 링크만 둔다.
  - `.claude/skills/`는 AI 쓰기 차단 경로(sandbox denyWithinAllow) → 초안 작성 후 사용자 적용.
- **수용 기준**: 세션 스킬 목록에 두 스킬이 뜬다(세션 중 인식 — skills.md live 감지) · "프론트에서 이 API 어떻게 쓰는지 보고 설계하자" 류 요청에 스킬이 발동한다 · 계약 접점 각 항목에 SSOT `파일:라인` 근거.
- **선행**: C2(프론트 `.claude/` 신설), C3-4(규약 파일 위치 확정).

## C4. 설정 위생 (백엔드)

> **상태 (2026-09-23)**: C4-1 프론트 쪽 `git mv .claude/commands/review.md review-flow.md` 완료, 백엔드 쪽은 `.claude/commands/` 쓰기 차단 → 사용자 적용. 문서의 `/review` 언급은 이력 1건(`tasks-error-dto-refactor.md:483`)뿐이라 유지.
> C4-2 수정안 `scratchpad/c4/precompact.sh`(주석의 "timeout 600s" 제거, `sh -n` OK). **실동작 확인**: 탐침 입력으로 실행 → exit 0, **0.12초**, `docs/handoff/`에 스냅샷 생성 → 등록값 20초 유지로 충분. 탐침 스냅샷은 다음 세션 오인 방지를 위해 삭제.
> C4-3 수정안 `scratchpad/c4/settings.local.json`: allow 41 → 28(perl 12건 + `git add *`).
> C4-4 `.claude/settings.json.bak` 삭제 — 사용자 적용 명령에 포함.
> ✅ **사용자 적용 완료**(2026-09-23 15:2x): 3개 파일 = 준비본(`cmp`), `settings.local.json` JSON 유효, `.bak` 삭제, 프론트 `docs/project_readme.md` 삭제 스테이징(C3-3 잔여 해소). **C4-1 복구 실측**: 세션 스킬 목록에 `review-flow`("NestJS 백엔드 변경 코드에…") 등장 — 그동안 글로벌 `review`에 가려져 실행 불가였던 프로젝트 리뷰가 호출 가능해졌다.

| ID | 무엇 | 근거 |
|---|---|---|
| C4-1 | `/review` 이름 충돌 — **🔴 현재 프로젝트 `/review`는 실행되지 않는다**: 스킬 이름이 겹치면 personal(글로벌) > project이고 패자는 완전히 가려진다(skills.md "Resolve skills that share a name", mobisell-back F40). 실측: 이 세션 스킬 목록의 `review` 설명 = 글로벌 `SKILL.md:3`("변경된 코드에 대해…"), 프로젝트판("NestJS 백엔드 변경 코드에 대해…")은 목록에 없음. 개명이 곧 복구다 — 프로젝트 `.claude/commands/review.md`(양쪽 레포)와 글로벌 스킬 `review`. **확정: 두 레포 모두 `.claude/commands/review.md` → `review-flow.md`로 개명**(호출 `/review-flow`). 글로벌 `/review`는 그대로 둔다. 개명 전 `review` 참조를 두 레포에서 grep 전수 갱신. (검토했지만 채택 안 한 안: 개명 없이 CLAUDE.md 표로 역할만 명문화 — mobigo-web `.claude/CLAUDE.md:119-127`. 이름 충돌이 그대로 남는다) | `bun/.claude/commands/review.md`, `next-bun/.claude/commands/review.md`, `~/dotfiles/claude-config/skills/review/SKILL.md:2` |
| C4-2 | `precompact.sh:13` 주석 "timeout 600s" ↔ 실제 등록 `20` 불일치 — **확정: 등록값 20 유지, 주석에서 숫자 제거**(C1-1 헤더 원칙). 20은 nerd-back 등록값과 같다. 수용 기준: 훅 1회 실동작 → `docs/handoff/`에 파일 생성 + 소요 시간 기록. 20초를 넘기면 그때 값을 올린다 (`docs/handoff/` 현재 0건) | `.claude/hooks/precompact.sh:13`, `.claude/settings.json` PreCompact |
| C4-3 | `settings.local.json` 정리 — **확정**: 1회성 `perl -pi -e` 허용 **12건 삭제**(특정 과거 문자열 전용이라 다시 매칭될 일이 없다), `Bash(git add *)`(`:34`) 삭제 — 스테이징은 파일 단위로 승인받는다. allow 41건 → 28건. sandbox 쓰기 차단 파일이라 사용자가 적용 | `.claude/settings.local.json` |
| C4-4 | `.claude/settings.json.bak`(PreToolUse 훅 추가 이전 버전) 삭제 — **확정**. 실수로 복원하면 훅이 사라진다. 삭제는 Ask 대상이라 승인 후 실행 | gitignore 대상, 로컬 전용 |
| C4-5 ✅ | 서브에이전트 중복 정리 — **결정: 유지, 변경 없음**(2026-09-23). 프로젝트 `frontend-researcher`/`backend-researcher`는 FiveSouth 전용 지식(경로 탐색 폴백, Swagger `/api/v1/docs` 등)을 담고 있고 레포에 커밋돼 공유된다(Q1 원칙). 두 파일 모두 `tools: Read, Glob, Grep` 허용 목록이라 **이미 읽기 전용**이다 — 글로벌 사본의 `disallowedTools`·`permissionMode: plan`을 더할 필요가 없다 | `bun/.claude/agents/frontend-researcher.md:1-6`, `next-bun/.claude/agents/backend-researcher.md:1-6` (frontmatter 확인) |
| C4-6 | **🔴 우선 적용 — 백엔드 마이그레이션 deny 보강 + 문서-설정 불일치**: ① F12 빈틈(`pnpm run`·`pnpm --dir` 통과 — ✅ 해소) ② Never 표는 `db:migrate:list`·`sqlplus`를 금지하나 settings는 `ask` ③ `Write(...)` 무효 규칙(F13). **수정안 준비 완료**: `scratchpad/c2/bun-settings.json`(+ `.diff`) — 프론트와 같은 25개 패턴, 끝 `:*` 0건, list·sqlplus·sql을 ask→deny. ✅ **적용·검증 완료**(2026-09-23 15:0x): 레포 파일 = 준비본(`cmp`), 백엔드 headless 세션 탐침 b1~b6(`pnpm`·`pnpm run`·`pnpm --dir`·`npm run`·`list`·`sqlplus -V`) **전부 권한 거부**. 두 레포 훅 테스트 `PASS=26 FAIL=0`(C2-5 동일성 검사 포함) | CLAUDE.md Never 표 · Pitfalls #3 vs `.claude/settings.json:146` |

## C5. 프론트 검증 체계 (별도 PR — Claude 설정 밖이지만 DoD 전제)

> **상태 (2026-09-23)**: C5-1~3 적용.
> - C5-1 `package.json`에 `typecheck`(`tsc --noEmit`)·`ci:core`(lint → typecheck → test:run → build) 추가. **기준선 실측**: lint exit 0(에러 0 · 경고 4, 전부 `TeamBoard.tsx`의 `react-hooks/exhaustive-deps`) · typecheck exit 0 · test:run 1파일 31/31 통과 · build exit 0(`✓ Compiled successfully`). ⚠️ sandbox 안에서는 build가 Google Fonts 차단으로 실패하고, 호스트를 허용해도 멈췄다 → sandbox 밖에서 통과 확인. 경고 4건은 기존 코드라 이 항목에서 고치지 않는다(후속).
> - C5-2 `oci_build_and_deploy_next.yml`에 `verify` 잡(checkout → setup-bun 1 → `bun install --frozen-lockfile` → lint → typecheck → test:run) 추가, `deploy: needs: verify`. build는 Docker 빌드가 하므로 중복하지 않음. YAML 파싱 OK, `--frozen-lockfile` dry-run OK. actionlint 지적 1건은 기존 줄(SHA 추출 SC2086 info)이라 범위 밖. **실제 CI 실행은 push 후에만 확인 가능 — 미검증.**
> - C5-3 루트 `tasks/` 6개 → `docs/tasks/`(참조 0건, 시크릿·내부 URL grep 결과 식별자명만). 프론트 CLAUDE.md 문서 경계 줄에 위치 반영. 커밋은 전체 완료 후 일괄.

| ID | 무엇 | 위험 |
|---|---|---|
| C5-1 | `typecheck`(`tsc --noEmit`) + 통합 스크립트 `ci:core`(lint → typecheck → test:run → build) 추가. 수용 기준: `bun run ci:core` 로컬 통과 — 기존 에러가 나오면 이 항목에서 고치지 말고 목록만 남긴다 | 🟢 |
| C5-2 | CI(`oci_build_and_deploy_next.yml`)에 lint/test 게이트 — 현재 main push 즉시 배포 | 🟡 숨은 에러가 드러나 배포가 막힐 수 있음 → C5-1을 로컬에서 먼저 통과시킨 뒤 도입 |
| C5-3 | 루트 `tasks/`(git 미추적 6개 파일) — **확정: `next-bun/docs/tasks/`로 옮기고 커밋**(백엔드와 같은 위치 규약). 커밋 전에 시크릿·내부 URL grep, **커밋은 사용자 지시 후**. 파일 목록: `comment-mobile-fixes`·`fishing-multiplayer`·`seo-implementation`·`teamboard-dropdown-menu`·`teams-seo-landing`·`ui-design-improvements` | 🟢 |

## C6. 글로벌 dotfiles (사용자 적용 — AI는 diff만 제시)

> **상태 (2026-09-23)**:
> - **C6-1 전제 정정**: 커밋된 `skills/review/SKILL.md`에는 `disable-model-invocation: true`가 **있다**. 작업 트리에서 그 줄이 지워진 미커밋 변경이었다(`git -C ~/dotfiles/claude-config diff skills/review/SKILL.md`). 문서-코드 드리프트가 아니라 로컬 변경 → 되돌릴지 사용자 결정 필요(Q2) → ✅ **Q2 결정(2026-09-23): 되돌린다** — 사용자 의도는 "내가 호출할 때만 사용"이고, 그것이 곧 `disable-model-invocation: true`(모델 자동 호출만 막고 `/review` 직접 입력은 허용)다. 이력: 2026-03-31 `commands/review.md`(직접 입력 전용) → 2026-09-03 `4b37046` 스킬 이관 때 같은 동작을 유지하려고 키 추가 → 2026-09-15 12:47 작업 트리에서 삭제(미커밋, 사유 기록 없음). 복원 후 사본에서 `check.sh` 스킬 5개 전부 README 일치. `settings.json`에도 이 세션과 무관한 미커밋 변경(+25/−20)이 있다 — 건드리지 않는다.
> - C6-2 `check.sh`에 README 스킬 표 "모델 자동 호출" 열 ↔ `disable-model-invocation` 일치 검사 추가(파이프 서브셸 없이 — `fail` 변수 유실 방지). 사본에서 실행: 기존 5개 중 4개 OK, **`review`만 FAIL(README=차단, frontmatter=허용)** — 의도대로 불일치를 잡는다. 원본 기준선 FAIL 0건.
> - C6-3 **조건 미충족으로 종료** — C2-3·C4-6 이후 두 레포 탐침(`cd ../bun && …`·`--dir`·`--prefix` 포함) 전부 권한 거부. `db-guard.sh` 명령 패턴 추가 불필요.
> - C6-5 `docs/lessons.md`에 기록(2026-09-23 항목).
> - C6-6 준비: `settings.json`에서 무효 `Write(...)` 2줄 제거 + 새 path-scoped rule `rules/claude-settings.md`(`paths`: settings 파일들 — 설정 편집 시에만 로드): `:*` 함정·중간 토큰·`Edit` vs `Write`·탐침 시험 4줄. `check.sh` 필수 파일 목록에 등록.
> - 적용 파일: `/tmp/claude-501/c6work/claude-config/`(dotfiles 전체 사본에 반영, 원본의 미커밋 `settings.json` 변경 위에 2줄 삭제만 얹음).
> - ⏸️ **보류(2026-09-23)**: 사용자가 글로벌 dotfiles는 다른 세션에서 직접 작업하기로 했다. 준비본은 `/tmp` 아래라 재부팅 시 사라질 수 있다 — 다시 만들 때는 위 설명(각 항목의 무엇·근거)과 Q2 결정을 기준으로 한다. 이 레포 쪽 작업은 C6과 무관하게 완료 상태다.

| ID | 무엇 | 근거 |
|---|---|---|
| C6-1 | `skills/review/SKILL.md`에 `disable-model-invocation: true` — README·`docs/claude-code-concepts.md`는 "자동호출 차단"이라 서술하나 frontmatter엔 없음 | `README.md:154` vs `skills/review/SKILL.md:1-4` |
| C6-2 | `scripts/check.sh` skill 검증에 `disable-model-invocation` 문서-코드 일치 검사 추가. C6-1·C6-2 수용 기준: dotfiles에서 `sh scripts/check.sh` 통과, C6-1 적용 전엔 C6-2 검사가 `review`를 잡아내는지 먼저 확인 | `scripts/check.sh:81-89` |
| C6-3 | (C2-3 결과에 따라) `db-guard.sh`에 `db:migrate:(up|fake|revert)` 명령 패턴 추가 — `cd … &&`/`--dir` 형태 우회 대비 | F5 |
| C6-5 | (원칙 기록, 작업 아님) 글로벌 훅(`check-secrets.sh` 등)을 **프로젝트에 복사하지 않는다** — 팀 공유가 목적일 때만 예외. 근거: nerd-back 로컬 사본(47줄)이 글로벌(22줄)보다 구버전으로 드리프트 — `sk_live`·`glpat`·`npm_`·`hf_`·`AGE-SECRET`·`eyJ` 패턴 6종이 로컬엔 0건, 글로벌엔 각 1건(grep 실측). 글로벌과 이중 실행도 된다. `docs/lessons.md`에 1항목으로 남긴다 | — |
| C6-6 | 글로벌 `Write(~/dotfiles/**)`·`Write(~/.claude/**)` deny는 무효(F13) — `Edit(...)`가 이미 있으므로 `Write` 줄 삭제(경고 제거). 권한 규칙 끝을 `:*`로 쓰지 않는다는 원칙(F11)을 글로벌 `rules/`에도 1줄 | F11·F13 |
| ~~C6-4~~ | **불필요 (Q1=A 확정)** — (Q1=B 선택 시) `inject-sibling-claudemd.sh`를 글로벌 훅으로 두고 `additionalDirectories`에서 형제 자동 판별 | Q1 |

---

## 반증·정정된 조사 주장 (재조사 방지)

| 주장 (서브에이전트 보고) | 판정 | 근거 |
|---|---|---|
| "PreToolUse는 additionalContext 미지원, UserPromptSubmit만 가능" | **틀림** | hooks.md Decision control 지원 이벤트 목록에 PreToolUse 포함 |
| "`Skill(code-review)`는 존재하지 않는 스킬 — 죽은 권한" | **틀림** | Claude Code 내장 스킬 `code-review` 존재 |
| "mobigo-web 프로젝트 사본 에이전트 4개에서 `disallowedTools`/`permissionMode: plan` 누락" | **틀림** | `mobigo-web/.claude/agents/codebase-investigator.md`·`cross-project-researcher.md` frontmatter에 두 키 모두 존재 (직접 확인) |
| "mobigo-web은 precompact timeout 주석-실제 일치, bun과 반대" | 부분 사실 | mobigo 등록값 600 (`settings.json` 실측). bun 주석 "600s"는 이 계열에서 복사되고 등록값만 20으로 바뀐 것으로 추정 → C4-2에서 **20 유지로 확정** |
| "프로젝트가 `gh:*`·`curl:*`·`claude:*`를 전체 허용해 글로벌 deny가 해제됐을 수 있음" | **실질 위험 낮음** | 권한 배열은 계층 간 병합, deny 우선 → 글로벌 deny(`gh repo delete`, `--dangerously-skip-permissions` 등)는 프로젝트에서도 유효. allow 범위 축소는 **채택 안 함** — 실익이 없고 워크플로만 막힌다 |

---

## 계획 리뷰 이력

점검 항목(고정): **R1** 인용 근거 정확성 · **R2** 내부 일관성(개수·ID·선행) · **R3** SSOT·문서 경계 · **R4** 실행 가능성(수용 기준·롤백) · **R5** 프로젝트 규칙 준수(Ask·사용자 적용·DB 금지). 종료 조건: 이 5개 항목의 결함이 0건. 새 이슈는 찾지 않는다.

| 차수 | 일자 | 결과 |
|---|---|---|
| 1차 | 2026-09-23 | R1: 인용 12건 대조, 불일치 0. R2: path-rule 서술 모순(환경 제약·C3-1 "옮기지 않는다" vs C3-4 "옮긴다") → C1-5 선행 조건으로 통일. C4 표 순서 정렬. R4: C3-3·C3-4·C5-1·C6-1/2에 수용 기준 추가, C3-4 참조 3곳 명시. **R5(치명)**: C2-3 검증이 실제 `db:migrate:up`을 실행하게 되어 있었음 — `Bash(pnpm:*)`가 allow라 deny가 미매칭이면 상용 DB에 적용된다 → 실존하지 않는 탐침 스크립트명 방식으로 교체. C5-3 커밋에 "사용자 지시 후" 명시 |
| 2차(최종) | 2026-09-23 | 같은 5개 항목을 전체 재점검. 참조 ID 전부 정의 확인, 미결 표현("사용자 판단"·"검토 가능"·"선택") 0건, 위험 명령 문구는 탐침 방식만 남음. 잔여 2건("결정 필요" 제목, 분석 표 C4-1 판정 문구) 수정. **결함 0 — 종료** |

---

## Results

**최종 검증 (2026-09-23)** — 레포 쪽 작업 전부 적용 후:
- 훅 테스트: bun·next-bun 모두 `PASS=26 FAIL=0` (C2-5 두 레포 동일성 검사 포함)
- 백엔드 `pnpm ci:core` exit 0 — lint 0 errors / 경고 7(README 기준선과 동일), 단위 28 suites **647/647**, build 통과. `src/` 변경은 이 작업 이전부터 있던 `auth.service.ts`뿐
- 프론트: lint 0 errors(경고 4, 기존) · typecheck · test:run 31/31 · build 통과(C5-1)
- 실세션: 백엔드 세션 V4 · 프론트 세션 V4 대칭(F14 신뢰 수락 후 `../bun` Read 성공 + CLAUDE.md·code-patterns rule 둘 다 감지 → 상한 초과로 Read 지시) · deny 탐침 백엔드 b1~b6·프론트 5형태 전부 거부 · 스킬 `next-bun`·`bun`·`review-flow` 등록
- 미검증: 프론트 CI `verify` 잡 실제 실행(push 후) · F10(미재현 관측)

**커밋 전 리뷰 (2026-09-23, 사용자 요청)** — 점검 항목 고정: R1 동작 · R2 참조 · R3 SSOT·중복 · R4 범위·위생 · R5 사실 정확성. 독립 리뷰어(서브에이전트) + 스크립트 검사 병행.
| 차수 | 결과 |
|---|---|
| 1차 | R1~R4 결함 0 (훅 테스트 26/0 ×2, JSON 유효, 인자 대칭, 끝 `:*` deny 0, 옛 이름 잔존 0, 상대 링크 전부 실존, 상한·422·Swagger 표기 전 파일 일치, CLAUDE.md 175·59줄). R5 샘플 12건 중 **이번 작업이 쓴 줄의 결함 2건 수정**: ① `code-patterns.md` §4 주석 — 파일명 패턴을 `-error.dto.ts`로 고치면서 "7개 파일"이 그 패턴 기준으론 틀려짐(실측 6개·정의 38건) ② 프론트 CLAUDE.md "main push가 곧 배포" — 워크플로 `paths-ignore: docs/**, *.md` 누락. **원래 있던 부정확 2건은 범위 밖 → 후속**: `code-patterns.md` §3 `telegram.service.ts:343,442`(실제 342·441), §1 `*repository*.ts 0건`(테스트용 `mock-repository.ts` 2개가 걸림 — 의도는 맞음) |
| 2차(최종) | 같은 5개 항목을 수정분·회귀에 한해 재점검 — 훅 테스트 26/0 ×2, JSON 유효, CLAUDE.md 175·59줄(프론트 2,840자 — 상한 이하 유지), 편집 문서 11개 링크 깨짐 0, 옛 이름 잔존 0. **결함 0 — 종료** |

**커밋 (2026-09-23, push 안 함)** — 이 세션 이전부터 있던 변경(bun: `auth.service.ts`·기존 태스크 문서 3개·CLAUDE.md 카카오 행 / next-bun: `src/lib/auth.ts`·`taskUtils.test.ts`)은 제외했고, 커밋 후 제외 파일 혼입 0건·훅 테스트 26/0 ×2 확인.
- bun: `4e28936` 기준선 · `fca31b7` 마이그레이션 deny 빈틈 · `412a962` 훅 일반화 · `d742649` code-patterns → path rule · `5f90442` architecture 날짜 정정 · `855ab14` DoD·라우팅·이 문서 · `1ee39b9` review-flow 개명 · `45ba44d` next-bun 스킬 · `19d656d` precompact 주석
- next-bun: `55e6fd5` 설정 신설(훅·DB deny) · `5687b7b` bun 스킬 · `530d8d5` review-flow 개명 · `c22195a` CLAUDE.md 재구성 · `de8417b` README 통합 · `e226c6b` Swagger·카카오 링크 · `eb77f3e` docs/tasks 이동 · `650673b` typecheck·ci:core · `c0b5a52` CI verify 게이트
- **push 전 주의**: next-bun `c0b5a52`는 main push 시 배포 파이프라인이 바뀐다(첫 실행 미검증). 문제 시 그 커밋만 revert.
- **md 전수 SSOT 점검 (2026-09-23, PR 후속)** — 두 레포 추적·미추적 md 전부(bun 21 · next-bun 16), 항목 S1 사실 불일치 · S2 경계 위반 · S3 낡은 참조 · S4 README 미반영 · S5 링크. 결함 5건 수정: bun `CLAUDE.md` 문서 경계 표의 `docs/conventions/` 링크(이동 때 누락 — 빈 디렉터리가 남아 링크 검사를 통과했다 → 디렉터리 삭제, 검사를 "빈 디렉터리 링크도 결함"으로 강화) · bun README `ci:all` 기준선 2026-08-12 `639/639` → **2026-09-23 재실측**(lint 0/경고 7, 스텁 0, 단위 647/647, E2E 79/79, build) · next-bun README 명령 표(`typecheck`·`ci:core`)·배포(verify 게이트·`paths-ignore`)·`.claude` 구성. 추가: 두 CLAUDE.md Commands에 **sandbox 함정** 1줄씩 — bun E2E는 sandbox 안에서 `listen EPERM`으로 76/79 실패(밖에서 79/79), next-bun build는 Google Fonts 차단. 과거 시점 기록(태스크 문서·KAKAO 본문)은 수정하지 않았다.
- **라우팅 표 정리 (2026-09-23, #238 머지 후)** — 사용자 지적: "자동 라우팅 표 패턴이 남아 있다". 판정: 표 자체가 아니라 **자동 로드되는 대상을 가리키는 행**이 중복이다(글로벌 `4b37046`이 없앤 "모델의 자발적 Read에 의존하는 약한 고리"와 같은 유형). 경로로 조건을 걸 수 없는 문서(playbook·lessons·태스크·deploy·진단)는 다른 로드 경로가 없어 표에 남긴다. bun: `code-patterns`·프론트 레포 행 삭제, "자동 로드되는 것" 절 신설, 표 제목 "자동 로드되지 않는 문서"(180줄). next-bun: `docs/assistant_rules_ui.md`·`_nextauth.md` → `.claude/rules/ui.md`(`src/**/*.tsx`·`*.css`)·`nextauth.md`(auth 파일 4경로)로 이동하고 해당 행·백엔드 계약 행(→ 스킬 `bun`) 삭제(63줄·3,148자). **실측**: 백엔드 세션에서 프론트 `.tsx` Read → `ui.md` 훅 주입 / 프론트 세션에서 `src/lib/auth.ts` Read → `nextauth.md` 네이티브 자동 로드. 작성 중 결함 1건: 훅 헤더 문구에 넣은 큰따옴표가 `HEADER="…"`를 깨뜨림(테스트는 헤더를 안 봐서 통과) → 수정 + "stderr 없음·헤더 온전" 회귀 검사 추가(변이로 검출 확인). 훅 테스트 28/0 ×2.
- **PR (2026-09-23)**: bun [#238](https://github.com/kon6443/bun/pull/238) · next-bun [#316](https://github.com/kon6443/next-bun/pull/316) — 둘 다 `feat-onam → develop`, MERGEABLE, 커밋 10·9개(이번 작업분만). `develop` 머지는 배포를 트리거하지 않는다(배포 워크플로는 `main` push 전용).

# Claude 설정·문서 전수조사 — 작업 기록

> 날짜 절을 맨 아래에 추가한다. 통째로 읽지 말고 `grep -n "^## "`로 절을 찾는다.

## 2026-10-07 — 착수
- 레포 위치 실측: 요청 경로와 실제 경로가 달라 실제 위치로 조사(경로는 레포 밖 메모리에만 둔다). 레거시 버전 레포는 제외
- 조사 대상(백엔드 `.claude/`): `agents/frontend-researcher.md` · `commands/review-flow.md` · `hooks/{inject-sibling-claudemd,precompact,test-inject-sibling-claudemd}.sh` · `rules/code-patterns.md` · `settings.json` · `settings.local.json` · `skills/next-bun/SKILL.md`
- 조사 대상(md): `CLAUDE.md` · `README.md` · `docs/**` 15개 · `tasks/fix-oracle-timezone.md`(루트 `tasks/` — 위치 이질)
- 작업 트리 선재 변경: `CLAUDE.md`(카카오 지연 라우팅 행 추가, 미커밋) 외 3파일 — 이 작업 범위 밖

## 2026-10-07 — S2 글로벌 비교 (에이전트 보고 + 메인 재확인)
- 구조: `~/.claude/{CLAUDE.md,rules,agents,settings.json,훅 .sh}` → `~/dotfiles/claude-config/` 심볼릭 링크. 스킬 7(dotfiles)+외부 6, 에이전트 4(전부 sonnet 읽기 전용)
- 상시 로드 실측(문자): 글로벌 CLAUDE.md 2,986 + 상시 rules 5개 7,416 + 프로젝트 CLAUDE.md 11,691 + MEMORY.md 602 = **22,695자 / 572줄**. 프로젝트 CLAUDE.md가 약 52%
- **[재확인 완료] 권한 완화 충돌**: 프로젝트 `.claude/settings.json:50-54` `Bash(curl:*)`·`Bash(nc:*)`·`Bash(claude:*)`·`Bash(gh:*)` (도입 `860c132` 2026-07-30). 글로벌은 `docs/decisions.md` 2026-09-03에 무제한 허용 제거 → 프로젝트가 되살린 상태. deny(파이프 실행·repo delete·skip-permissions)와 글로벌 ask(gh pr create 등)는 우선순위상 여전히 적용(공식: deny→ask→allow) — 단 `curl -X POST`·`nc`는 무프롬프트
- `settings.local.json`은 전역 gitignore(`~/.config/git/ignore:1`) — 일회성 `git diff`·`perl -0pi` 허용 누적(정리 후보)
- 중복: 커밋 승인 규칙 최대 5곳(CLAUDE.md 3·memory 1·permissions 1), 커밋 메시지 규칙 약 4항목(git-hygiene vs CLAUDE.md), 프로젝트 ask 7개가 글로벌과 동일, deny 약 50개 동일
- 연관 프로젝트 조사 경로 3종 병존: 글로벌 `cross-project-researcher` · 프로젝트 `frontend-researcher` · 스킬 `next-bun`
- 리뷰 경로 2종: 글로벌 스킬 `review` · 프로젝트 커맨드 `review-flow` (내용 비교 미실시)
- memory: `feedback_code_review`·`feedback_commit_approval`은 CLAUDE.md와 중복, `feedback_infinite_review`·외부 레포 참조 메모리은 유일 정보
- 글로벌 쪽: 백업 파일(`*.bak*`) 8개+ 적체, `docs/decisions.md` 요약 수치(“CLAUDE.md 89줄” 등) 낡음 후보, 스킬 `review` description 1줄·when_to_use 없음

## 2026-10-07 — S3 비교 레포 B 비교 (에이전트 보고 + 메인 재확인)
- 대상: 비교 레포 B (NestJS 현행). CLAUDE.md 130줄 · rules 3개(code-patterns 171 · api-swagger-conventions 218 `paths: src/**/*.{dto,controller}.ts` · task-docs 17) · skills 4(task-doc·handoff·review-back·비교 레포 F) · 형제 deny-until-read 훅 552줄 + `node --test` 563줄
- **[재확인]** 비교 레포 CLAUDE.md:5-8 — 계층(SSOT) 선언 + "이 파일에 두지 않는 것: 휘발성 현황" 명시. 단 :62(엔티티 258개 2026-09-23)·:118(lint 487건) 날짜 수치는 잔존
- **[재확인]** 설정 파일 보호: 비교 레포 `Edit`+`Write(.claude/settings.json)` deny(:123-124) vs bun `Edit`만(:143) → bun은 Write 우회 틈
- **[재확인]** review-back SKILL.md:20-27 "부정 단언 2경로 규율"(탐색 범위 명시 + 비어휘적 경로 1개 이상)
- bun 우위: Never/Ask 분리 표, 문서 경계 표, lessons.md, PreCompact 자동 핸드오프, 단일 검증 명령 `ci:core`, 수치 배제 원칙
- 비교 레포 우위: path-scoped rule 파일 종류별 분할, 프로젝트 로컬 태스크 3층 rule/스킬, 대형 문서 "§0 먼저, 나머지는 grep 목차" 라우팅, playbook Part 2 반복작업 레시피, 형제 규약 강제력(deny)
- 이식 비추천: `scripts/db-select.js`(bun은 LOCAL=PROD DB), deny-until-read 훅(유지비 1,100줄+, bun 주입 방식의 실패 근거 없음)

## 2026-10-07 — S1 백엔드 전수조사 · S5 CLAUDE.md 상태값 (에이전트 보고 + 메인 재확인)
- 인벤토리: CLAUDE.md 180줄/11,691자 · code-patterns 204줄 · settings.json allow~55/deny~85/ask 11 · 훅 3(주입 155·precompact 145·테스트 108) · 스킬 1 · 에이전트 1(최종 커밋 2026-03-28) · 커맨드 1(frontmatter 없음). 마크다운 파일 링크 깨짐 0건
- **[재확인] CLAUDE.md:152 커밋 수 이미 낡음**: 문서 feat 25·test 18·fix 18·docs 16·refactor 4·chore 2 → 실측(`git log --format=%s | grep -cE '^type(\(|:)'`) feat 26·test 18·fix 22·docs 30·refactor 6·chore 8. :157 "fix 18건"도 낡음
- 상태값 위치: 이동 대상 14·39·105·130·138·152·157 / 날짜·태스크 ID 제거 대상 34·139·147 / 근거로 유지 91·136-137
- **[재확인]** `settings.local.json:22-23` `perl -0pi` 소스 변조 allow 2건(방어 제거 실험 잔재), `:7` `EXPRESS_PORT=3999 node *`·`:8` `NODE_PATH=* tsx *`(임의 실행)
- **[재확인]** `pnpm:*` allow(settings.json:18) + CLAUDE.md:89 `pnpm dev` 권장 — 앱 부팅 = TypeOrmModule 상용 DB 접속(Never 표 근거와 같은 경로)인데 무프롬프트
- 중복: ORA_SDTZ 4곳(CLAUDE.md Never·Date/Time, code-patterns §12, architecture.md) · Path Aliases 2곳 · architecture.md ↔ README 모듈 목록
- 훅: 주입 훅이 마커를 먼저 만들고 출력(:103-104, :137-138) → 최종 jq 실패 시 세션 내 재주입 안 됨(침묵 실패)
- 태스크 문서: nestjs-improvements 2,854줄(08-12 이후 정체) · monitoring 1,724줄(헤더 "미진행"인데 체크 70/101) · error-dto-refactor 완료(archive 후보) · 루트 `tasks/fix-oracle-timezone.md` 고아
- **정정(공식 문서 대조)**: "`cat .env` 미차단" 틀림 — Read deny는 Bash `cat`·`head`·`tail`·`sed`에도 적용(permissions 문서). `grep -r`처럼 파일명을 안 쓰는 명령만 예외 → sandbox `denyRead`가 보완

## 2026-10-07 — S4 공식 문서 대조 (메인 직접 확인)
| 주장 | 판정 | 출처 |
|---|---|---|
| CLAUDE.md 200줄 초과분은 로드 안 됨 | **틀림** — 권장 "파일당 200줄 미만 목표"(준수율·컨텍스트 이유). 200줄/25KB 절단은 auto memory `MEMORY.md`만 | docs/en/memory |
| `.claude/CLAUDE.md`·`CLAUDE.local.md` 미지원 | **틀림** — 둘 다 지원 | docs/en/memory |
| 블록 레벨 HTML 주석 | 주입 전 제거 → 관리자 메모를 토큰 0으로 보관 가능 | docs/en/memory |
| `/doctor prompt-audit` | 존재 — 낡은 지시·없는 파일 참조·상호 모순 감사, 승인 전 미적용 | docs/en/memory |
| @import | 컨텍스트 비용 줄지 않음(런치 시 로드), 최대 4홉 | docs/en/memory |
| 권한 순서 | deny → ask → allow, 구체성 무관. ask가 allow를 이김 | docs/en/permissions |
| curl 제한 | Bash 인자 패턴은 취약 — deny curl/wget + WebFetch(domain:) + sandbox 네트워크 allowlist 권장 | docs/en/permissions |
| Edit 규칙 범위 | 파일을 편집하는 모든 내장 도구 → `Write(...)` deny 별도 불필요 | docs/en/permissions |
| commands | skills로 통합 — 기존 commands 동작 유지, 스킬은 description·보조 파일·자동 로드 추가 | docs/en/skills |
| 스킬 이름 충돌 | personal(글로벌) > project | docs/en/skills |
| 에이전트 보고 중 output-styles·statusLine JSON 예시, "CI claude-code-action High" | 근거 부족/부정확 — 추천에서 제외 | — |

## 2026-10-07 — S7 프론트 세션 회신 취합
- 프론트 태스크 폴더: `../next-bun/docs/tasks/claude-config-audit/` (상세는 그쪽 WORKLOG)
- **[재확인]** 프론트 메모리 `MEMORY.md:25` "표시는 UTC 기준" ↔ `src/app/utils/dateUtils.ts:5` "브라우저 로컬 타임존으로 변환하여 표시" — 자동 로드 메모리가 틀린 규칙 주입
- **[재확인]** 프론트 `settings.local.json:16,17,29` `docker exec:*`·`redis-cli DEL`·`redis-cli FLUSHALL` allow — 프로젝트·글로벌 ask 정책 무력화
- **[재확인]** `package.json`에 dnd-kit 0건 — 메모리 "설치됨" 기록 틀림
- 기타: DB 금지 4중·blur 금지 3중 중복, `docs/assistant_workflow.md`가 DoD·글로벌 "질문 1개"와 충돌, backend-researcher 에이전트가 백엔드 계약 값을 복제(드리프트), CLAUDE.md 상태성 문구 L19·L35·L42·L44
- 프론트 질문 Q1(메모리 수정은 사용자 직접 적용?) · Q2(local 정리 범위) — 사용자 보고에 포함
- 회사명·타 프로젝트명 점검(D-003) 프론트 추가 회신: 설정 위반 1곳 `../next-bun/.claude/skills/bun/SKILL.md:7`(백엔드와 같은 주석) — 프론트 세션은 sandbox 쓰기 차단으로 미수정, 사용자 승인 대기. 프론트 태스크 폴더는 익명화 완료(재검사 0건)

## 2026-10-07 — 적용 (백엔드)
| 항목 | 결과 | 파일 |
|---|---|---|
| CLAUDE.md SSOT·수치 제거 (D-004) | 180줄/11,499자 → 139줄/8,249자. 수치·날짜·커밋 수·태스크 ID 0건(정규식 검사 잔여 2건은 "1줄 필수"·"에러 0건" 규칙 조건). Path Aliases·Date/Time·DB Migrations·Pitfalls를 rule로 이동, 이름 금지 규칙 Never 표 추가 | `CLAUDE.md` |
| rule 분할 (D-005) | `code-patterns.md` 삭제 → 7개. glob 전부 실제 파일 매칭, 중괄호 glob 공식 지원 확인(rule당 확장 1,000개 한도) | `.claude/rules/*.md` |
| 참조 갱신 | README AI 가이드·architecture·playbook·스킬 `next-bun` 계약 표 | 4파일 |
| B3 local 정리 | 28개 → 4개(임의 실행·소스 변조 `perl -0pi`·일회성 diff 제거) | `.claude/settings.local.json` |
| B1 network allow 제거 | **사용자 적용 대기** — `Edit(.claude/settings.json)` deny. 패치: `curl:*`·`nc:*`·`claude:*`·`gh:*` 4줄 삭제(JSON 유효 확인) | — |
| B9 review-flow → 스킬 | frontmatter·부정 단언 규율·인가 점검 추가, 프론트 빌드 명령 정정. 커맨드 삭제(sandbox 밖, 권한 확인 경유) | `.claude/skills/review-flow/SKILL.md` |
| B10 훅 침묵 실패 | 마커를 출력 성공 뒤 생성. 테스트 V6·종류별 rule 픽스처 추가. 변이 검사: 수정 전 훅으로 V6 실패 확인 | `.claude/hooks/*.sh` |
| B11 frontend-researcher | 프론트 사실 복제 삭제(폐기 정책 "UTC 표시·변환 금지"가 남아 있었음) → 프론트 CLAUDE.md SSOT + 양쪽 근거 대조 규율 | `.claude/agents/frontend-researcher.md` |
| 이름 익명화 | `tasks-claude-config.md` 53건 → 0, `lessons.md` 1건 → 0 | — |
| archive | 고아·폐기 정책 문서 이동 + 경고 헤더 | `docs/tasks/archive/fix-oracle-timezone.md` |
| B2 `pnpm dev` | 보류 (D-006) | — |

### prompt-audit 대체 감사 (D-007) — 지적 19건 처리
- 반영(원본 재확인 후): Pitfalls 깨진 참조 2(playbook·lessons) · playbook 클러스터 3 제목 모순 · `shouldSkipScheduler` 이름 · `*View` 서술 · WS 핸들러별 ValidationPipe(옵션에 whitelist·forbidNonWhitelisted 없음 — 전역 pipe의 WS 적용 여부는 미확인이라 단정 안 함) · "전역 Guard 없음"→"전역 인증 Guard" · `middleware` 누락 · architecture pubClient·TTL·날짜 중복 · CLAUDE.md 멀티 레플리카 3중 → 1 · 스킬 `ErrorCode` 위치 · lessons 타 프로젝트명 · 라우팅 "마이그레이션 절" → grep 안내 · typeorm-transactional 규칙을 미결 태스크와 정합("결정 전까지 쓰지 않는다")
- 후속(미반영): playbook 클러스터 2 ↔ `schema-migrations.md` 문장 중복, README 마이그레이션 작성 규칙 중복, README 스로틀 수치·요청 흐름 다이어그램, `docs/deploy.md` 미감사
- 오판 1건 정정: D-008

### 검증
- `pnpm ci:core` exit 0 — lint 에러 0·경고 7(README 기준선 동일), Test Suites 28/28, Tests 647/647, build 성공. ⚠️ 작업 트리에 다른 작업의 미커밋 `src/modules/auth/auth.service.ts`가 포함된 상태의 결과 — 커밋 시 커밋될 상태로 재검증 필요(lessons 2026-09-23)
- 훅 테스트 재부팅 후 PASS=32 FAIL=0 (프론트 사본 동기화로 C2-5 해소)
- 이름 노출 0건 · 옛 참조(`code-patterns`·`Pitfalls`) 0건 · 변경 md 상대 링크 깨짐 0건 · shellcheck 통과

## 2026-10-07 — 프론트 적용 상태 (재부팅 후 확인)
- 프론트 작업 트리에 패치 반영 확인: rules `ui.md`·`nextauth.md` → auth·components·services·socket·styles·tests, `review-front` 에이전트 신규, `assistant_workflow.md` 삭제, 훅 2파일 백엔드와 동일
- 사용자 직접 적용 남음: 프론트 R8(settings.json 커밋 전 리마인더 훅) · R2(메모리 정정) · R3(local 정리)

## 2026-10-07 — 프론트 재검증 회신 (next-bun-76)
- 반영 대조: 수정 13·삭제 3·신규 7, 파일별 줄수가 프론트 WORKLOG 표와 일치 — 누락·부분 반영 없음. 재부팅 전 1차 `git apply`가 sandbox로 중간 실패 → 해당 경로만 HEAD 복구 후 sandbox 밖 2차 적용 rc=0 (프론트 WORKLOG에 교훈 기록)
- 실제 레포 검증: 훅 테스트 32/0 + 백엔드와 cmp 동일 · rules glob 매칭(`tests`의 `*.test.tsx` 0건은 향후용 의도) · 이름 노출 0 · 옛 이름 참조 0 · `bun run lint` 에러 0(기존 경고 4, 미변경 파일) · `bun run typecheck` rc 0
- 사용자 직접 적용 3건: R8 settings.json 커밋 전 리마인더 훅 · R2 메모리 정정 · R3 local 28개 제거 (diff는 프론트 세션 scratchpad — 개인 경로 포함이라 커밋 문서에 미기재)
- 주의: 프론트 변경에 `UserAvatar.tsx` 주석 1줄 포함 → main push 시 배포 트리거(동작 변경 없음)

## 2026-10-08 — 사용자 직접 적용분 반영 확인
- 사용자가 적용 스크립트 실행(가짜 HOME 사본으로 2회 사전 시험 — 멱등 확인 후). 실측: 백엔드 `settings.json` allow에서 `curl`·`nc`·`claude`·`gh` 무제한 0건(diff 4줄 삭제만) · 프론트 커밋 전 리마인더 훅 1건 · 프론트 local allow 12개 · 프론트 메모리 "표시는 UTC"·dnd-kit 0건, `feedback_overflow_hidden.md` 삭제 · 백엔드 메모리 이름 금지 규칙 추가 · JSON 3파일 유효
- 남음: 권한 축소 탐침(curl 실행 시 프롬프트 여부), `/doctor prompt-audit` 교차 확인, 커밋 범위 결정

## 2026-10-08 — `/doctor prompt-audit` (사용자 실행, 대상 모델 Claude Opus 5.5)
- 범위: 프로젝트 CLAUDE.md·`.claude/{rules,skills,agents}` + 사용자 레벨 `~/.claude/{CLAUDE.md,rules,skills,agents}`(dotfiles 링크). settings·`.mcp.json` 미열람. 외부 설치 스킬·플러그인은 보고만
- Group 1 신호(영문 강조·hedge·사고 스캐폴드·화석·채점 어휘) 거의 0 — 유일 매치 `CLAUDE.md:25` "(MUST OBEY)" → **적용: 제거**(문장 자체가 이미 "작업 시작 전에 Read한다")
- High 2 (제안만): 전역 `CLAUDE.md:4` "rules 세션 시작 시 자동 로드" ↔ `task-folder.md`·`shell-portability.md` paths 한정 · 프로젝트 `review-flow` description이 전역 `review`를 "일반 정확성 리뷰"로 오기(실제는 플로우 QA, `~/.claude/skills/review/SKILL.md` 0~7단계)
- Medium 1 (제안만, 전 프로젝트 영향): 전역 `review` description 1줄·when_to_use 없음
- Flag 3: 전역 "lessons 파일" 위치 미정의(workflow·error-recovery·bugfix·plan) · `frontend-researcher` ↔ 전역 `cross-project-researcher` 역할 중첩 · 전역 workflow "Plan Mode Default"
- 사용자 지시로 로컬 지적 적용: `review-flow` description을 전역 `review`의 실제 역할(실행 검증·격리 반증·보안)에 맞게 정정. `frontend-researcher` ↔ 전역 `cross-project-researcher` 중첩은 유지 결정(계약 대조 규율·출력 표가 실질 차이, 통합하려면 전역 수정 필요)
- rules 로드 시점 공식 확인(memory 문서): `paths` 없는 rule = 세션 시작 시 로드 · `paths` rule = 일치 파일에 **Read/Write/Edit**할 때 로드(Grep·Glob·Bash는 트리거 아님) · `/compact` 후 루트 CLAUDE.md는 재주입, paths rule은 다시 일치할 때 재로드

## 2026-10-08 — 글로벌·프론트 감사 위임
- 글로벌: `claude-config-08` 세션에 전수조사 + `/doctor prompt-audit` + 백엔드 진단(prompt-audit G1~G5, 이전 비교 B1~B10, 공식 근거) 교차검증 지시. 회신 대기
- 프론트: `next-bun-76`에 prompt-audit 지시(사용자 레벨 지적은 보고만). 회신 대기
- 프론트 prompt-audit 회신(next-bun-76): 지적 8건 — 7건 적용(backend-researcher 낡은 개념 "fillable"·자기모순 값·단계 강제·고정 표·중복, review-front 단계 강제, components rules-of-hooks 기본값), 1건 flag(auth.md 모호 문구). 백엔드형 `review` 오서술은 프론트에 없음. 글로벌 지적 G-a(Non-Negotiable 압박 제목, 신규)·G-b·G-c(백엔드와 독립 일치)·G-d → claude-config-08 전달
- 정정: 프론트가 "R8·R3 사용자 적용 남음"으로 보고 → 디스크 실측상 이미 적용(훅 1건, local 12개) — 프론트에 통보

## 2026-10-08 — 글로벌 설정 위임 종료
- 사용자 지시: 글로벌 Claude 설정은 `claude-config-08` 세션이 전담. 이 세션은 글로벌 관련 확인·회신 취합을 하지 않는다(통보 완료). 이 태스크 범위는 백·프 로컬 설정으로 한정

## 2026-10-08 — 커밋 전 독립 리뷰 · 커밋
- 독립 리뷰(읽기 전용 에이전트): High 0 · Med 0 · Low 3. 코드 서술·심볼 실재, rule paths YAML·glob 매칭, 상대 링크 0 깨짐, 삭제 파일 참조 0, 이름·개인 경로·시크릿 0, 훅 32/0·shellcheck·JSON 유효, rule 간 모순 0
- Low 처리: ①`tasks-kakao-login-latency.md`의 운영 도메인 — 이미 커밋된 문서 3개(21회)·프론트 빌드 env에 있는 공개 API 주소라 유지(Caddyfile류 내부 설정과 다름, 타 작업 문서 내용 불변) ②권한 축소 — 정적 확인(프로젝트·글로벌·로컬 allow에 curl·nc 없음 → 실행 시 확인). auto mode에서는 실행 탐침이 분류기 승인과 구분되지 않아 생략 ③훅 병렬 호출 중복 주입 창 — 부작용 컨텍스트 중복뿐, 조치 없음
- 범위 밖 발견(후속): README `migrationsRun: false` 서술이 코드에 키 없음과 어긋날 수 있음
- 커밋: `86bf73d` 카카오 문서(CLAUDE.md 참조 대상 선커밋) · `2eacccd` 설정·문서 정비(22파일) · 이어서 이 태스크 기록. 제외: `auth.service.ts`·`tasks-error-dto-refactor.md`·`tasks-nestjs-improvements.md`(다른 작업)

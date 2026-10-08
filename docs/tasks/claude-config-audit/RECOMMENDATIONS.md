# Claude 설정 개선 추천안 (백엔드 bun · 프론트 next-bun)

> 조사 근거는 `WORKLOG.md`, 결정은 `DECISIONS.md`. 프론트 상세는 `../next-bun/docs/tasks/claude-config-audit/`.
> 이 문서는 **추천**이다 — 적용은 사용자 승인 후 항목별로 별건 진행한다.
> 공식 문서 출처: code.claude.com/docs/en/{memory,permissions,skills}

## P0 — 보안·정확성 (먼저)

| # | 레포 | 항목 | Before (지금) | After (적용 후) | 장점 | 단점 | 근거 |
|---|---|---|---|---|---|---|---|
| B1 | bun | 네트워크·CLI 전체 허용 제거 | `settings.json:50-54` `curl:*`·`nc:*`·`claude:*`·`gh:*` allow → `curl -X POST`·`nc` 무프롬프트 | 4줄 삭제 → 글로벌 allow(gh 읽기 계열)만 남고 나머지는 프롬프트. 웹 조회는 WebFetch 사용 | 외부 전송 경로 차단, 글로벌 결정(2026-09-03)과 정합 | curl·gh 사용 시 승인 1회 | permissions "Restrict Bash network tools" |
| B2 | bun | `pnpm dev`/`start`를 ask로 | `pnpm:*` allow → 앱 부팅이 곧 상용 DB 접속인데 무프롬프트 | `ask`에 `Bash(pnpm dev*)`·`Bash(pnpm start*)` 추가 (ask가 allow를 이김) | Never 표("부팅만으로 상용 DB")와 실제 권한 일치 | dev 실행마다 승인 | permissions 평가 순서 deny→ask→allow |
| B3 | bun | 개인 local allow 정리 | `settings.local.json` 소스 변조 `perl -0pi` 2건, 임의 실행 `node *`·`tsx *`, 일회성 `git diff` ~20건 | 위험·일회성 항목 삭제 | 무승인 소스 변조 경로 제거 | 없음(개인 파일) | WORKLOG S1 |
| F1 | next-bun | 프론트 메모리 오류 정정 | `MEMORY.md:25` "표시는 UTC" (코드는 로컬 표시), dnd-kit "설치됨"(실제 없음) | 2건 정정 + CLAUDE.md와 중복 6항목 삭제 | 매 세션 틀린 규칙 주입 중단 | 사용자 직접 적용(쓰기 차단 경로) | `dateUtils.ts:5` |
| F2 | next-bun | 개인 local allow 정리 | `docker exec:*`·`redis-cli FLUSHALL`·`redis-cli DEL` allow | 삭제 → ask 정책이 실제로 걸림 | 파괴 명령 무승인 실행 차단 | 프롬프트 증가 | WORKLOG S7 |

## P1 — CLAUDE.md 정리 (사용자 요구: 상태값 금지)

| # | 레포 | 항목 | Before | After | 장점 | 단점 | 근거 |
|---|---|---|---|---|---|---|---|
| B4 | bun | 상태값·수치 제거 | :39 "794ms 실측·반증됐다", :152 커밋 수(**이미 낡음** — 실측 feat 26·fix 22·docs 30), :157 "18건·revert 0건", :130 "18건", :14 "62.7%", :105 "0건" | 규칙 문장만 남김. 카카오 행은 "트리거 → 문서 경로"만 | 낡을 수치 소멸, 원칙 자기모순 해소 | 맥락 몇 줄 감소 | memory "Consistency" |
| B5 | bun | 근거 날짜·ID는 HTML 주석으로 | :34·:139·:147 "2026-08-12 D6" 등 본문에 노출 | `<!-- 근거: lessons 2026-08-12, D6 -->` 블록 주석으로 이동 | 사람용 근거 보존 + **토큰 0**(주입 전 제거) | 주석은 Claude가 못 봄(의도) | memory "HTML comments stripped" |
| B6 | bun | 중복 축소 | ORA_SDTZ 4곳, Path Aliases 2곳, 커밋 승인 3곳, "추측 금지" 2줄, DoD "Verification Story"가 글로벌과 중복 | 각 규칙 1곳(SSOT) + 나머지는 링크 | 상시 로드 11.7K자 감소, 충돌 여지 제거 | 편집 범위 중간 | memory "target under 200 lines" |
| F3 | next-bun | 상태성 문구 제거 | L19 "부분 정정됐다", L42 "약 9천 자", L35·L44 이력 포인터 | 경로만 남기고 수치는 HTML 주석 | 동일 | 동일 | 프론트 WORKLOG |
| F4 | next-bun | 중복·충돌 정리 | DB 금지 4중, blur 금지 3중(금지형↔허용형 어조 충돌), `assistant_workflow.md`가 DoD·"질문 1개"와 충돌 | 1곳 일원화, 충돌 줄 삭제 | 해석 불일치 제거 | 파일 삭제 시 승인 | 프론트 WORKLOG |
| X1 | 공통 | 정기 감사 | 수동 전수조사 | 적용 후·분기마다 `/doctor prompt-audit` | 낡은 지시·없는 파일 참조·모순 자동 탐지, 승인 전 미적용 | 결과 재확인 필요 | memory "Audit your instruction files" |

## P2 — 구조 개선 (선택)

| # | 레포 | 항목 | Before | After | 장점 | 단점 |
|---|---|---|---|---|---|---|
| B7 | bun | code-patterns 파일 종류별 분할 | 204줄 1개가 `src/test/migrations` 전체에 로드 | 컨트롤러·DTO / 엔티티·마이그레이션 / 테스트 3개 rule (비교 레포 B 패턴) | 필요한 규칙만 로드 | 참조 경로 수정, 효과 측정 필요 |
| B8 | bun | 비대 태스크 문서 | nestjs-improvements 2,854줄, monitoring 헤더 "미진행"(실제 70/101 완료) | 쪼개지 않고 상단 §0 요약 + "나머지는 grep 목차" 라우팅, monitoring 헤더 갱신, 완료 문서 archive | 세션당 읽기량 감소, 상태 정확 | 진행 중 문서 편집은 충돌 주의 |
| B9 | bun | review-flow → 스킬 | 커맨드, frontmatter 없음, 글로벌 `review`와 역할 중복 | 스킬로 이관 + description, "부정 단언 2경로" 규율 6줄 추가 | 자동 발동·설명 품질 | 이름 충돌 시 글로벌이 이김 → 이름 유지 |
| B10 | bun | 주입 훅 침묵 실패 | 마커를 출력 전에 생성(:103-104, :137-138) | 출력 성공 후 마커 생성 | jq 실패 시 재시도 가능 | 회귀 테스트 갱신 |
| B11 | bun | 연관 레포 조사 경로 3종 | 글로벌 에이전트·프로젝트 에이전트(최종 커밋 03-28)·스킬 병존 | 스킬+훅 유지, 프로젝트 에이전트 정리 또는 역할 명문화 | 선택 혼선 제거 | — |
| F5 | next-bun | 읽기 전용 리뷰 에이전트·계약 대조 규율·커밋 전 리마인더 훅 | 메인 컨텍스트 자기 리뷰 | 비교 레포 F 패턴 이식 | 생성자 편향 제거 | 호출 비용 |

## 검토 후 제외

| 후보 | 제외 이유 |
|---|---|
| CI PR 자동 리뷰(claude-code-action) | 공개 저장소 + main push = 배포, 시크릿 관리 비용 대비 이득 불명확 |
| 플러그인 마켓플레이스로 규약 공유 | 레포 쌍 2개뿐, dotfiles 심볼릭 링크로 이미 공유 |
| Stop 훅 강제 재검증 | 무한 루프 위험 |
| deny-until-read 형제 훅 | 1,100줄+ 유지비, 현 주입 방식의 실패 근거 없음 |
| `Write(.claude/settings.json)` deny 추가 | 불필요 — Edit 규칙이 모든 편집 도구에 적용 |
| DB 조회 스크립트 | LOCAL = PROD DB라 조회도 상용 접속 |

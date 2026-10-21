# 백·프 2세션 운영 규칙 · Claude 설정 전수조사 · SELECT 허용 — 결정 로그

> 새 결정은 맨 아래에 추가한다. 기존 항목은 고치지 않고, 뒤집힐 때는 새 항목에 `supersedes D-00N`을 쓴다.
> **상태**: ✅ 확정 · 🟡 제안(사용자 확인 대기 — STATUS Q 번호와 연결).

## D-001 — 세션 운영 규칙 요구사항 원문 (2026-10-20)
- **상태**: ✅ 확정 (사용자 지시)
- **결정**:
  - 앞으로 모든 작업은 백·프 세션을 나눠 진행한다. 백엔드 작업·읽기는 백엔드 세션이, 프론트 작업·읽기는 프론트 세션이 한다.
  - 메인 세션은 백엔드 세션이고, 사용자는 백엔드 세션을 통해 모든 소통을 한다. 프론트 세션도 백엔드 세션을 통해 사용자와 소통한다.
  - 사용자가 따로 언급하지 않아도 이 방식으로 진행한다.
  - 로컬 Claude 설정에 넣는다 → 두 레포의 프로젝트 `CLAUDE.md`(글로벌은 다른 프로젝트에도 적용돼 부적합, 메모리는 쓰기 차단·비공유).
- **근거**: 2026-10-20 사용자 교정("프론트 프젝 리뷰를 너가 했어? 프론트 세션이 하도록") — `docs/lessons.md` 같은 날짜 절.

## D-002 — 세션 찾기는 사용자에게 묻는다 · 세션 표는 태스크 STATUS · 없으면 새 세션 요청 (2026-10-20)
- **상태**: ✅ 확정 (사용자 지시)
- **결정**:
  - 메인은 `ListAgents` 등으로 프론트 세션을 **직접 찾지 않고** 사용자에게 어느 세션인지 묻는다.
  - 태스크 폴더가 있으면 STATUS의 "세션·브랜치" 표(역할·세션·worktree·브랜치)에 세션을 기록하고, 그 표를 기준으로 진행한다. 세션이 바뀌면 표를 갱신한다.
  - 프론트 세션이 없으면 사용자에게 새 프론트 세션을 열어 달라고 요청한다.
- **버린 대안**: `ListAgents`에서 `next-bun-` 접두어로 자동 탐색 — 같은 레포 세션이 여러 개일 때(예: 다른 작업 중인 세션) 엉뚱한 세션에 지시가 갈 수 있다.

## D-003 — SELECT 허용: 기존 계정 + 앱 가드 전용 명령 `pnpm db:select` (2026-10-20)
- **상태**: ✅ 확정 (사용자 Q1: "기존 계정 + 앱 가드")
- **맥락**: 사용자는 SELECT를 허가 없이 쓰길 원한다. 지금은 CLAUDE.md Never("DB에 접속하는 명령 실행" — `list`조차 금지), `.claude/settings.json` deny(마이그레이션·`sqlplus`·`sql *`), 글로벌 `db-guard` 훅(스크립트 런타임의 쓰기 시그니처), sandbox `**/.env` 읽기 차단이 겹쳐 막는다. LOCAL=PROD라 쓰기 차단은 유지해야 한다.
- **결정**: SELECT 전용 명령 하나만 허용한다 — 임의 스크립트로 DataSource를 여는 것은 계속 Never.
  - 가드(순수 함수, 단위 테스트): 주석·문자열 리터럴을 지운 뒤 **문장 1개**, `SELECT`·`WITH`로 시작, `FOR UPDATE`·`INTO`·DML/DDL/PL/SQL 키워드(INSERT·UPDATE·DELETE·MERGE·CREATE·ALTER·DROP·TRUNCATE·GRANT·REVOKE·RENAME·COMMENT·BEGIN·DECLARE·EXEC·CALL·LOCK)·`DBMS_`/`UTL_` 패키지 호출 거부
  - 2차 방어: oracledb 연결을 `autoCommit` 없이 열고 `SET TRANSACTION READ ONLY` 뒤 실행, 끝나면 rollback — 가드를 우회한 DML도 ORA-01456로 거부
  - 운영 보호: 행 상한(`maxRows`, 기본 200), 호출 타임아웃(`callTimeout` 30초)
  - 민감 컬럼 가림: 결과 컬럼명이 TOKEN·SECRET·PASSWORD·WEBHOOK·WALLET 패턴이면 값 `[REDACTED]`(`USERS.KAKAO_REFRESH_TOKEN`, `TEAMS.DISCORD_WEBHOOK_URL` 등)
  - 권한: `.claude/settings.json`에 `Bash(pnpm db:select*)` allow + sandbox 밖 실행(`.env` 읽기 필요) — settings.json은 이 세션에서 쓰기 차단이라 **diff를 사용자에게 제시**하고 사용자가 적용
  - 문서: CLAUDE.md Never 표 DB 행에 예외 1줄, README 명령표, `.claude/rules/schema-migrations.md` 등 관련 서술 정합
- **근거**: 사용자 선택. 읽기 전용 DB 계정(권장안)은 DDL·.env 추가가 필요해 이번엔 보류 — 가드 + READ ONLY 트랜잭션 2겹으로 쓰기를 막는다.
- **버린 대안**: 읽기 전용 계정(이번 보류, 후속 후보), 가드 없이 READ ONLY 트랜잭션만(DDL은 트랜잭션 밖이라 못 막음 — Oracle DDL 암묵 커밋), `sqlplus` 허용(문장 제한 불가).
- **검증 조건(머지 전 차단)**: 가드 단위 테스트 + 담당자 탐침 — SELECT 성공(허가 프롬프트 없이), DML·DDL·다중 문장 거부, 가드 우회 DML(0행 갱신문)이 READ ONLY로 ORA-01456. 쓰기 탐침은 AI가 실행하지 않는다(Never) — 사용자가 `!`로 실행.

## D-004 — 상대 레포 계약 요지는 사본을 두지 않고 항상 상대 세션에 질의 (2026-10-20)
- **상태**: ✅ 확정 (사용자: "사본 없이 항상 질의")
- **결정**: 백엔드 `skills/next-bun`·프론트 `skills/bun`·rules에 복제된 계약 값(응답 구조·에러 코드·쿠키·namespace·room 등)을 걷어내고, 계약 확인은 상대 세션 질의로 한다.
- **영향**: 백엔드 S1·프론트 F-01·F-18 조치 방향.

## D-005 — 문서로만 있던 승인 항목을 설정으로 강제, 읽기 명령·로컬 docker는 자유 허용 (2026-10-20)
- **상태**: 🟡 방향 확정, 항목 목록은 사용자 확인 대기(Q3) — 사용자: "ask로 추가하는데, 읽는 명령어는 모두 자유롭게 허가하고, docker 로컬에서 하는 건 테스트용이라 다 허가해도 괜찮을 것 같은데? 일단 다 확인받아봐"
- **결정(방향)**: 커밋·푸시·머지·의존성 추가 등 되돌리기 어려운 동작은 양쪽 settings `ask`에 넣는다. 읽기 명령은 `allow`. docker는 로컬 테스트용 명령을 `allow`하되 원격·운영에 닿을 수 있는 하위명령(스택·서비스·컨텍스트·푸시 등)만 `ask`로 남긴다(ask가 allow보다 우선).

## D-006 — DB 차단 구멍 2건을 SELECT 허용과 함께 막는다 (2026-10-20)
- **상태**: ✅ 확정 (사용자: "함께 막기")
- **결정**: ① 프로젝트 deny에 경로 접두 `tsx`·`npx tsx`·`node`로 typeorm CLI를 실행하는 패턴 추가(A1) ② 글로벌 `~/.claude/db-guard.sh` DB_CONN에 ESM `import … oracledb`·`getConnection`·`ORACLE_DB_` 보강(A2). 둘 다 세션 쓰기 차단 파일이라 diff 제시 → 사용자 적용 → DB에 붙지 않는 더미로 탐침.

## D-007 — 상대 레포 읽기 경계: 기본은 상대 세션에 질의, 계약 산출물만 직접 확인 (2026-10-20)
- **상태**: ✅ 확정 (사용자: "전부 추천대로 진행")
- **결정**:
  - 백엔드 세션은 프론트 소스를, 프론트 세션은 백엔드 소스를 **읽지 않는다**. 필요하면 상대 세션에 질의하고, 답은 `파일:라인 + 인용`, 정확성 책임은 답한 세션.
  - 예외: **자동 생성되는 계약 산출물**만 직접 확인한다 — 로컬 백엔드가 떠 있을 때 Swagger JSON(`/api/v1/docs-json`). Swagger에 없는 것(소켓 이벤트·동작·영향 판단)은 질의.
  - 걷어낼 교차 장치(worktree에서 이미 조용히 고장, F-03·F-05·W1): 형제 레포 규약 주입 훅(양쪽 `inject-sibling-claudemd.sh` + 등록), 상대 레포 조사 에이전트(백엔드 `frontend-researcher`·프론트 `backend-researcher`), 상대 레포 읽기·수정을 지시하는 스킬 서술(백엔드 `next-bun`·프론트 `bun`), `additionalDirectories`·`Read(../next-bun/**)` 같은 상대 레포 경로 권한, 리뷰 스킬·에이전트의 상대 레포 grep.
- **근거**: 업계 contract-first(소스 대신 OpenAPI·이벤트 명세 + 질의). D-001 "백엔드 작업·읽기는 백엔드 세션"과 문자 그대로 일치. 사용자 "안 읽고 물어봐도 된다면 그렇게 해도"·"아주 필요한 건 읽었으면" → 계약 산출물 예외로 충족.
- **버린 대안**: 서로 전혀 안 읽기(Swagger조차 질의 — 왕복 과다), 계약 확인용 소스 읽기 허용(읽기·쓰기를 기계적으로 가를 장치 없음, 교차 장치를 worktree용으로 고쳐야 함).

## D-008 — 권한 변경안 확정: 백엔드는 우선순위 반영 수정안, 프론트는 프론트 초안 (2026-10-20)
- **상태**: ✅ 확정 (사용자: "전부 추천대로 진행") — supersedes D-005의 "방향만" 상태
- **결정**: 양쪽 `.claude/settings.json`(세션 쓰기 차단 → diff 제시·사용자 적용)
  - allow: 읽기 명령 보강(git rev-parse·ls-files·ls-remote·worktree list·blame·grep·check-ignore·merge-base, gh pr/run 읽기·run watch, rg·pwd·which·stat·file·tree·realpath·cut·tr), `pnpm install --frozen-lockfile`
  - ask: git commit·push·merge·rebase·tag·stash·cherry-pick·revert·worktree remove / gh pr create·merge·close·edit·comment·review·issue 쓰기·workflow run·run rerun·cancel·api / pnpm add·remove·rm·uninstall·update·up·upgrade·`install`(정확)·`i`·`--no-frozen-lockfile*`·`--fix-lockfile*`·import·dlx, npm·yarn 동등 — 글로벌과 겹쳐도 레포 정책으로 명시
  - deny: `Write(.claude/settings.json)`, `Edit|Write(.claude/settings.local.json)`, 백엔드 typeorm CLI 경로 접두 실행(D-006 ①), 프론트 `pnpm test`·`npm test`·`pnpm vitest`·`npx vitest`(정확 일치)
  - sandbox(백엔드): `excludedCommands: ["pnpm db:select *"]`
  - docker는 프로젝트에 넣지 않는다 — D-009
- **근거**: 우선순위 deny > ask > allow(범위 무관) 점검 — `pnpm install*`를 ask에 두면 frozen 예외 불가, 글로벌 ask `docker *`는 프로젝트 allow로 못 이김(WORKLOG 권한 변경안 절).

## D-009 — 글로벌 설정 변경(docker ask 정리 · db-guard 보강)은 `claude-config-7a` 세션이 사용자와 직접 진행 (2026-10-20)
- **상태**: ✅ 확정 (사용자: "claude-config-7a 이 세션한테 전달하고 여기서 작업하도록. 넌 이거 신경쓰지마. 걔보고 나한테 다 물어보고 하라해")
- **결정**: D-005의 docker 로컬 허용(글로벌 ask `docker *` 제거 + 원격·운영만 ask)과 D-006 ②(글로벌 db-guard DB_CONN·RUNTIMES 보강)를 `claude-config-7a`에 이관(2026-10-20 메시지). 이 태스크는 결과만 받는다 — 메인이 추적·확인하지 않는다.

## D-010 — 프로젝트 allow에 `Bash(docker:*)`를 둔다 (supersedes D-008의 "docker는 프로젝트에 넣지 않는다") (2026-10-20)
- **상태**: ✅ 확정 (D-005 사용자 의도 "로컬 docker는 다 허가"의 구현 보정, 메인)
- **맥락**: `claude-config-7a`가 글로벌 ask `docker *`를 원격·운영·대량 삭제 18패턴으로 좁혔다(사용자 승인, 글로벌 allow에는 docker 없음). 그런데 양쪽 프로젝트 settings에도 docker allow가 없어, **아무 규칙에도 안 걸린 docker 명령은 기본 동작대로 매번 묻는다** — D-005 의도와 다름.
- **결정**: 양쪽 프로젝트 `permissions.allow`에 `Bash(docker:*)` 추가(사용자 적용). 위험 명령은 글로벌 ask가 allow보다 우선해 계속 확인된다.
- **영향**: 백엔드 diff(세션 scratchpad `bun-settings.docker.json`), 프론트는 next-bun-6c 패치.

## D-011 — `pnpm install *`를 ask로, typeorm의 pnpm 경유 실행을 deny로 (supersedes D-008의 `pnpm install --frozen-lockfile` allow) (2026-10-20)
- **상태**: ✅ 메인 결정(리뷰 D2·D3 반영) — settings 적용은 사용자
- **맥락**: 백엔드 리뷰(WORKLOG 2026-10-20 리뷰 절) — ① ask가 `pnpm install`(정확)뿐이라 `pnpm install foo`·`-D foo`가 `Bash(pnpm:*)` allow로 확인 없이 의존성을 추가한다(CLAUDE.md Ask "새 의존성 추가"가 강제되지 않음). ② `pnpm typeorm …`·`pnpm tsx …typeorm…`·`pnpm exec …typeorm…`이 deny에 없어 상용 마이그레이션이 확인 없이 돈다(D-006 의도 미완).
- **결정**: ask에 `Bash(pnpm install *)` 추가, allow의 `pnpm install --frozen-lockfile` 제거(ask가 이기므로 죽은 규칙). deny에 `Bash(pnpm typeorm *)`·`Bash(pnpm tsx *typeorm*)`·`Bash(pnpm exec *typeorm*)` 추가.
- **비용**: `pnpm install --frozen-lockfile`도 확인을 받는다(worktree 최초 설치 정도라 드묾). `pnpm db:migrate:create`는 명령 문자열에 typeorm이 없어 영향 없음.
- **영향**: 세션 scratchpad `bun-settings.d2d3.json`. 프론트도 같은 구멍(ask `install` 정확 일치)이 있으면 같은 보정 — next-bun-6c에 확인.

## D-012 — docker는 로컬 읽기·빌드만 allow (supersedes D-010) (2026-10-20)
- **상태**: ✅ 확정 — 사용자 선택 "읽기·빌드만 allow (Recommended)"
- **맥락**: 프론트 리뷰 2R(next-bun-6c, 두 리뷰어 공통) — `Bash(docker:*)`면 ① `docker run -v ~/.ssh:/x`·`-v .claude:/x` 마운트로 sandbox Read deny·settings 쓰기 차단을 우회 ② `rm -f`·`compose down -v`·`exec`가 묻지 않고 실행 ③ `docker -c <ctx>`(--context 단축형)가 글로벌 ask에 없음. 현재 docker context는 `desktop-linux`(로컬, `docker context show` 실측).
- **결정**: allow는 `docker ps*`·`images*`·`logs *`·`inspect *`·`build *`·`version*`·`info*`·`compose ps*`·`compose logs*`·`compose build*`만. 그 밖(`run`·`exec`·`rm`·`compose up/down` 등)은 기본 확인 요청. `compose up`도 compose 파일로 임의 마운트가 가능해 allow에서 뺐다. `-c` 단축형은 allow 목록에 걸리지 않아 자동으로 확인 요청(프론트는 ask에도 명시).
- **영향**: 백엔드 scratchpad `bun-settings.d012.json`(allow81) · 프론트 패치에 같은 목록 반영 요청.
- **보정(같은 날, 프론트 r3 지적)**: allow 목록 명령에 `-c <ctx>`(--context 단축형)를 붙이면(`docker ps -c remote`) allow에 걸려 원격 데몬으로 간다 → 양쪽 ask에 `Bash(docker -c*)`·`Bash(docker * -c *)` 추가. 부작용: `docker build -c N`(cpu-shares)도 확인.

## D-013 — docker build도 allow에서 뺀다 (D-012 보정) (2026-10-20)
- **상태**: ✅ 메인 결정(백엔드 리뷰 3회차 R3-1) — D-012 "우회 위험 제거"를 따른 보정, settings 적용은 사용자
- **맥락**: sandbox 안에서는 docker 소켓 접속이 막혀(`docker version` → `connect: operation not permitted`) docker는 사실상 sandbox 밖에서 돈다. 그 상태의 `docker build`는 임의 경로를 빌드 컨텍스트로 읽고(`docker build ~/.ssh`, `-f-` + `RUN cat`, `--secret src=…`) `-o type=local,dest=.claude`로 호스트에 쓴다 → `-v` 마운트와 같은 종류의 우회.
- **결정**: allow에서 `docker build *`·`docker compose build*` 제거. 남는 allow: ps·images·logs·inspect·version·info·compose ps·compose logs. 빌드는 매번 확인.
- **버린 대안**: ask에 `-o`·`--output`·`--secret`·`--ssh`·`-f-` 패턴 추가 — 컨텍스트 경로 지정(`docker build ~/.ssh`)은 못 막는다.
- **영향**: 백엔드 scratchpad `bun-settings.r31.json`(allow79·ask50·deny87) · CLAUDE.md Ask 표 docker 행 · 프론트 r3 패치에 같은 보정 요청.

## D-014 — `pnpm db:select` 경로 잔여 위험: 러너·가드 파일 수정 deny + 기록 (2026-10-20)
- **상태**: ✅ 메인 결정(최종 리뷰 A-3·B-2 교차 확정) — settings 적용은 사용자(일괄)
- **맥락**: `pnpm db:select`는 ① `Bash(pnpm:*)` allow로 묻지 않고 ② `sandbox.excludedCommands`로 sandbox 밖(`.env` 읽기·네트워크 제한 해제)에서 돌며 ③ 글로벌 db-guard의 HEAD 고정 검사는 `tsx scripts/db-select.ts` 직접 호출에만 적용된다. 그래서 러너·가드 파일을 고친 뒤 실행하면 임의 코드(DDL 포함)가 확인 없이 돈다. 러너 주석의 "고치면 다시 ask"도 pnpm 경로엔 거짓이었다.
- **결정**: deny에 `Edit/Write(scripts/db-select.ts)`·`Edit/Write(src/common/utils/sql-readonly.utils.ts)`(Edit deny는 sandbox 쓰기 차단에도 반영 → `sed -i`도 막힘). 러너 주석 정정. **잔여 위험**: `package.json`의 `db:select` 스크립트 변경·`node_modules` 변조·다른 cwd의 가짜 package.json(하네스 동작 미확인)은 남는다 — 근본 대책은 읽기 전용 DB 계정(STATUS 후속, 우선순위 상향).
- **비용**: 러너·가드 수정은 사용자가 deny를 잠시 풀거나 직접 고친다.
- **보정**: D-003 "권한" 줄의 `Bash(pnpm db:select*)` allow는 실제로는 없고 `Bash(pnpm:*)`가 덮는다.

## D-015 — 의존성 변경 ask를 별칭·앞 플래그 변형까지 넓힌다 (D-011 보정) (2026-10-20)
- **상태**: ✅ 메인 결정(프론트 머지 전 리뷰 교차 확정, 백엔드 동일 구조) — settings 적용은 사용자
- **맥락**: `pnpm un`(remove 별칭), `pnpm -w rm/up/upgrade …`, `pnpm dedupe`·`approve-builds`, `pnpm it`(install-test), `npm rm/r/un/remove/unlink/up/upgrade`, 인자 없는 `npm i`, `npm ci`, `npm --prefix . install x`가 ask를 비켜 `pnpm:*`·`npm:*` allow로 자동 허용됐다(별칭은 프론트 세션이 `help`로 실측).
- **결정**: 백엔드 ask에 위 변형 추가. 앞 플래그 변형은 `pnpm -* X *` 형태로 써서 `pnpm db:select "<SQL>"` 본문의 단어(up·un·rm 등)와 충돌하지 않게 했다(첫 인자가 `-`로 시작할 때만 매칭). 프론트는 r6(`pnpm * X *` 형태 — SQL 러너가 없어 충돌 없음, `pnpm it`은 watch 테스트라 deny).
- **영향**: 백 scratchpad `bun-settings.final2.json`(ask87).

## D-016 — 머지 전 리뷰 종료 기준: 코드 결함만 차단 (2026-10-20)
- **상태**: ✅ 확정 — 사용자 선택 "코드 결함만 차단 기준 (Recommended)"
- **맥락**: 리뷰 라운드마다 패키지 매니저 별칭·앞 옵션 변형 우회가 새로 나왔다(D-011·D-015·프론트 r6·r7). 근본 원인은 글로벌 allow `pnpm:*`·`npm:*`·`yarn:*`로, 프로젝트 ask로 별칭을 열거하는 방식은 수렴하지 않는다.
- **결정**: 이번 라운드(백 guardfix2·final3, 프 r7) 적용 후 확인 리뷰 1회에서 **SQL 가드·러너 코드 결함**이 없으면 커밋·머지. 남는 패키지 매니저 별칭 우회는 후속(머지 후 탐침)으로 기록하고, 근본 대책(글로벌 allow를 필요한 하위 명령으로 축소)은 claude-config-7a에 제안.

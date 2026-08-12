# 반복 이슈 플레이북 (Recurring Issues Playbook)

> 최종 확인일: 2026-08-12 · 근거: 전체 git 이력(2024-12-05~2026-08-12, 285커밋) 전수조사 — `fix`/`hotfix` 커밋 **18건 100% 분류** + 커밋 본문·수정 파일 교집합 실측
>
> **용도**: 버그·장애·회귀가 보고되면 아래 "반복 결함 클러스터"에서 유사 증상을 찾아 **최우선 확인 지점**부터 진단한다. 처음부터 코드를 훑지 않는다.
> **유지보수**: 같은 버그를 **두 번째** 만나면 이 문서에 클러스터를 추가한다 (글로벌 `error-recovery.md` #7 Postmortem 의무). 단발 결함은 "판정 참고"에 남기고, **2회 누적 시 클러스터로 승격**한다.

---

## Part 1. 반복 결함 클러스터

### 1. 팀 멤버십·인가 검증 누락 (fix 3건 + 관련 1건, 2026-08-07~08-12)

- **증상**: 인증된 사용자가 **소속되지 않은 팀**의 리소스를 조작하거나, 팀 room의 모든 이벤트를 수신한다. 예외도 로그도 남지 않는다.
- **대표 커밋**: `d4c5771`(08-07 태스크 생성·댓글 수정/삭제 멤버 검증 누락) · `54393a8`(08-12 `joinTeam` 인증 없음 폴백) · `02aefd8`(08-07 초대 토큰 중복 생성) · `95faefe`(08-07 `isValidRole` 프로토타입 체인 누수)
- **근본 원인**: **Guard가 인증까지만 담당하고, 인가(팀 멤버십·역할)는 각 핸들러가 개별 구현**한다 — SSOT가 없어 신규 핸들러마다 누락이 가능하다. `verifyTeamMemberAccess`라는 공용 검증이 있는데도 일부 경로가 `teamRepository` 직접 조회로 우회하고 있었다(존재·활성만 확인 → 멤버십 미확인).
- **최우선 확인**:
  1. `src/modules/team/team.service.ts` — 해당 메서드가 `verifyTeamMemberAccess`를 경유하는가, 아니면 `teamRepository.findOne`으로 존재만 보는가
  2. `src/modules/team/team.gateway.ts` — room 진입 핸들러에 WS Guard가 붙어 있고 멤버십 검증이 **무조건** 실행되는가
  3. `src/modules/team/team.controller.ts` — 관리 권한 필요한 경로에 `MANAGEMENT_ROLES.includes(...)` 체크가 있는가
- **⚠️ 함정 (재발 패턴)**: **검증을 `if (userId) { ... }` 같은 조건문으로 감싸면, 값이 없을 때 검증이 통째로 스킵되고 그대로 통과한다.** `54393a8`이 정확히 이 형태였다 — 가드가 앞단에서 막아줘서 실제로 뚫린 적은 없었지만, 팀 격리가 **가드 한 겹에만** 의존하는 상태였다. 반드시 **조기 차단(early return)으로 뒤집어** 검증이 무조건 실행되게 한다. HTTP 경로는 가드 + `verifyTeamMemberAccess` 2겹인 것과 대비하라.
- **예방책**: 접근 제어 E2E가 이미 있다 — `test/team-access-control.e2e-spec.ts`(HTTP), `test/team-gateway.e2e-spec.ts`·`test/fishing-gateway.e2e-spec.ts`(실제 소켓). 신규 엔드포인트/WS 이벤트를 추가하면 여기에 **비멤버 차단 케이스를 같은 커밋에서** 추가한다. 에러 경로는 status·code를 정확히 고정한다(느슨한 단정은 방어를 제거해도 통과한다 — CLAUDE.md Pitfalls #8).
- **부가**: 이 수정은 **API 계약 변경**을 동반했다 — 태스크 생성에서 팀 미존재·비활성 시 `404 TEAM_NOT_FOUND` → `403 TEAM_FORBIDDEN`. 멤버 검증이 활성 팀만 조인하므로 404 분기가 도달 불가가 된 것이다. 프론트(`../next-bun`)는 이미 403 문구만 매핑하고 있어 백엔드만 스펙을 못 지킨 상태였다 → **인가 수정 시 프론트 에러 매핑을 먼저 확인**하면 올바른 코드를 알 수 있다.

### 2. Entity ↔ DB 스키마 드리프트 (fix 2건, 2026-04~07)

- **증상**: 특정 기능 전체가 Oracle 에러로 붕괴한다 — `ORA-32795`(IDENTITY 컬럼에 명시 값 INSERT), `ORA-01722`(숫자 암묵 변환 실패), 타임존 불일치.
- **대표 커밋**: `669e338`(07-29 Entity 선언을 실제 DB 스키마와 일치) · `2c86d73`(04-14 타임존 컬럼 타입 정정)
- **근본 원인**: `synchronize: false` + `migration:generate` 미사용이라 **드리프트를 코드로 감지할 경로가 없다.** Entity의 `nullable`/`length`/`default`/`unique` 표기는 런타임에 아무 효과가 없고, 실제 제약은 DB만 강제한다. 선언이 거짓이면 코드를 읽는 사람이 잘못된 전제로 판단한다.
- **최우선 확인**: DDL을 추출해 Entity 선언과 대조한다. 특히 ① **PK의 IDENTITY 종류**(`GENERATED ALWAYS`면 `@PrimaryGeneratedColumn`을 써서 ID를 생략해야 함 — 예: `TASK_COMMENTS.COMMENT_ID`) ② **문자열 컬럼의 TS 타입**.
- **⚠️ 함정**: **문자열 컬럼을 `number`로 선언하면 Oracle이 컬럼 쪽을 숫자로 암묵 변환**하므로, 비숫자 값이 한 건이라도 생기면 `ORA-01722`로 해당 기능 전체가 깨진다. `USERS.KAKAO_ID`가 이 사례였다(DB는 `VARCHAR2(100)`, 유니크 제약도 없었음). 외부 API 값은 **도메인 진입 경계에서 한 번만** 변환한다(`getKakaoId()`에서 `String()` 1회).
- **예방책**: 스키마 변경은 **Entity 수정 + 마이그레이션 파일을 세트로** 제출한다. 민감정보 컬럼은 Entity에 아예 선언하지 않거나 `select: false`를 쓴다(TypeORM은 선언된 컬럼을 모든 `find`에서 SELECT한다 — `USERS.KAKAO_REFRESH_TOKEN` 미선언 유지 결정).

### 3. 폐기된 정책이 문서에 잔존 (**현재 미해결 잔재 1건** — 커밋은 클러스터 2와 공유)

- **증상**: AI/사람이 문서를 근거로 작업했는데 코드와 정반대다. 라우팅 표가 그 문서를 진입점으로 지정하고 있으면 **작업 시작 시점부터 틀린 전제**를 갖는다.
- **대표 커밋**: `2c86d73`(2026-04-14) — 날짜 정책을 "투과 방식(UTC+0, 변환 없음)" → **"UTC 저장 + 로컬(KST) 표시"** 로 전환하고 Entity 14개 컬럼을 `timestamp with time zone`으로 마이그레이션, `formatDateTime`의 timeZone을 `'UTC'` → `'Asia/Seoul'`로 변경, CLAUDE.md도 같은 커밋에서 갱신했다.
- **🔴 미해결 잔재**: **`docs/architecture.md`는 갱신되지 않아 약 4개월간 옛 정책을 유지하고 있다** (2026-08-12 실측):
  - L22 "날짜 컬럼: Oracle `TIMESTAMP` (timezone-naive)" ← 실제는 전 컬럼 `timestamp with time zone`
  - L24–31 "투과 방식 — 입력값=저장값=표시값(변환 없음), 프론트 `timeZone:'UTC'`로 표시" ← CLAUDE.md·`docs/deploy.md:50`과 정면 충돌
  - → **이 문서의 날짜 섹션을 근거로 삼지 말 것.** 날짜 규약의 SSOT는 CLAUDE.md "Date/Time Handling"과 [`../conventions/code-patterns.md`](../conventions/code-patterns.md) §12다.
- **근본 원인**: 정책 전환 커밋이 **그 정책을 서술한 모든 문서를 찾지 않았다.** 문서에 최종 확인일이 없어서 낡음을 감지할 신호도 없었다.
- **예방책**: 정책을 바꾸는 커밋에서는 **바뀐 용어로 `docs/` 전체를 grep**해 서술이 남은 문서를 전부 같은 커밋에서 갱신한다. 새 문서에는 헤더에 **최종 확인일 + 근거**를 적는다. 같은 유형의 낡음이 세션 메모리에서도 발생했다(`MEMORY.md`의 배포 명령·Redis 호스트가 4개월 낡아 매 세션 오염 — 삭제된 `infra/setup-redis.sh` 실행을 지시하고 있었다).

---

## Part 2. 판정 참고

### 반복 아님 — "활발한 개발"로 판정

- **Swarm 스택·CI 설정 (fix 10건, 2026-04-06~29에 집중)**: `76722f0`(YAML 저장명 일관화) · `d9ea315`(stack deploy 후 converge 동기 대기) · `8c9677b`(워크플로우 실패 가시성) · `c396dd0`(`configs.file` 상대경로) · `602924a`(paths whitelist 전환) · `60a3069`(Caddy host 모드 — 클라이언트 IP 보존) · `f85382b`(`.env` 로드 누락) · `7f02d81`(node_exporter hostname 템플릿) · `7be9932`(Redis 배치를 fs-01로 고정 — 라벨 제약) · `ea867fd`(Dockerfile pnpm 버전 고정).
  Swarm 마이그레이션 기간에 몰려 있고 원인이 각기 달라 **결함 클러스터가 아니다.** 다만 인프라 YAML 작업 시 공통 확인 지점은 있다: **경로 해석 기준(compose 파일 상대경로) · `.env` 로드 여부 · 노드 라벨 제약**. 이력·결정은 [`../tasks/archive/tasks-swarm-stack-migration.md`](../tasks/archive/tasks-swarm-stack-migration.md).

### 승격 대기 (1회 발생 — 2회째에 클러스터로 승격)

- **라우트 중복 등록**: `336b069`(04-29) — `AuthModule`과 `UsersModule`이 모두 `PUT /users/me`를 등록해, `AppModule` import 순서상 한쪽이 조용히 **dead 상태**였다. 신규 컨트롤러 추가 시 경로 충돌을 확인할 것. NestJS는 중복 등록을 에러로 알리지 않는다.
- **도메인 정책 조건 과잉**: `9f80b9d`(04-24) — 댓글 CRUD가 `actStatus=ACTIVE`를 요구해 보관함 태스크에 댓글을 달 수 없었다. 조회 필터를 쓰기 경로에 그대로 복사하면 발생한다.

### 판정 불가

- 없음. fix 커밋 18건 모두 본문에 사유가 기재되어 있어 분류 가능했다. **이 상태를 유지한다** — 특히 revert 커밋은 본문에 원인 1줄을 반드시 남긴다.

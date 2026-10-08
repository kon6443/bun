---
paths:
  - "**/*.spec.ts"
  - "**/*.e2e-spec.ts"
  - "test/**/*.ts"
  - "src/**/__spec__/**/*.ts"
---

# 테스트 — mock Repository + Factory (실제 DB 아님)

**spec에서 실제 DB에 붙으면 컨벤션 위반이다.** LOCAL과 PROD가 같은 Oracle DB라 연결 자체를 만들지 않는다 — NestJS에서 흔한 "실DB + 트랜잭션 롤백" 방식과 정반대다.

## 표준 헬퍼

- Mock: `src/common/__spec__/mock-repository.ts` → `createMockRepository()`, `createMockQueryBuilder()`
- Factory: `src/entities/__spec__/entity.factory.ts` → `createUser`/`createTeam`/`createTeamTask`… + 쿼리 결과용 `createTeamTaskView`/`createTeamMemberView`, 고정 시각 `FIXED_DATE`
- spec은 **도메인별로 나눈다**: `team.service.<도메인>.spec.ts`.

## E2E — DB에 접속하지 않는다

- `AppModule`을 import하지 않는다 — `TypeOrmModule`이 부팅만으로 상용 DB에 붙는다. `test/helpers/e2e-app.ts`의 `createE2eApp()`(WS는 `ws-e2e-app.ts`)을 쓴다.
- `test/setup/forbid-db.ts`가 oracledb 드라이버 레벨에서 연결을 막는다. 롤백이 아니라 **연결이 없다**.
- 실행 명령과 sandbox·jest 옵션 함정은 CLAUDE.md "Commands".

## 단정 규칙

- **에러 경로는 status·code를 정확히 고정한다.** `expect([403, 404]).toContain(status)`처럼 느슨하게 받으면, 그 차이가 곧 방어의 유무일 때 테스트가 조용히 무력해진다. 방어를 걷어냈을 때 테스트가 깨지는지 확인하는 것이 유일한 검증법이다.
- **프로덕션 코드를 바꾸면 그 코드를 검증하는 테스트도 같은 커밋에서 고친다.**

---
paths:
  - "src/entities/**/*.ts"
  - "migrations/**/*.ts"
  - "migration-datasource.ts"
---

# 스키마 — Entity 선언과 마이그레이션 작성

> 마이그레이션 **실행**은 AI가 하지 않는다 (CLAUDE.md Never 표 — LOCAL과 PROD가 같은 DB). 여기는 **파일을 쓸 때** 지킬 것만 둔다. 명령어·파일명 규칙은 `README.md` "DB 마이그레이션".

## 마이그레이션 작성

- 스키마 변경은 항상 **Entity 수정 + 마이그레이션 파일을 세트로** 낸다 (드리프트 방지).
- **멱등 작성** — `USER_TAB_COLUMNS` 등으로 존재를 확인한 뒤 DDL을 실행한다.
- **1파일 = 1목적**, `down()` 필수(init 제외).
- **Oracle DDL은 자동 커밋**이다 — 중간에 실패하면 부분 적용으로 남는다. `migrationsTransactionMode`는 DDL에 무의미하므로 멱등 가드와 1파일 1목적이 유일한 방어책이다.
- `db:migrate:fake`는 베이스라인 등록 1회용이다 — pending이 있을 때 쓰면 DDL 없이 기록만 되어 조용히 미적용된다.
- `migration:show`(=`db:migrate:list`)도 이력 테이블을 만든다 — 읽기 전용이 아니다.

## Entity 선언 함정

- **`nullable`/`length`/`default`는 런타임 효과가 없다** — `synchronize: false`이고 `migration:generate`를 쓰지 않으므로 스키마에 반영되는 경로가 없다. 실제 제약은 DB가 강제한다.
- **PK 선언은 DB의 IDENTITY 종류와 맞춘다** — `GENERATED ALWAYS AS IDENTITY` 컬럼에 값을 넣으면 ORA-32795로 거부된다. `@PrimaryGeneratedColumn`으로 ID를 생략한다 (예: `TASK_COMMENTS.COMMENT_ID`, `TEAM_TELEGRAM_LINKS.LINK_ID`).
- **문자열 컬럼을 number로 선언하지 않는다** — Oracle이 컬럼 쪽을 숫자로 암묵 변환해 비교하므로 비숫자 값이 하나라도 생기면 ORA-01722로 기능 전체가 깨진다 (`USERS.KAKAO_ID` 사례). 외부 API 값은 도메인 진입 경계에서 한 번만 변환한다.
- **민감정보 컬럼은 Entity에 선언하지 않는다** — TypeORM은 선언된 컬럼을 모든 `find`에서 SELECT해 응답·로그로 샐 수 있다. 꼭 필요하면 `select: false` (`USERS.KAKAO_REFRESH_TOKEN`은 미선언 유지).
- 시각 컬럼 타입은 `datetime.md`.

## DB 스키마 변경 체크리스트

- [ ] Entity + 마이그레이션 세트
- [ ] 멱등 · 1파일 1목적 · `down()`
- [ ] PK가 DB IDENTITY 종류와 일치
- [ ] 🚫 실행하지 않는다 — 실행은 담당자에게 요청하고 완료 조건에서 분리해 보고

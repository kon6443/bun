# 팀 태스크 태그 — 스키마·계약 설계

> 결정 근거는 DECISIONS.md(D-번호). 이 문서는 "무엇을 만드는가"의 정본 — 결정이 바뀌면 여기를 먼저 고친다.
> 마이그레이션 파일: `migrations/1792396800000-CreateTeamTags.ts` · `migrations/1792396801000-CreateTeamTaskTags.ts` — 아래 DDL을 멱등 PL/SQL 가드로 감쌌다(객체 이름은 기존 `IDX_`·`UK_`·`<TABLE>_<COL>_CK` 관례). **실행은 담당자.**

## 1. DDL (D-003·D-012·D-014·D-017·D-018)

### 1-1. `TEAM_TAGS` — 팀별 태그 정의

```sql
CREATE TABLE "TEAM_TAGS" (
  "TAG_ID"     NUMBER GENERATED ALWAYS AS IDENTITY NOT NULL,
  "TEAM_ID"    NUMBER NOT NULL,
  "TAG_NAME"   VARCHAR2(80 BYTE) NOT NULL,
  "TAG_COLOR"  VARCHAR2(7 BYTE) NOT NULL,
  "SORT_ORDER" NUMBER NOT NULL,
  "CRTD_AT"    TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "CRTD_BY"    NUMBER,
  "MDFD_AT"    TIMESTAMP (6) WITH TIME ZONE,
  CONSTRAINT "PK_TEAM_TAGS" PRIMARY KEY ("TAG_ID"),
  CONSTRAINT "TEAM_TAGS_COLOR_CK" CHECK (REGEXP_LIKE("TAG_COLOR", '^#[0-9A-F]{6}$')),
  CONSTRAINT "FK_TEAM_TAGS_TEAM" FOREIGN KEY ("TEAM_ID") REFERENCES "TEAMS" ("TEAM_ID") ON DELETE CASCADE,
  CONSTRAINT "FK_TEAM_TAGS_USER" FOREIGN KEY ("CRTD_BY") REFERENCES "USERS" ("USER_ID") ON DELETE SET NULL
);

-- 팀 안에서 이름 중복 금지 (대소문자 무시 — 앞뒤 공백은 앱이 저장 전 trim)
CREATE UNIQUE INDEX "UK_TEAM_TAGS_TEAM_NAME" ON "TEAM_TAGS" ("TEAM_ID", UPPER("TAG_NAME"));
-- 팀 태그 목록 정렬 조회용 (재정렬 중 일시 중복을 허용하려고 유니크가 아님)
CREATE INDEX "IDX_TEAM_TAGS_TEAM_SORT" ON "TEAM_TAGS" ("TEAM_ID", "SORT_ORDER");

COMMENT ON TABLE  "TEAM_TAGS"              IS '팀 태그 정의. 팀 단위로 관리하며 활성 팀원 누구나 생성·수정·삭제·정렬한다. 삭제는 하드 삭제(TEAM_TASK_TAGS 연결도 CASCADE 삭제)';
COMMENT ON COLUMN "TEAM_TAGS"."TAG_ID"     IS '태그 ID (PK, IDENTITY)';
COMMENT ON COLUMN "TEAM_TAGS"."TEAM_ID"    IS '소속 팀 ID (FK → TEAMS.TEAM_ID, 팀 삭제 시 CASCADE)';
COMMENT ON COLUMN "TEAM_TAGS"."TAG_NAME"   IS '태그 이름. 앞뒤 공백 제거 후 1~20자. 팀 안에서 대소문자 무시 유니크(UK_TEAM_TAGS_TEAM_NAME)';
COMMENT ON COLUMN "TEAM_TAGS"."TAG_COLOR"  IS '태그 색. #RRGGBB 대문자 HEX(투명도 없음). 칩 글자색은 저장하지 않고 화면에서 대비로 계산';
COMMENT ON COLUMN "TEAM_TAGS"."SORT_ORDER" IS '팀 안 표시 순서(오름차순). 생성 시 팀 최댓값+1, 태그 관리 모달 드래그로 재정렬. 삭제로 생긴 빈 번호는 허용(상대 순서만 의미)';
COMMENT ON COLUMN "TEAM_TAGS"."CRTD_AT"    IS '생성 시각 (UTC)';
COMMENT ON COLUMN "TEAM_TAGS"."CRTD_BY"    IS '생성자 사용자 ID (FK → USERS.USER_ID, 사용자 삭제 시 NULL — 태그는 팀 자산이라 남긴다)';
COMMENT ON COLUMN "TEAM_TAGS"."MDFD_AT"    IS '이름·색·순서 마지막 수정 시각 (UTC). 생성 후 미수정이면 NULL';
```

### 1-2. `TEAM_TASK_TAGS` — 태스크↔태그 연결

```sql
CREATE TABLE "TEAM_TASK_TAGS" (
  "TASK_ID" NUMBER NOT NULL,
  "TAG_ID"  NUMBER NOT NULL,
  "CRTD_AT" TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "PK_TEAM_TASK_TAGS" PRIMARY KEY ("TASK_ID", "TAG_ID"),
  CONSTRAINT "FK_TEAM_TASK_TAGS_TASK" FOREIGN KEY ("TASK_ID") REFERENCES "TEAM_TASKS" ("TASK_ID") ON DELETE CASCADE,
  CONSTRAINT "FK_TEAM_TASK_TAGS_TAG"  FOREIGN KEY ("TAG_ID")  REFERENCES "TEAM_TAGS" ("TAG_ID") ON DELETE CASCADE
);

-- 태그 삭제 CASCADE·태그별 사용 수(taskCount) 집계용. PK가 (TASK_ID, TAG_ID)라 TAG_ID 단독 조회에 필요
CREATE INDEX "IDX_TEAM_TASK_TAGS_TAG" ON "TEAM_TASK_TAGS" ("TAG_ID");

COMMENT ON TABLE  "TEAM_TASK_TAGS"           IS '태스크-태그 연결(N:M). 태스크당 최대 10개(앱 검증). 태스크와 태그는 같은 팀이어야 한다(앱 검증)';
COMMENT ON COLUMN "TEAM_TASK_TAGS"."TASK_ID" IS '태스크 ID (PK, FK → TEAM_TASKS.TASK_ID, CASCADE)';
COMMENT ON COLUMN "TEAM_TASK_TAGS"."TAG_ID"  IS '태그 ID (PK, FK → TEAM_TAGS.TAG_ID, 태그 삭제 시 CASCADE로 연결 제거)';
COMMENT ON COLUMN "TEAM_TASK_TAGS"."CRTD_AT" IS '태그를 붙인 시각 (UTC)';
```

### 1-3. 코멘트 확인 방법 (Oracle에는 `SHOW CREATE TABLE`이 없다)

```sql
-- ① 표 형태로 보기
SELECT table_name, comments FROM user_tab_comments WHERE table_name IN ('TEAM_TAGS', 'TEAM_TASK_TAGS');
SELECT table_name, column_name, comments FROM user_col_comments WHERE table_name IN ('TEAM_TAGS', 'TEAM_TASK_TAGS') ORDER BY table_name, column_name;

-- ② SHOW CREATE TABLE처럼 DDL로 보기 (CREATE TABLE 본문 + COMMENT 문)
SELECT DBMS_METADATA.GET_DDL('TABLE', 'TEAM_TAGS') FROM dual;
SELECT DBMS_METADATA.GET_DEPENDENT_DDL('COMMENT', 'TEAM_TAGS') FROM dual;
```
- 코멘트는 데이터 사전에 저장돼 테이블이 있는 한 유지된다. SQL Developer·DBeaver의 DDL 탭도 ②와 같은 결과를 보여준다.

## 2. REST 계약 (D-005·D-017)

| 메서드 · 경로 | 바디 | 응답 `data` |
|---|---|---|
| `GET /teams/:teamId/tags` | — | `[{ tagId, tagName, tagColor, sortOrder, taskCount }]` (`SORT_ORDER, TAG_ID` 오름차순) |
| `POST /teams/:teamId/tags` | `{ tagName, tagColor }` | 태그 (맨 뒤에 추가) |
| `PATCH /teams/:teamId/tags/:tagId` | `{ tagName?, tagColor? }` | 태그 |
| `DELETE /teams/:teamId/tags/:tagId` | — | — |
| `PUT /teams/:teamId/tags/order` | `{ tagIds: number[] }` — 팀의 **전체** 태그를 원하는 순서로 | 재정렬된 목록 |
| `POST/PATCH /teams/:teamId/tasks…` | 기존 + `tagIds?: number[]`(최대 10, 수정은 전체 교체) | 태스크 + `tags` |
| `GET` 태스크 목록·상세 | — | 각 태스크에 `tags: [{ tagId, tagName, tagColor }]` (태그 `SORT_ORDER` 순) |

- 재정렬 요청의 `tagIds`가 현재 팀 태그 집합과 다르면(그사이 누가 추가·삭제) **409** — 프론트는 목록을 다시 받아 안내한다.
- 모든 태그 응답(목록·생성·수정·재정렬)은 `taskCount`를 포함한다(보관 태스크 포함). `DELETE`의 `data`는 `null`. 서버가 `tagName` trim, `tagColor` 대문자화.
- 구현: `team-tag.controller.ts`·`team-tag.service.ts`·`team-tag.dto.ts`, 태스크 연결 헬퍼 `task-tags.ts`(D-021). 한도 상수 `app.constants.ts`.

### 2-1. 에러 코드 (구현 확정)
| 상황 | 상태 | 코드 |
|---|---|---|
| 태그 없음·다른 팀 태그 | 404 | `TEAM_TAG_NOT_FOUND` |
| 이름 중복 (앱 선검사 + DB 유니크 위반 변환) | 409 | `TEAM_TAG_DUPLICATE` |
| 팀당 100개 초과 | 400 | `TEAM_TAG_LIMIT_EXCEEDED` |
| 재정렬 집합 불일치 | 409 | `TEAM_TAG_ORDER_CONFLICT` |
| 태스크 `tagIds`에 다른 팀·없는 태그 | 400 | `TEAM_TASK_BAD_REQUEST` |
| 입력 형식 위반 (색 형식·21자·`tagIds` 11개·중복 등) | 422 | `VALIDATION_ERROR` (기존 전역 계약) |

## 3. 소켓 (room `team-{teamId}`, D-006·D-017) — 구현 확정

| 이벤트 | 페이로드 |
|---|---|
| `tagCreated` | `{ teamId, tagId, tagName, tagColor, sortOrder, createdBy }` |
| `tagUpdated` | `{ teamId, tagId, tagName, tagColor, sortOrder, updatedBy }` |
| `tagDeleted` | `{ teamId, tagId, deletedBy }` |
| `tagsReordered` | `{ teamId, tagIds, updatedBy }` |
| `taskCreated` · `taskUpdated` | 기존 + `tags`(항상 현재 전체 배열 — D-021) |
- 태그 이벤트에는 `taskCount`가 없다 — 프론트는 기존 값을 유지(생성은 0)한다.

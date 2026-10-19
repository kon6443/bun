import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 팀 태그 정의 테이블 생성 (docs/tasks/team-task-tags D-003·D-012·D-014·D-017·D-018, DDL 정본 DESIGN.md §1-1)
 *
 * 배경: 팀 단위로 태그(이름 + 색)를 만들어 태스크에 여러 개 붙인다. 활성 팀원 누구나 생성·수정·삭제·정렬한다.
 *
 * - TAG_NAME: 앱 제한 20자(trim 후). 한글·이모지 여유를 위해 80바이트.
 * - TAG_COLOR: #RRGGBB 대문자 — 앱이 정규화하고 CHECK가 우회 값을 막는다.
 * - SORT_ORDER: 팀 안 표시 순서. 재정렬 중 일시 중복을 허용하려고 유니크를 두지 않는다.
 * - (TEAM_ID, UPPER(TAG_NAME)) 유니크: 동시 생성 경쟁까지 막는 중복 이름 최종 방어선(대소문자 무시).
 * - CRTD_BY ON DELETE SET NULL: 태그는 팀 자산 — 만든 사람이 삭제돼도 남긴다(TEAM_TASKS.CRTD_BY의 CASCADE와 의도적으로 다름).
 *
 * 멱등: 테이블·인덱스는 존재 확인 후 생성한다. COMMENT ON은 재실행해도 덮어쓸 뿐이다.
 * 신규 테이블 추가라 기존 테이블·코드에 영향이 없다 — 앱 배포 전에 먼저 적용해도 된다.
 */
export class CreateTeamTags1792396800000 implements MigrationInterface {
  name = 'CreateTeamTags1792396800000';

  private static readonly TABLE_COMMENT =
    '팀 태그 정의. 팀 단위로 관리하며 활성 팀원 누구나 생성·수정·삭제·정렬한다. 삭제는 하드 삭제(TEAM_TASK_TAGS 연결도 CASCADE 삭제)';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    TAG_ID: '태그 ID (PK, IDENTITY)',
    TEAM_ID: '소속 팀 ID (FK → TEAMS.TEAM_ID, 팀 삭제 시 CASCADE)',
    TAG_NAME: '태그 이름. 앞뒤 공백 제거 후 1~20자. 팀 안에서 대소문자 무시 유니크(UK_TEAM_TAGS_TEAM_NAME)',
    TAG_COLOR: '태그 색. #RRGGBB 대문자 HEX(투명도 없음). 칩 글자색은 저장하지 않고 화면에서 대비로 계산',
    SORT_ORDER: '팀 안 표시 순서(오름차순). 생성 시 팀 최댓값+1, 태그 관리 모달 드래그로 재정렬. 삭제로 생긴 빈 번호는 허용(상대 순서만 의미)',
    CRTD_AT: '생성 시각 (UTC)',
    CRTD_BY: '생성자 사용자 ID (FK → USERS.USER_ID, 사용자 삭제 시 NULL — 태그는 팀 자산이라 남긴다)',
    MDFD_AT: '이름·색·순서 마지막 수정 시각 (UTC). 생성 후 미수정이면 NULL',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    // EXECUTE IMMEDIATE 문자열 안의 작은따옴표는 두 번 쓴다 (CHECK의 정규식 리터럴)
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TEAM_TAGS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "TEAM_TAGS" (
            "TAG_ID" NUMBER GENERATED ALWAYS AS IDENTITY NOT NULL,
            "TEAM_ID" NUMBER NOT NULL,
            "TAG_NAME" VARCHAR2(80 BYTE) NOT NULL,
            "TAG_COLOR" VARCHAR2(7 BYTE) NOT NULL,
            "SORT_ORDER" NUMBER NOT NULL,
            "CRTD_AT" TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            "CRTD_BY" NUMBER,
            "MDFD_AT" TIMESTAMP (6) WITH TIME ZONE,
            CONSTRAINT "PK_TEAM_TAGS" PRIMARY KEY ("TAG_ID"),
            CONSTRAINT "TEAM_TAGS_COLOR_CK" CHECK (REGEXP_LIKE("TAG_COLOR", ''^#[0-9A-F]{6}$'')),
            CONSTRAINT "FK_TEAM_TAGS_TEAM" FOREIGN KEY ("TEAM_ID") REFERENCES "TEAMS" ("TEAM_ID") ON DELETE CASCADE,
            CONSTRAINT "FK_TEAM_TAGS_USER" FOREIGN KEY ("CRTD_BY") REFERENCES "USERS" ("USER_ID") ON DELETE SET NULL
          )';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = 'UK_TEAM_TAGS_TEAM_NAME';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE UNIQUE INDEX "UK_TEAM_TAGS_TEAM_NAME" ON "TEAM_TAGS" ("TEAM_ID", UPPER("TAG_NAME"))';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = 'IDX_TEAM_TAGS_TEAM_SORT';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX "IDX_TEAM_TAGS_TEAM_SORT" ON "TEAM_TAGS" ("TEAM_ID", "SORT_ORDER")';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateTeamTags1792396800000;
    await queryRunner.query(`COMMENT ON TABLE "TEAM_TAGS" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "TEAM_TAGS"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 인덱스·제약·코멘트를 함께 제거한다. ⚠️ 팀 태그가 전부 사라진다.
    // TEAM_TASK_TAGS가 이 테이블을 참조하므로 CreateTeamTaskTags를 먼저 revert해야 한다(revert는 역순이라 자연히 지켜진다).
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TEAM_TAGS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "TEAM_TAGS" PURGE';
      END IF;
    END;`);
  }
}

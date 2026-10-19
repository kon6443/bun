import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 태스크↔태그 연결 테이블 생성 (docs/tasks/team-task-tags D-003·D-004·D-014·D-018, DDL 정본 DESIGN.md §1-2)
 *
 * - PK (TASK_ID, TAG_ID): 같은 태그를 한 태스크에 두 번 붙일 수 없다. 태스크별 태그 조회가 이 키로 들어온다.
 * - FK ON DELETE CASCADE: 태그 삭제(하드 삭제, D-004) 시 붙어 있던 연결이 함께 사라진다.
 * - (TAG_ID) 인덱스: 태그 삭제 CASCADE와 태그별 사용 수(taskCount) 집계용 — PK 선두 컬럼이 TASK_ID라 별도로 필요하다.
 * - 태스크당 최대 10개, 태스크와 태그가 같은 팀이라는 조건은 앱이 검증한다
 *   (팀 일치 복합 FK는 기존 TEAM_TASKS에 유니크 추가가 필요해 기존 테이블 무변경 원칙과 충돌).
 *
 * 선행: CreateTeamTags (FK 대상).
 */
export class CreateTeamTaskTags1792396801000 implements MigrationInterface {
  name = 'CreateTeamTaskTags1792396801000';

  private static readonly TABLE_COMMENT =
    '태스크-태그 연결(N:M). 태스크당 최대 10개(앱 검증). 태스크와 태그는 같은 팀이어야 한다(앱 검증)';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    TASK_ID: '태스크 ID (PK, FK → TEAM_TASKS.TASK_ID, CASCADE)',
    TAG_ID: '태그 ID (PK, FK → TEAM_TAGS.TAG_ID, 태그 삭제 시 CASCADE로 연결 제거)',
    CRTD_AT: '태그를 붙인 시각 (UTC)',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TEAM_TASK_TAGS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "TEAM_TASK_TAGS" (
            "TASK_ID" NUMBER NOT NULL,
            "TAG_ID" NUMBER NOT NULL,
            "CRTD_AT" TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT "PK_TEAM_TASK_TAGS" PRIMARY KEY ("TASK_ID", "TAG_ID"),
            CONSTRAINT "FK_TEAM_TASK_TAGS_TASK" FOREIGN KEY ("TASK_ID") REFERENCES "TEAM_TASKS" ("TASK_ID") ON DELETE CASCADE,
            CONSTRAINT "FK_TEAM_TASK_TAGS_TAG" FOREIGN KEY ("TAG_ID") REFERENCES "TEAM_TAGS" ("TAG_ID") ON DELETE CASCADE
          )';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = 'IDX_TEAM_TASK_TAGS_TAG';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX "IDX_TEAM_TASK_TAGS_TAG" ON "TEAM_TASK_TAGS" ("TAG_ID")';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateTeamTaskTags1792396801000;
    await queryRunner.query(`COMMENT ON TABLE "TEAM_TASK_TAGS" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "TEAM_TASK_TAGS"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ⚠️ 태스크에 붙인 태그 연결이 전부 사라진다(태그 정의는 TEAM_TAGS에 남는다).
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TEAM_TASK_TAGS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "TEAM_TASK_TAGS" PURGE';
      END IF;
    END;`);
  }
}

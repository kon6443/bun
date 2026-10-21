import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 사용자 피드백 테이블 생성 (docs/tasks/feedback D-003·D-004·D-008·D-009·D-011·D-013, 정본 DESIGN.md §1)
 *
 * 배경: 로그인 유저가 BNB 피드백 탭에서 제목·내용·카테고리를 남기고 마이페이지에서 내 피드백과 처리 상태를 본다.
 * 운영자는 디스코드·텔레그램 알림으로 받고, 상태·답변은 SQL로 갱신한다(관리자 화면 없음).
 *
 * - CATEGORY·STATUS: 코드값 + CHECK. 값을 늘리면 CHECK 교체 마이그레이션 1개.
 * - TITLE: 앱 제한 100자(trim 후). 한글·이모지 여유를 위해 400바이트.
 * - PAGE_PATH·USER_AGENT: 앱 제한 500자, 바이트 여유 2000. USER_AGENT는 서버가 요청 헤더에서 채운다.
 * - 수정·삭제 기능 없음(D-009) — IS_DELETED 없음. 사용자 삭제 시 피드백도 CASCADE(본인 데이터).
 * - IDX_FEEDBACKS_USER_ID: 내 목록 keyset(USER_ID = ? AND FEEDBACK_ID < ? ORDER BY FEEDBACK_ID DESC)과
 *   사용자당 24시간 작성 수 카운트(D-005)를 함께 받친다.
 *
 * 멱등: 테이블·인덱스는 존재 확인 후 생성한다. COMMENT ON은 재실행해도 덮어쓸 뿐이다.
 * 신규 테이블 추가라 기존 테이블·코드에 영향이 없다 — 앱 배포 전에 먼저 적용해도 된다.
 */
export class CreateFeedbacks1792553875000 implements MigrationInterface {
  name = 'CreateFeedbacks1792553875000';

  private static readonly TABLE_COMMENT =
    '사용자 피드백. 로그인 유저가 작성하고 본인만 조회한다. 작성 후 수정·삭제 불가. 운영자는 디스코드·텔레그램 알림으로 받고 STATUS·ADMIN_REPLY를 SQL로 갱신한다';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    FEEDBACK_ID: '피드백 ID (PK, IDENTITY)',
    USER_ID: '작성자 사용자 ID (FK → USERS.USER_ID, 사용자 삭제 시 CASCADE)',
    CATEGORY:
      '카테고리 코드. FEATURE 기능 추가 · BUG 버그 리포트 · IMPROVEMENT 개선 요청 · QUESTION 문의 · OTHER 기타',
    TITLE: '제목. 앞뒤 공백 제거 후 1~100자',
    CONTENT: '내용. 앞뒤 공백 제거 후 1~5000자 (길이는 앱이 검증)',
    STATUS:
      '처리 상태 코드. RECEIVED 접수(기본) · IN_PROGRESS 검토 중 · DONE 반영 완료 · REJECTED 반려. 운영자가 SQL로 갱신하며 갱신 시 MDFD_AT도 함께 갱신',
    ADMIN_REPLY: '운영자 답변. 작성자에게 상세 화면으로 보인다. 없으면 NULL',
    REPLIED_AT: '운영자 답변 시각 (UTC). ADMIN_REPLY를 쓸 때 함께 갱신. 없으면 NULL',
    PAGE_PATH: '작성 직전 화면 경로(프론트가 자동 첨부). 최대 500자. 없으면 NULL',
    USER_AGENT: '작성 요청의 User-Agent 헤더(서버가 저장, 500자에서 절단). 없으면 NULL',
    BUILD_SHA: '작성 시점 프론트 빌드 커밋 SHA(프론트가 자동 첨부, 7~40자 hex). 없으면 NULL',
    CRTD_AT: '작성 시각 (UTC)',
    MDFD_AT: '운영자의 상태·답변 마지막 갱신 시각 (UTC). 미갱신이면 NULL',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    // EXECUTE IMMEDIATE 문자열 안의 작은따옴표는 두 번 쓴다 (CHECK·DEFAULT의 문자열 리터럴)
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'FEEDBACKS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "FEEDBACKS" (
            "FEEDBACK_ID" NUMBER GENERATED ALWAYS AS IDENTITY NOT NULL,
            "USER_ID" NUMBER NOT NULL,
            "CATEGORY" VARCHAR2(20 BYTE) NOT NULL,
            "TITLE" VARCHAR2(400 BYTE) NOT NULL,
            "CONTENT" CLOB NOT NULL,
            "STATUS" VARCHAR2(20 BYTE) DEFAULT ''RECEIVED'' NOT NULL,
            "ADMIN_REPLY" CLOB,
            "REPLIED_AT" TIMESTAMP (6) WITH TIME ZONE,
            "PAGE_PATH" VARCHAR2(2000 BYTE),
            "USER_AGENT" VARCHAR2(2000 BYTE),
            "BUILD_SHA" VARCHAR2(40 BYTE),
            "CRTD_AT" TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            "MDFD_AT" TIMESTAMP (6) WITH TIME ZONE,
            CONSTRAINT "PK_FEEDBACKS" PRIMARY KEY ("FEEDBACK_ID"),
            CONSTRAINT "FEEDBACKS_CATEGORY_CK" CHECK ("CATEGORY" IN (''FEATURE'', ''BUG'', ''IMPROVEMENT'', ''QUESTION'', ''OTHER'')),
            CONSTRAINT "FEEDBACKS_STATUS_CK" CHECK ("STATUS" IN (''RECEIVED'', ''IN_PROGRESS'', ''DONE'', ''REJECTED'')),
            CONSTRAINT "FK_FEEDBACKS_USER" FOREIGN KEY ("USER_ID") REFERENCES "USERS" ("USER_ID") ON DELETE CASCADE
          )';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = 'IDX_FEEDBACKS_USER_ID';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX "IDX_FEEDBACKS_USER_ID" ON "FEEDBACKS" ("USER_ID", "FEEDBACK_ID")';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateFeedbacks1792553875000;
    await queryRunner.query(`COMMENT ON TABLE "FEEDBACKS" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "FEEDBACKS"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 인덱스·제약·코멘트를 함께 제거한다. ⚠️ 피드백과 운영자 답변이 전부 사라진다.
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'FEEDBACKS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "FEEDBACKS" PURGE';
      END IF;
    END;`);
  }
}

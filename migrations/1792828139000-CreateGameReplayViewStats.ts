import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 리플레이 조회 일별 집계 테이블 생성 (docs/tasks/replay-views D-001)
 *
 * 배경: 리플레이 조회수·시청시간을 보여주고, 기간별(일간·주간·전체) 인기 리플레이를 뽑는다.
 * 누적 컬럼 하나(GAME_SCORES.VIEW_COUNT)로는 "이번 주 많이 본" 질의를 못 하므로 기록 × KST 하루 단위로 쌓는다.
 *
 * - 게임 공용: TETRIS·DEFENSE 단일 플레이 기록이 모두 GAME_SCORES라 게임별 테이블이 필요 없다
 * - 랭킹 테이블에 합치지 않는다: 조회마다 갱신되는 행을 순위 조회 테이블과 분리한다(갱신 경합·행 잠금이 랭킹 등록과 섞이지 않게)
 * - PK (SCORE_ID, STAT_DATE): 같은 날 조회는 한 행에 더한다
 * - STAT_DATE는 KST 날짜 문자열 'YYYY-MM-DD'(D-006): TIMESTAMP WITH TIME ZONE은 PK에 못 쓰고(ORA-02329 — 1차 실행 실패, 아무것도 생성되지 않음),
 *   시간대 없는 TIMESTAMP·DATE는 세션 시간대(로컬 KST·운영 UTC)에 따라 저장값이 달라진다. 0 채움 고정 폭이라 문자열 비교 = 날짜 순서
 * - 복합 FK (SCORE_ID, GAME_TYPE) → GAME_SCORES ON DELETE CASCADE: 게임 종류 일치를 DB가 강제, 기록 삭제 시 함께 지운다
 * - IX (GAME_TYPE, STAT_DATE): 기간별 인기 목록 범위 조회
 *
 * - 제약·인덱스 이름은 30자 이하(기존 스키마 관례 — Oracle 12.1 이하 한도)
 *
 * 멱등: 테이블·인덱스는 존재 확인 후 생성한다.
 */
export class CreateGameReplayViewStats1792828139000 implements MigrationInterface {
  name = 'CreateGameReplayViewStats1792828139000';

  private static readonly TABLE_COMMENT = '리플레이 조회 일별 집계. 기록 1건 × KST 하루 1행. 누적 값은 SUM. 기록 삭제 시 CASCADE';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    SCORE_ID: '랭킹 기록 ID (PK, 복합 FK → GAME_SCORES(SCORE_ID, GAME_TYPE), 기록 삭제 시 CASCADE)',
    STAT_DATE: '집계 날짜 — KST 기준 YYYY-MM-DD (PK)',
    GAME_TYPE: '게임 종류 코드. GAME_SCORES.GAME_TYPE과 같아야 한다(복합 FK가 강제)',
    VIEW_COUNT: '그날 조회수 — 브라우저당 하루 1회(프론트), IP당 하루 상한(서버)',
    WATCH_MS: '그날 시청시간 합(밀리초) — 재생이 진행된 벽시계 시간, 배속 미반영. IP당 하루 상한(서버)',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'GAME_REPLAY_VIEW_STATS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "GAME_REPLAY_VIEW_STATS" (
            "SCORE_ID" NUMBER NOT NULL,
            "STAT_DATE" VARCHAR2(10 BYTE) NOT NULL,
            "GAME_TYPE" VARCHAR2(20 BYTE) NOT NULL,
            "VIEW_COUNT" NUMBER(10) DEFAULT 0 NOT NULL,
            "WATCH_MS" NUMBER(15) DEFAULT 0 NOT NULL,
            CONSTRAINT "PK_GAME_REPLAY_VIEW_STATS" PRIMARY KEY ("SCORE_ID", "STAT_DATE"),
            CONSTRAINT "GAME_REPLAY_VIEW_STATS_CNT_CK" CHECK ("VIEW_COUNT" >= 0 AND "WATCH_MS" >= 0),
            CONSTRAINT "GAME_REPLAY_VIEW_STATS_DATE_CK" CHECK (REGEXP_LIKE("STAT_DATE", ''^[0-9]{4}-[0-9]{2}-[0-9]{2}$'')),
            CONSTRAINT "FK_GAME_RVS_SCORE" FOREIGN KEY ("SCORE_ID", "GAME_TYPE")
              REFERENCES "GAME_SCORES" ("SCORE_ID", "GAME_TYPE") ON DELETE CASCADE
          )';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE table_name = 'GAME_REPLAY_VIEW_STATS' AND index_name = 'IX_GAME_RVS_TYPE_DATE';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX "IX_GAME_RVS_TYPE_DATE" ON "GAME_REPLAY_VIEW_STATS" ("GAME_TYPE", "STAT_DATE")';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateGameReplayViewStats1792828139000;
    await queryRunner.query(`COMMENT ON TABLE "GAME_REPLAY_VIEW_STATS" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "GAME_REPLAY_VIEW_STATS"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 제약·인덱스·코멘트를 함께 제거한다. ⚠️ 모든 조회수·시청시간이 사라진다(랭킹 기록은 남는다)
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'GAME_REPLAY_VIEW_STATS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "GAME_REPLAY_VIEW_STATS" PURGE';
      END IF;
    END;`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GAME_SCORES.BOARD_KEY 추가 — 한 게임 안의 랭킹 보드 구분 (docs/tasks/defense D-011·D-014·D-016, 정본 DESIGN.md §B1 M2)
 *
 * 배경: 디펜스는 무한 모드(시즌 보드 'endless-s1'…)와 주간 도전('weekly-2026-w43')을 따로 순위 매긴다.
 * 테트리스는 보드가 하나라 'default' — 기존 행은 DEFAULT로 채워진다.
 *
 * - VARCHAR2(40 BYTE) DEFAULT 'default' NOT NULL: Oracle 11g+는 이 형태의 ADD를 메타데이터 변경으로 처리해 기존 행을 다시 쓰지 않는다.
 * - CHECK: 소문자·숫자·하이픈 1~40자 — 보드 키는 서버 엔진이 만들고 URL 쿼리로도 쓰인다.
 * - ⚠️ 배포 게이트: Entity에 boardKey가 있는 코드가 이 마이그레이션 전에 배포되면 모든 GAME_SCORES 조회가 실패한다(테트리스 포함).
 *
 * 멱등: 컬럼·제약이 이미 있으면 건너뛴다.
 */
export class AddGameScoresBoardKey1792591421000 implements MigrationInterface {
  name = 'AddGameScoresBoardKey1792591421000';

  private static readonly COLUMN_COMMENT =
    "랭킹 보드 키. 같은 게임 안에서 순위를 나누는 단위 — TETRIS 'default', DEFENSE 'endless-s{시즌}'·'weekly-{ISO 주차}'. 소문자·숫자·하이픈 1~40자";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'GAME_SCORES' AND column_name = 'BOARD_KEY';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "GAME_SCORES" ADD ("BOARD_KEY" VARCHAR2(40 BYTE) DEFAULT ''default'' NOT NULL)';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_constraints WHERE table_name = 'GAME_SCORES' AND constraint_name = 'GAME_SCORES_BOARD_CK';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "GAME_SCORES" ADD CONSTRAINT "GAME_SCORES_BOARD_CK" CHECK (REGEXP_LIKE("BOARD_KEY", ''^[a-z0-9-]{1,40}$''))';
      END IF;
    END;`);

    // 코멘트 문자열 안의 작은따옴표는 두 번 쓴다
    const comment = AddGameScoresBoardKey1792591421000.COLUMN_COMMENT.replace(/'/g, "''");
    await queryRunner.query(`COMMENT ON COLUMN "GAME_SCORES"."BOARD_KEY" IS '${comment}'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 컬럼 DROP이 이 컬럼만 참조하는 CHECK를 함께 지운다. ⚠️ 보드 구분이 사라진다(테트리스 외 보드 기록은 섞인다)
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'GAME_SCORES' AND column_name = 'BOARD_KEY';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "GAME_SCORES" DROP ("BOARD_KEY") CASCADE CONSTRAINTS';
      END IF;
    END;`);
  }
}

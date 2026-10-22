import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GAME_SCORES·GAME_REPLAYS의 GAME_TYPE CHECK에 'DEFENSE' 추가 (docs/tasks/defense D-016, 정본 DESIGN.md §B1 M1)
 *
 * 배경: 게임 모음집 2번째 게임(디펜스)이 같은 랭킹·리플레이 테이블을 쓴다. 기존 CHECK는 IN ('TETRIS')뿐이다.
 * 사전 확인(2026-10-21 pnpm db:select): 두 제약 모두 `"GAME_TYPE" IN ('TETRIS')`, GAME_SCORES 27행 전부 TETRIS.
 *
 * 멱등: 제약 조건문에 DEFENSE가 이미 있으면 건너뛴다. 없으면 기존 제약을 지우고 새로 만든다.
 * Oracle DDL은 자동 커밋이라 DROP 뒤 ADD가 실패하면 제약이 빠진 채 남는다 — 재실행하면 "없음 → ADD"로 복구된다.
 */
export class AlterGameTypeCheckAddDefense1792591420000 implements MigrationInterface {
  name = 'AlterGameTypeCheckAddDefense1792591420000';

  private static readonly TARGETS = [
    { table: 'GAME_SCORES', constraint: 'GAME_SCORES_TYPE_CK' },
    { table: 'GAME_REPLAYS', constraint: 'GAME_REPLAYS_TYPE_CK' },
  ];

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    GAME_SCORES: '게임 종류 코드. TETRIS 테트리스, DEFENSE 디펜스',
    GAME_REPLAYS: '게임 종류 코드. GAME_SCORES.GAME_TYPE과 같아야 한다(복합 FK가 강제). TETRIS·DEFENSE',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { table, constraint } of AlterGameTypeCheckAddDefense1792591420000.TARGETS) {
      await this.replaceCheck(queryRunner, table, constraint, `''TETRIS'', ''DEFENSE''`, 'DEFENSE', true);
      await queryRunner.query(
        `COMMENT ON COLUMN "${table}"."GAME_TYPE" IS '${AlterGameTypeCheckAddDefense1792591420000.COLUMN_COMMENTS[table]}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DEFENSE 기록이 있으면 TETRIS만 허용하는 CHECK를 만들 수 없다 — 명시적으로 실패한다(기록을 먼저 정리)
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM "GAME_SCORES" WHERE "GAME_TYPE" = 'DEFENSE';
      IF v_cnt > 0 THEN
        RAISE_APPLICATION_ERROR(-20001, 'GAME_SCORES에 DEFENSE 기록이 있어 CHECK를 되돌릴 수 없습니다');
      END IF;
    END;`);
    for (const { table, constraint } of AlterGameTypeCheckAddDefense1792591420000.TARGETS) {
      await this.replaceCheck(queryRunner, table, constraint, `''TETRIS''`, 'DEFENSE', false);
      await queryRunner.query(`COMMENT ON COLUMN "${table}"."GAME_TYPE" IS '게임 종류 코드. TETRIS 테트리스'`);
    }
  }

  /**
   * CHECK 제약을 values 목록으로 교체한다.
   * marker가 조건문에 들어 있는지(wantMarker)로 이미 원하는 상태인지 판단해 멱등하게 만든다.
   */
  private async replaceCheck(
    queryRunner: QueryRunner,
    table: string,
    constraint: string,
    values: string,
    marker: string,
    wantMarker: boolean,
  ): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
      v_has NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_constraints WHERE table_name = '${table}' AND constraint_name = '${constraint}';
      SELECT COUNT(*) INTO v_has FROM user_constraints
       WHERE table_name = '${table}' AND constraint_name = '${constraint}' AND search_condition_vc LIKE '%${marker}%';
      IF v_cnt = 0 OR v_has <> ${wantMarker ? 1 : 0} THEN
        IF v_cnt > 0 THEN
          EXECUTE IMMEDIATE 'ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"';
        END IF;
        EXECUTE IMMEDIATE 'ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" CHECK ("GAME_TYPE" IN (${values}))';
      END IF;
    END;`);
  }
}

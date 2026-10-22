import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GAME_SCORES 랭킹 인덱스를 보드 포함으로 교체 (docs/tasks/defense D-016, 정본 DESIGN.md §B1 M3)
 *
 * 배경: 랭킹 조회가 GAME_TYPE + BOARD_KEY로 걸러진다. 기존 인덱스는 보드를 몰라 다른 보드 기록까지 훑는다.
 * 정렬 인덱스의 둘째 기준도 순위 규칙(SCORE DESC, SCORE_ID ASC — games.service.ts getRankings·rankOf)에 맞춰
 * CRTD_AT 대신 SCORE_ID로 둔다(games D-015).
 *
 * | 옛 인덱스 | 새 인덱스 |
 * |---|---|
 * | IDX_GAME_SCORES_TYPE_SCORE (GAME_TYPE, SCORE DESC, CRTD_AT) | IDX_GAME_SCORES_BOARD_SCORE (GAME_TYPE, BOARD_KEY, SCORE DESC, SCORE_ID) |
 * | IDX_GAME_SCORES_TYPE_CRTD (GAME_TYPE, CRTD_AT) | IDX_GAME_SCORES_BOARD_CRTD (GAME_TYPE, BOARD_KEY, CRTD_AT) |
 *
 * 순서: 새 인덱스를 먼저 만들고 옛 인덱스를 지운다 — 중간에도 랭킹 조회가 인덱스를 잃지 않는다.
 * 선행: AddGameScoresBoardKey(BOARD_KEY 컬럼) — 타임스탬프 순으로 먼저 실행된다.
 * 멱등: 인덱스 이름으로 존재를 확인한다.
 */
export class ReplaceGameScoresIndexesWithBoard1792591422000 implements MigrationInterface {
  name = 'ReplaceGameScoresIndexesWithBoard1792591422000';

  private static readonly NEW_INDEXES = [
    { name: 'IDX_GAME_SCORES_BOARD_SCORE', columns: '"GAME_TYPE", "BOARD_KEY", "SCORE" DESC, "SCORE_ID"' },
    { name: 'IDX_GAME_SCORES_BOARD_CRTD', columns: '"GAME_TYPE", "BOARD_KEY", "CRTD_AT"' },
  ];

  private static readonly OLD_INDEXES = [
    { name: 'IDX_GAME_SCORES_TYPE_SCORE', columns: '"GAME_TYPE", "SCORE" DESC, "CRTD_AT"' },
    { name: 'IDX_GAME_SCORES_TYPE_CRTD', columns: '"GAME_TYPE", "CRTD_AT"' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const { NEW_INDEXES, OLD_INDEXES } = ReplaceGameScoresIndexesWithBoard1792591422000;
    for (const index of NEW_INDEXES) {
      await this.createIndex(queryRunner, index);
    }
    for (const index of OLD_INDEXES) {
      await this.dropIndex(queryRunner, index.name);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const { NEW_INDEXES, OLD_INDEXES } = ReplaceGameScoresIndexesWithBoard1792591422000;
    for (const index of OLD_INDEXES) {
      await this.createIndex(queryRunner, index);
    }
    for (const index of NEW_INDEXES) {
      await this.dropIndex(queryRunner, index.name);
    }
  }

  private async createIndex(queryRunner: QueryRunner, { name, columns }: { name: string; columns: string }): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = '${name}';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX "${name}" ON "GAME_SCORES" (${columns})';
      END IF;
    END;`);
  }

  private async dropIndex(queryRunner: QueryRunner, name: string): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = '${name}';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP INDEX "${name}"';
      END IF;
    END;`);
  }
}

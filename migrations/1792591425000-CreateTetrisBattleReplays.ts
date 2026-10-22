import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 테트리스 대전 리플레이 테이블 생성 (docs/tasks/tetris-battle D-021, 정본 DESIGN.md §17-2)
 *
 * - PK (MATCH_ID, PLAYER_ID), FK → TETRIS_BATTLE_PLAYERS ON DELETE CASCADE: 참가자 결과 1행당 리플레이 최대 1개(제출한 사람만).
 * - 경기 테이블에 합치지 않는다: LOB이 행 안에 있으면 경기 목록 조회가 읽는 양이 늘어난다(GAME_REPLAYS와 같은 이유).
 * - REPLAY: seed·das·arr·frames·inputs·garbage JSON을 gzip한 BLOB. 검증 실패(INVALID) 리플레이도 조사용으로 보관한다.
 *
 * 멱등: 테이블은 존재 확인 후 생성한다. CreateTetrisBattlePlayers 다음에 실행된다(타임스탬프 순).
 */
export class CreateTetrisBattleReplays1792591425000 implements MigrationInterface {
  name = 'CreateTetrisBattleReplays1792591425000';

  private static readonly TABLE_COMMENT =
    '테트리스 대전 리플레이. 제출한 참가자 1명당 1개(gzip JSON). 재생 API는 VERIFIED 참가자만. 참가자 삭제 시 CASCADE';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    MATCH_ID: '경기 ID (PK, 복합 FK → TETRIS_BATTLE_PLAYERS(MATCH_ID, PLAYER_ID))',
    PLAYER_ID: '참가자 ID (PK)',
    BATTLE_ENGINE_VERSION: '리플레이를 만든 대전 래퍼 버전. 재생·재검증에는 같은 버전이 필요',
    REPLAY: '리플레이 본문 — seed·das·arr·frames·inputs·garbage JSON을 gzip한 바이너리',
    CRTD_AT: '저장 시각 (UTC)',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TETRIS_BATTLE_REPLAYS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "TETRIS_BATTLE_REPLAYS" (
            "MATCH_ID" VARCHAR2(16 BYTE) NOT NULL,
            "PLAYER_ID" VARCHAR2(8 BYTE) NOT NULL,
            "BATTLE_ENGINE_VERSION" NUMBER(5) NOT NULL,
            "REPLAY" BLOB NOT NULL,
            "CRTD_AT" TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT "PK_TB_REPLAYS" PRIMARY KEY ("MATCH_ID", "PLAYER_ID"),
            CONSTRAINT "FK_TB_REPLAYS_PLAYER" FOREIGN KEY ("MATCH_ID", "PLAYER_ID")
              REFERENCES "TETRIS_BATTLE_PLAYERS" ("MATCH_ID", "PLAYER_ID") ON DELETE CASCADE
          )';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateTetrisBattleReplays1792591425000;
    await queryRunner.query(`COMMENT ON TABLE "TETRIS_BATTLE_REPLAYS" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "TETRIS_BATTLE_REPLAYS"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 제약·코멘트를 함께 제거한다. ⚠️ 모든 대전 리플레이가 사라진다(경기·참가자 결과는 남는다).
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TETRIS_BATTLE_REPLAYS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "TETRIS_BATTLE_REPLAYS" PURGE';
      END IF;
    END;`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 게임 리플레이 테이블 생성 (docs/tasks/games D-010·D-011·D-012·D-013, 정본 DESIGN.md §1-2)
 *
 * 배경: 랭킹 기록마다 서버가 검증한 리플레이(seed + 입력 기록)를 보관한다. 누구나 재생할 수 있고(D-011),
 * 엔진 버그 수정 후 재검증·조작 의심 기록 조사에도 쓴다.
 *
 * - 랭킹 테이블에 합치지 않는다(D-013): LOB이 행 안에 저장되면 순위 조회가 읽는 양이 늘어난다.
 * - GAME_TYPE + 복합 FK (SCORE_ID, GAME_TYPE) → GAME_SCORES: 리플레이의 게임 종류가 기록과 다르면 DB가 거부(D-012).
 * - REPLAY: 헤더(das·arr·frames) + 입력 배열 JSON을 gzip한 BLOB. 기록 1건당 보통 수 KB.
 * - SEED: 서버가 발급한 0 ~ 2^32−1 정수.
 *
 * 멱등: 테이블은 존재 확인 후 생성한다. CreateGameScores 다음에 실행된다(타임스탬프 순).
 */
export class CreateGameReplays1792564227000 implements MigrationInterface {
  name = 'CreateGameReplays1792564227000';

  private static readonly TABLE_COMMENT =
    '게임 리플레이. 랭킹 기록 1건당 1개(서버가 검증한 seed + 입력 기록). 누구나 재생 가능. 기록 삭제 시 CASCADE';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    SCORE_ID: '랭킹 기록 ID (PK, 복합 FK → GAME_SCORES(SCORE_ID, GAME_TYPE), 기록 삭제 시 CASCADE)',
    GAME_TYPE: '게임 종류 코드. GAME_SCORES.GAME_TYPE과 같아야 한다(복합 FK가 강제)',
    ENGINE_VERSION: '리플레이를 만든 게임 엔진 버전. 재생·재검증에는 같은 버전 엔진이 필요',
    SEED: '서버가 발급한 블록 순서 시드 (0 ~ 4294967295)',
    REPLAY: '리플레이 본문 — das·arr·frames·inputs JSON을 gzip한 바이너리',
    CRTD_AT: '저장 시각 (UTC)',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'GAME_REPLAYS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "GAME_REPLAYS" (
            "SCORE_ID" NUMBER NOT NULL,
            "GAME_TYPE" VARCHAR2(20 BYTE) NOT NULL,
            "ENGINE_VERSION" NUMBER(5) NOT NULL,
            "SEED" NUMBER(10) NOT NULL,
            "REPLAY" BLOB NOT NULL,
            "CRTD_AT" TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT "PK_GAME_REPLAYS" PRIMARY KEY ("SCORE_ID"),
            CONSTRAINT "GAME_REPLAYS_TYPE_CK" CHECK ("GAME_TYPE" IN (''TETRIS'')),
            CONSTRAINT "GAME_REPLAYS_SEED_CK" CHECK ("SEED" BETWEEN 0 AND 4294967295),
            CONSTRAINT "FK_GAME_REPLAYS_SCORE" FOREIGN KEY ("SCORE_ID", "GAME_TYPE")
              REFERENCES "GAME_SCORES" ("SCORE_ID", "GAME_TYPE") ON DELETE CASCADE
          )';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateGameReplays1792564227000;
    await queryRunner.query(`COMMENT ON TABLE "GAME_REPLAYS" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "GAME_REPLAYS"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 제약·코멘트를 함께 제거한다. ⚠️ 모든 리플레이가 사라진다(랭킹 기록은 남는다).
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'GAME_REPLAYS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "GAME_REPLAYS" PURGE';
      END IF;
    END;`);
  }
}

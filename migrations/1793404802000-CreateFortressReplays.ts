import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 포트리스 리플레이 테이블 생성 (docs/tasks/fortress DESIGN §12 — F6)
 *
 * - PK MATCH_ID, FK → FORTRESS_MATCHES ON DELETE CASCADE: 경기당 리플레이 1개(replay id = matchId).
 * - 경기 테이블에 합치지 않는다: LOB이 행 안에 있으면 경기 목록 조회가 읽는 양이 늘어난다(TETRIS_BATTLE_REPLAYS와 같은 이유).
 * - REPLAY: { config, actions, slots, stateHash } JSON을 gzip한 BLOB. 서버가 경기 중 확정한 행동 로그 그대로(클라이언트 제출 없음).
 *
 * 멱등: 테이블은 존재 확인 후 생성한다. CreateFortressMatches 다음에 실행된다(타임스탬프 순).
 */
export class CreateFortressReplays1793404802000 implements MigrationInterface {
  name = 'CreateFortressReplays1793404802000';

  private static readonly TABLE_COMMENT = '포트리스 리플레이. 경기당 1개(gzip JSON — 엔진 설정·행동 로그). 경기 삭제 시 CASCADE';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    MATCH_ID: '경기 ID (PK, FK → FORTRESS_MATCHES) — 리플레이 id',
    ENGINE_VERSION: '경기를 돌린 엔진 버전. 재생에 같은 버전이 필요',
    REPLAY: '리플레이 본문 — config·actions·slots·stateHash JSON을 gzip한 바이너리',
    CRTD_AT: '저장 시각 (UTC)',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'FORTRESS_REPLAYS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "FORTRESS_REPLAYS" (
            "MATCH_ID" VARCHAR2(16 BYTE) NOT NULL,
            "ENGINE_VERSION" NUMBER(5) NOT NULL,
            "REPLAY" BLOB NOT NULL,
            "CRTD_AT" TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT "PK_FT_REPLAYS" PRIMARY KEY ("MATCH_ID"),
            CONSTRAINT "FK_FT_REPLAYS_MATCH" FOREIGN KEY ("MATCH_ID") REFERENCES "FORTRESS_MATCHES" ("MATCH_ID") ON DELETE CASCADE
          )';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateFortressReplays1793404802000;
    await queryRunner.query(`COMMENT ON TABLE "FORTRESS_REPLAYS" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "FORTRESS_REPLAYS"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 제약·코멘트를 함께 제거한다. ⚠️ 모든 포트리스 리플레이가 사라진다(경기·참가자 결과는 남는다).
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'FORTRESS_REPLAYS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "FORTRESS_REPLAYS" PURGE';
      END IF;
    END;`);
  }
}

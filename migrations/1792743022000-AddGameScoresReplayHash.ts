import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GAME_SCORES.REPLAY_HASH 추가 + 유니크 인덱스 — 같은 리플레이의 반복 등록 차단 (docs/tasks/games-polish-2026-10 D-003, BD-05)
 *
 * 배경: 디펜스 주간 보드는 전원 같은 seed라, 유효한 리플레이 1개를 새 세션으로 반복 제출하면 매번 재현에 성공해
 * 같은 기록이 이름만 바꿔 랭킹을 채울 수 있었다. "모든 기록 등록" 정책은 유지하고 같은 리플레이만 막는다.
 *
 * - VARCHAR2(64 BYTE) NULL: sha256 hex(게임·보드·seed·리플레이 본문). 기존 행은 NULL로 둔다(재계산하지 않음)
 * - 단일 컬럼 유니크 인덱스: Oracle은 키가 전부 NULL인 행을 인덱스에 넣지 않으므로 기존 NULL 행끼리 충돌하지 않는다
 * - ⚠️ 배포 게이트: Entity에 replayHash가 있는 코드가 이 마이그레이션 전에 배포되면 모든 GAME_SCORES 조회가 실패한다(ORA-00904)
 *
 * 멱등: 컬럼·인덱스가 이미 있으면 건너뛴다.
 */
export class AddGameScoresReplayHash1792743022000 implements MigrationInterface {
  name = 'AddGameScoresReplayHash1792743022000';

  private static readonly COLUMN_COMMENT =
    '리플레이 해시 sha256 hex — 게임·보드·seed·리플레이 본문. 같은 리플레이 반복 등록 차단(유니크). 도입 전 기록은 NULL';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'GAME_SCORES' AND column_name = 'REPLAY_HASH';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "GAME_SCORES" ADD ("REPLAY_HASH" VARCHAR2(64 BYTE))';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE table_name = 'GAME_SCORES' AND index_name = 'UX_GAME_SCORES_REPLAY_HASH';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE UNIQUE INDEX "UX_GAME_SCORES_REPLAY_HASH" ON "GAME_SCORES" ("REPLAY_HASH")';
      END IF;
    END;`);

    const comment = AddGameScoresReplayHash1792743022000.COLUMN_COMMENT.replace(/'/g, "''");
    await queryRunner.query(`COMMENT ON COLUMN "GAME_SCORES"."REPLAY_HASH" IS '${comment}'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 컬럼 DROP이 그 컬럼만 쓰는 인덱스를 함께 지운다. ⚠️ 중복 등록 차단이 사라진다
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'GAME_SCORES' AND column_name = 'REPLAY_HASH';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "GAME_SCORES" DROP ("REPLAY_HASH")';
      END IF;
    END;`);
  }
}

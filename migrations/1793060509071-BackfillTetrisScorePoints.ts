import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 과거 로그인 테트리스 기록을 포인트 원장에 적립으로 소급 (docs/tasks/skin-levels D-001·D-004)
 *
 * 배경: 포인트는 원장 합계다. 이 기능 전에 로그인 상태로 남긴 테트리스 기록도 포인트로 쳐 준다(사용자 결정).
 * 새 기록은 앱이 저장 트랜잭션에서 같은 형식으로 넣는다(user-point.service.ts `tetrisScorePointEntry`와 같은 REASON·REF_KEY·MEMO).
 *
 * - 대상: GAME_TYPE = 'TETRIS', USER_ID 있음(비로그인 기록은 주인이 없다), IS_HIDDEN = 0, SCORE > 0(원장은 0을 받지 않는다)
 * - 한 기록 = 한 줄: AMOUNT = SCORE, REASON = 'TETRIS_SCORE', REF_KEY = SCORE_ID, CRTD_AT = 기록 시각
 * - NOT EXISTS + 유니크 (USER_ID, REASON, REF_KEY): 이미 적립된 기록은 건너뛴다 — 같은 SQL을 다시 돌려도 중복이 없다
 *   (배포 직전 옛 코드가 저장한 기록이 빠졌으면 이 INSERT를 한 번 더 실행하면 된다)
 *
 * down: TETRIS_SCORE 적립을 모두 지운다(앱이 넣은 것 포함) — 원장 적립 이전 코드로 되돌릴 때만
 */
export class BackfillTetrisScorePoints1793060509071 implements MigrationInterface {
  name = 'BackfillTetrisScorePoints1793060509071';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "USER_POINT_LEDGER" ("USER_ID", "AMOUNT", "REASON", "REF_KEY", "MEMO", "CRTD_AT")
      SELECT s."USER_ID", s."SCORE", 'TETRIS_SCORE', TO_CHAR(s."SCORE_ID"),
             '테트리스 기록 #' || s."SCORE_ID" || ' · ' || s."BOARD_KEY" || ' 보드 · ' || TRIM(TO_CHAR(s."SCORE", '999,999,999,990')) || '점',
             s."CRTD_AT"
        FROM "GAME_SCORES" s
       WHERE s."GAME_TYPE" = 'TETRIS'
         AND s."USER_ID" IS NOT NULL
         AND s."IS_HIDDEN" = 0
         AND s."SCORE" > 0
         AND NOT EXISTS (
               SELECT 1 FROM "USER_POINT_LEDGER" l
                WHERE l."USER_ID" = s."USER_ID" AND l."REASON" = 'TETRIS_SCORE' AND l."REF_KEY" = TO_CHAR(s."SCORE_ID")
             )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "USER_POINT_LEDGER" WHERE "REASON" = 'TETRIS_SCORE'`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 배포 창 사이 원장 누락 소급 (docs/tasks/skin-levels D-004 배포 순서)
 *
 * 배경: 소급(…071) 실행 뒤 새 코드가 배포되기 전까지 옛 코드가 저장한 로그인 테트리스 기록은 원장에 적립 줄이 없다.
 * 2026-10-27 배포 직후 확인 결과 1건(SCORE_ID 165). …071과 같은 INSERT를 한 번 더 돌린다.
 *
 * - NOT EXISTS + 유니크 (USER_ID, REASON, REF_KEY): 이미 적립된 기록은 건너뛴다 — 누락분만 들어간다
 * - down: 이 마이그레이션이 넣은 줄만 골라낼 수 없다(앱이 넣은 줄과 형식이 같다) — 되돌리지 않는다
 */
export class BackfillTetrisScorePointsDeployGap1793060509072 implements MigrationInterface {
  name = 'BackfillTetrisScorePointsDeployGap1793060509072';

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

  public async down(): Promise<void> {
    // 되돌리지 않는다 — 클래스 주석 참조
  }
}

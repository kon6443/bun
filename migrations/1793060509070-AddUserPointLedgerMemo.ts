import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * USER_POINT_LEDGER.MEMO 추가 — 포인트가 어디서 나고 어디에 쓰였는지 사람이 읽는 설명 (docs/tasks/skin-levels D-004)
 *
 * 배경: 포인트를 원장 하나로 관리한다(적립도 한 줄씩). 출처는 REASON·REF_KEY로 기계가 찾고, MEMO는 사람이 읽는다
 * (예: "테트리스 기록 #41 · default 보드 · 12,340점", "블록 chocolate Lv2 강화").
 *
 * - VARCHAR2(400 BYTE) NULL — 한글 약 130자
 * - 표·AMOUNT·REF_KEY 코멘트도 원장 일원화 설명으로 다시 쓴다(…069의 "점수 합계 + AMOUNT" 설명은 D-004로 바뀌었다)
 * - ⚠️ 배포 게이트: Entity에 memo가 있는 코드가 이 마이그레이션 전에 배포되면 점수 저장·강화가 실패한다
 *
 * 멱등: 컬럼이 이미 있으면 건너뛴다.
 */
export class AddUserPointLedgerMemo1793060509070 implements MigrationInterface {
  name = 'AddUserPointLedgerMemo1793060509070';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'USER_POINT_LEDGER' AND column_name = 'MEMO';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "USER_POINT_LEDGER" ADD ("MEMO" VARCHAR2(400 BYTE))';
      END IF;
    END;`);
    await queryRunner.query(`COMMENT ON COLUMN "USER_POINT_LEDGER"."MEMO" IS '사람이 읽는 설명 — 출처(기록 번호·보드·점수)나 사용처(슬롯·아이템·레벨)'`);
    await queryRunner.query(`COMMENT ON TABLE "USER_POINT_LEDGER" IS '사용자 포인트 원장 — 적립·소비·보상을 한 줄씩. 잔액 = AMOUNT 합계'`);
    await queryRunner.query(`COMMENT ON COLUMN "USER_POINT_LEDGER"."AMOUNT" IS '증감 포인트 — 적립·보상은 양수, 소비는 음수'`);
    await queryRunner.query(
      `COMMENT ON COLUMN "USER_POINT_LEDGER"."REF_KEY" IS '사유별 대상 — TETRIS_SCORE는 SCORE_ID, SKIN_UPGRADE는 슬롯:아이템:목표레벨. (USER_ID, REASON, REF_KEY) 유니크'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 코멘트는 되돌리지 않는다(설명만 다르다) — 컬럼만 지운다
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'USER_POINT_LEDGER' AND column_name = 'MEMO';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "USER_POINT_LEDGER" DROP ("MEMO")';
      END IF;
    END;`);
  }
}

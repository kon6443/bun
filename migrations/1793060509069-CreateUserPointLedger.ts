import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 사용자 포인트 원장 생성 (docs/tasks/skin-levels D-002)
 *
 * 배경: 테트리스 점수가 포인트로 쌓이고, 스킨 강화에 쓴다. 적립은 따로 저장하지 않고 GAME_SCORES 합계로 계산한다
 * (과거 로그인 기록이 자동으로 포함되고, 숨긴 기록은 빠진다). 이 표는 그 밖의 증감 — 지금은 강화 소비(음수),
 * 이후 출석·업적 보상(양수) — 을 남긴다. 잔액 = 점수 합계 + AMOUNT 합계.
 *
 * - LEDGER_ID IDENTITY(GENERATED ALWAYS) PK
 * - UNIQUE (USER_ID, REASON, REF_KEY): 같은 강화(REF_KEY = 'TETRIS_BLOCK:neon:3')는 한 번만 차감 — 중복 요청 방어
 * - AMOUNT <> 0 · REASON 형식 CHECK(대문자·숫자·밑줄)
 * - (USER_ID) 조회는 UNIQUE 인덱스 앞부분을 쓴다
 * - FK → USERS ON DELETE CASCADE
 *
 * 멱등: 테이블은 존재 확인 후 생성한다.
 */
export class CreateUserPointLedger1793060509069 implements MigrationInterface {
  name = 'CreateUserPointLedger1793060509069';

  private static readonly TABLE_COMMENT = '사용자 포인트 원장 — 점수 적립 외의 증감(강화 소비 등). 잔액 = 테트리스 점수 합계 + AMOUNT 합계';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    LEDGER_ID: '원장 ID (PK, IDENTITY)',
    USER_ID: '사용자 ID (FK → USERS, 삭제 시 CASCADE)',
    AMOUNT: '증감 포인트 — 소비는 음수, 보상은 양수',
    REASON: '사유 — SKIN_UPGRADE 등',
    REF_KEY: '사유별 대상 — SKIN_UPGRADE는 슬롯:아이템:목표레벨. (USER_ID, REASON, REF_KEY) 유니크',
    CRTD_AT: '기록 시각',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'USER_POINT_LEDGER';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "USER_POINT_LEDGER" (
            "LEDGER_ID" NUMBER GENERATED ALWAYS AS IDENTITY,
            "USER_ID" NUMBER NOT NULL,
            "AMOUNT" NUMBER NOT NULL,
            "REASON" VARCHAR2(40 BYTE) NOT NULL,
            "REF_KEY" VARCHAR2(160 BYTE) NOT NULL,
            "CRTD_AT" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT "PK_USER_POINT_LEDGER" PRIMARY KEY ("LEDGER_ID"),
            CONSTRAINT "UQ_USER_POINT_LEDGER_REF" UNIQUE ("USER_ID", "REASON", "REF_KEY"),
            CONSTRAINT "USER_POINT_LEDGER_AMOUNT_CK" CHECK ("AMOUNT" <> 0),
            CONSTRAINT "USER_POINT_LEDGER_REASON_CK" CHECK (REGEXP_LIKE("REASON", ''^[A-Z][A-Z0-9_]*$'')),
            CONSTRAINT "FK_USER_POINT_LEDGER_USER" FOREIGN KEY ("USER_ID") REFERENCES "USERS" ("USER_ID") ON DELETE CASCADE
          )';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateUserPointLedger1793060509069;
    await queryRunner.query(`COMMENT ON TABLE "USER_POINT_LEDGER" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "USER_POINT_LEDGER"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 제약·인덱스·코멘트를 함께 제거한다. ⚠️ 소비 기록이 사라져 잔액이 점수 합계로 돌아간다
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'USER_POINT_LEDGER';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "USER_POINT_LEDGER" PURGE';
      END IF;
    END;`);
  }
}

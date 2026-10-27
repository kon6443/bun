import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 사용자 스킨 레벨 테이블 생성 (docs/tasks/skin-levels D-001·D-002)
 *
 * 배경: 모든 스킨 아이템에 Lv1~Lv5가 생기고, 사용자가 포인트를 써서 아이템(슬롯 × 아이템)을 한 단계씩 강화한다.
 *
 * - 사용자 × 슬롯 × 아이템 1행, PK (USER_ID, SLOT, SKIN_ID). 행이 없으면 Lv1 — 강화한 아이템만 행이 생긴다
 * - LEVEL CHECK 2~5: Lv1은 행을 만들지 않는다. 상한은 코드 카탈로그(SKIN_MAX_LEVEL)와 같다
 * - SLOT·SKIN_ID 형식 CHECK는 USER_SKIN_EQUIPS와 같다(아이템 목록은 코드 카탈로그가 SSOT)
 * - FK → USERS ON DELETE CASCADE
 * - 제약 이름은 30자 이하(기존 스키마 관례)
 *
 * 멱등: 테이블은 존재 확인 후 생성한다.
 */
export class CreateUserSkinLevels1793060509068 implements MigrationInterface {
  name = 'CreateUserSkinLevels1793060509068';

  private static readonly TABLE_COMMENT = '사용자 스킨 레벨. 사용자 × 슬롯 × 아이템 1행, 행 없음 = Lv1. 사용자 삭제 시 CASCADE';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    USER_ID: '사용자 ID (PK, FK → USERS, 삭제 시 CASCADE)',
    SLOT: '스킨 슬롯 (PK) — TETRIS_BLOCK·TETRIS_EFFECT·TETRIS_BOARD·TETRIS_BACKGROUND',
    SKIN_ID: '아이템 id (PK) — 코드 카탈로그(skin-catalog.ts) 기준',
    SKIN_LEVEL: '강화한 레벨 2~5 (Lv1은 행 없음)',
    UPDATED_AT: '마지막 강화 시각',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'USER_SKIN_LEVELS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "USER_SKIN_LEVELS" (
            "USER_ID" NUMBER NOT NULL,
            "SLOT" VARCHAR2(40 BYTE) NOT NULL,
            "SKIN_ID" VARCHAR2(64 BYTE) NOT NULL,
            "SKIN_LEVEL" NUMBER(2) NOT NULL,
            "UPDATED_AT" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT "PK_USER_SKIN_LEVELS" PRIMARY KEY ("USER_ID", "SLOT", "SKIN_ID"),
            CONSTRAINT "USER_SKIN_LEVELS_SLOT_CK" CHECK (REGEXP_LIKE("SLOT", ''^[A-Z][A-Z0-9_]*$'')),
            CONSTRAINT "USER_SKIN_LEVELS_SKIN_CK" CHECK (REGEXP_LIKE("SKIN_ID", ''^[a-z0-9][a-z0-9-]*$'')),
            CONSTRAINT "USER_SKIN_LEVELS_LEVEL_CK" CHECK ("SKIN_LEVEL" BETWEEN 2 AND 5),
            CONSTRAINT "FK_USER_SKIN_LEVELS_USER" FOREIGN KEY ("USER_ID") REFERENCES "USERS" ("USER_ID") ON DELETE CASCADE
          )';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateUserSkinLevels1793060509068;
    await queryRunner.query(`COMMENT ON TABLE "USER_SKIN_LEVELS" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "USER_SKIN_LEVELS"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 제약·코멘트를 함께 제거한다. ⚠️ 모든 강화 레벨이 사라진다(쓴 포인트는 원장에 남아 돌려받지 못한다)
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'USER_SKIN_LEVELS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "USER_SKIN_LEVELS" PURGE';
      END IF;
    END;`);
  }
}

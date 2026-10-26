import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 사용자 스킨 장착 테이블 생성 (docs/tasks/tetris-skins D-003)
 *
 * 배경: 테트리스 스킨을 슬롯(블록·이펙트·판 배경·화면 배경)마다 따로 장착하고, 장착한 사용자의 보드는 남의 화면
 * (대전 상대 보드·리플레이)에서도 그 스킨으로 그린다. 이후 업적·출석으로 얻는 아이템이 슬롯마다 늘어난다.
 *
 * - 사용자 × 슬롯 1행, PK (USER_ID, SLOT). 행이 없는 슬롯은 default
 * - 슬롯·아이템 목록은 코드 카탈로그가 SSOT — 아이템이 늘 때마다 DDL을 바꾸지 않도록 CHECK는 형식만 본다
 *   (SLOT 대문자·숫자·밑줄, SKIN_ID 소문자·숫자·하이픈)
 * - 획득 기록(업적·출석)은 그 기능과 함께 별도 테이블로 둔다(지금 아이템은 모두 무료)
 * - FK → USERS ON DELETE CASCADE
 * - 제약 이름은 30자 이하(기존 스키마 관례)
 *
 * 멱등: 테이블은 존재 확인 후 생성한다.
 */
export class CreateUserSkinEquips1792974597822 implements MigrationInterface {
  name = 'CreateUserSkinEquips1792974597822';

  private static readonly TABLE_COMMENT = '사용자 스킨 장착. 사용자 × 슬롯 1행, 행 없음 = default. 사용자 삭제 시 CASCADE';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    USER_ID: '사용자 ID (PK, FK → USERS, 삭제 시 CASCADE)',
    SLOT: '스킨 슬롯 (PK) — TETRIS_BLOCK·TETRIS_EFFECT·TETRIS_BOARD·TETRIS_BACKGROUND',
    SKIN_ID: '장착한 아이템 id — 코드 카탈로그(skin-catalog.ts) 기준',
    UPDATED_AT: '마지막 장착 시각',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'USER_SKIN_EQUIPS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "USER_SKIN_EQUIPS" (
            "USER_ID" NUMBER NOT NULL,
            "SLOT" VARCHAR2(40 BYTE) NOT NULL,
            "SKIN_ID" VARCHAR2(64 BYTE) NOT NULL,
            "UPDATED_AT" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT "PK_USER_SKIN_EQUIPS" PRIMARY KEY ("USER_ID", "SLOT"),
            CONSTRAINT "USER_SKIN_EQUIPS_SLOT_CK" CHECK (REGEXP_LIKE("SLOT", ''^[A-Z][A-Z0-9_]*$'')),
            CONSTRAINT "USER_SKIN_EQUIPS_SKIN_CK" CHECK (REGEXP_LIKE("SKIN_ID", ''^[a-z0-9][a-z0-9-]*$'')),
            CONSTRAINT "FK_USER_SKIN_EQUIPS_USER" FOREIGN KEY ("USER_ID") REFERENCES "USERS" ("USER_ID") ON DELETE CASCADE
          )';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateUserSkinEquips1792974597822;
    await queryRunner.query(`COMMENT ON TABLE "USER_SKIN_EQUIPS" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "USER_SKIN_EQUIPS"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 제약·코멘트를 함께 제거한다. ⚠️ 모든 장착 기록이 사라진다(모두 default로 돌아간다)
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'USER_SKIN_EQUIPS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "USER_SKIN_EQUIPS" PURGE';
      END IF;
    END;`);
  }
}

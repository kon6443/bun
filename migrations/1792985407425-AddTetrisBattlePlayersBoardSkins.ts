import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TETRIS_BATTLE_PLAYERS.BOARD_SKINS 추가 — 대전 리플레이를 그 경기 당시의 스킨으로 (docs/tasks/tetris-skins D-006)
 *
 * 배경: 경기 조회가 참가자의 "현재" 장착을 실어, 나중에 스킨을 바꾸면 지난 경기 리플레이의 모습도 바뀌었다.
 * 경기 시작 때의 보드 스킨(블록·이펙트·판 배경)을 참가자 행에 남긴다.
 *
 * - VARCHAR2(400 BYTE) NULL: JSON 문자열 {"block":…,"effect":…,"board":…}. 슬롯이 늘어도 DDL 변경이 없게 한 컬럼에 둔다
 * - NULL = 이 기능 전의 경기(그때는 스킨이 없어 기본 화면) → 조회는 default로 돌려준다. 기존 행은 다시 쓰지 않는다
 * - CHECK IS JSON: 깨진 문자열이 들어가지 않게
 * - ⚠️ 배포 게이트: Entity에 boardSkins가 있는 코드가 이 마이그레이션 전에 배포되면 대전 경기 저장·조회가 실패한다
 *
 * 멱등: 컬럼·제약이 이미 있으면 건너뛴다.
 */
export class AddTetrisBattlePlayersBoardSkins1792985407425 implements MigrationInterface {
  name = 'AddTetrisBattlePlayersBoardSkins1792985407425';

  private static readonly COLUMN_COMMENT =
    '경기 시작 때의 보드 스킨 JSON {"block","effect","board"} — 리플레이를 그 당시 모습으로. NULL = 스킨 기능 전 경기(default)';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'TETRIS_BATTLE_PLAYERS' AND column_name = 'BOARD_SKINS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "TETRIS_BATTLE_PLAYERS" ADD ("BOARD_SKINS" VARCHAR2(400 BYTE))';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_constraints WHERE table_name = 'TETRIS_BATTLE_PLAYERS' AND constraint_name = 'TB_PLAYERS_SKINS_CK';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "TETRIS_BATTLE_PLAYERS" ADD CONSTRAINT "TB_PLAYERS_SKINS_CK" CHECK ("BOARD_SKINS" IS JSON)';
      END IF;
    END;`);

    // 코멘트 문자열 안의 작은따옴표는 두 번 쓴다
    const comment = AddTetrisBattlePlayersBoardSkins1792985407425.COLUMN_COMMENT.replace(/'/g, "''");
    await queryRunner.query(`COMMENT ON COLUMN "TETRIS_BATTLE_PLAYERS"."BOARD_SKINS" IS '${comment}'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 컬럼 DROP이 이 컬럼만 참조하는 CHECK를 함께 지운다. ⚠️ 지난 경기의 당시 스킨이 사라진다(모두 default로 보인다)
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'TETRIS_BATTLE_PLAYERS' AND column_name = 'BOARD_SKINS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "TETRIS_BATTLE_PLAYERS" DROP ("BOARD_SKINS") CASCADE CONSTRAINTS';
      END IF;
    END;`);
  }
}

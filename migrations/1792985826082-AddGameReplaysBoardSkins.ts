import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GAME_REPLAYS.BOARD_SKINS 추가 — 싱글 리플레이를 그 판 당시의 스킨으로 (docs/tasks/tetris-skins D-007)
 *
 * 배경: 리플레이 조회가 기록 주인의 "현재" 장착을 실어, 나중에 스킨을 바꾸면 지난 기록의 모습도 바뀌었다.
 * 판을 시작할 때(세션 발급)의 보드 스킨(블록·이펙트·판 배경)을 리플레이 행에 남긴다. 대전은 D-006(TETRIS_BATTLE_PLAYERS)
 *
 * - VARCHAR2(400 BYTE) NULL: JSON 문자열 {"block":…,"effect":…,"board":…}. 슬롯이 늘어도 DDL 변경이 없게 한 컬럼에 둔다
 * - NULL = 이 기능 전의 기록(그때는 스킨이 없어 기본 화면)·게스트·DEFENSE → 조회는 default로 돌려준다. 기존 행은 다시 쓰지 않는다
 * - CHECK IS JSON: 깨진 문자열이 들어가지 않게
 * - ⚠️ 배포 게이트: Entity에 boardSkins가 있는 코드가 이 마이그레이션 전에 배포되면 리플레이 저장(랭킹 등록)·조회가 실패한다
 *
 * 멱등: 컬럼·제약이 이미 있으면 건너뛴다.
 */
export class AddGameReplaysBoardSkins1792985826082 implements MigrationInterface {
  name = 'AddGameReplaysBoardSkins1792985826082';

  private static readonly COLUMN_COMMENT =
    '판 시작 때의 보드 스킨 JSON {"block","effect","board"} — 리플레이를 그 당시 모습으로. NULL = 기능 전 기록·게스트·스킨 없는 게임(default)';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'GAME_REPLAYS' AND column_name = 'BOARD_SKINS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "GAME_REPLAYS" ADD ("BOARD_SKINS" VARCHAR2(400 BYTE))';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_constraints WHERE table_name = 'GAME_REPLAYS' AND constraint_name = 'GAME_REPLAYS_SKINS_CK';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "GAME_REPLAYS" ADD CONSTRAINT "GAME_REPLAYS_SKINS_CK" CHECK ("BOARD_SKINS" IS JSON)';
      END IF;
    END;`);

    // 코멘트 문자열 안의 작은따옴표는 두 번 쓴다
    const comment = AddGameReplaysBoardSkins1792985826082.COLUMN_COMMENT.replace(/'/g, "''");
    await queryRunner.query(`COMMENT ON COLUMN "GAME_REPLAYS"."BOARD_SKINS" IS '${comment}'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 컬럼 DROP이 이 컬럼만 참조하는 CHECK를 함께 지운다. ⚠️ 지난 기록의 당시 스킨이 사라진다(모두 default로 보인다)
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'GAME_REPLAYS' AND column_name = 'BOARD_SKINS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "GAME_REPLAYS" DROP ("BOARD_SKINS") CASCADE CONSTRAINTS';
      END IF;
    END;`);
  }
}

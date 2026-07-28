import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TEAM_INVITATIONS.TOKEN VARCHAR2(255) → VARCHAR2(500) 확장 (D34-1)
 *
 * 배경: 초대 토큰은 JWT(team.service.ts:1047)인데 DB 컬럼이 255자라서
 * 페이로드 증가 시 ORA-12899(값이 열에 비해 너무 큼)로 삽입 실패 위험.
 * Entity(TeamInvitation.ts)는 이미 length 500으로 선언되어 있어 DB를 Entity에 맞춘다.
 *
 * 멱등: USER_TAB_COLUMNS의 char_length를 확인해 이미 500 이상이면 skip.
 */
export class ExpandTeamInvitationsToken1784784515184 implements MigrationInterface {
  name = 'ExpandTeamInvitationsToken1784784515184';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_len NUMBER;
    BEGIN
      SELECT char_length INTO v_len FROM user_tab_columns
       WHERE table_name = 'TEAM_INVITATIONS' AND column_name = 'TOKEN';
      IF v_len < 500 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "TEAM_INVITATIONS" MODIFY ("TOKEN" VARCHAR2(500))';
      END IF;
    END;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 축소는 기존 데이터가 255자 이하일 때만 안전 — 초과 데이터 존재 시 명시적 실패
    await queryRunner.query(`DECLARE
      v_max NUMBER;
    BEGIN
      SELECT NVL(MAX(LENGTH("TOKEN")), 0) INTO v_max FROM "TEAM_INVITATIONS";
      IF v_max > 255 THEN
        RAISE_APPLICATION_ERROR(-20001, 'TOKEN에 255자 초과 데이터가 있어 축소할 수 없습니다');
      END IF;
      EXECUTE IMMEDIATE 'ALTER TABLE "TEAM_INVITATIONS" MODIFY ("TOKEN" VARCHAR2(255))';
    END;`);
  }
}

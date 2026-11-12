import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * USER_TEAMS.TEAM_NICKNAME 추가 — 팀 안에서만 보이는 닉네임 (docs/tasks/team-nickname D-001·D-002)
 *
 * - VARCHAR2(100 BYTE) NULL — USERS.USER_NAME과 같은 크기. 앱 검증은 1~20자
 * - 가입 때 계정 닉네임을 복사해 채운다(D-004). 기존 행은 …074 백필이 채운다. 유니크 제약 없음(팀 안 중복 허용, D-002)
 * - ⚠️ 배포 게이트: Entity에 teamNickname이 있는 코드가 이 마이그레이션 전에 배포되면 USER_TEAMS 조회가 ORA-00904로 실패한다
 *
 * 멱등: 컬럼이 이미 있으면 건너뛴다.
 */
export class AddUserTeamsTeamNickname1793060509073 implements MigrationInterface {
  name = 'AddUserTeamsTeamNickname1793060509073';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'USER_TEAMS' AND column_name = 'TEAM_NICKNAME';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "USER_TEAMS" ADD ("TEAM_NICKNAME" VARCHAR2(100 BYTE))';
      END IF;
    END;`);
    await queryRunner.query(
      `COMMENT ON COLUMN "USER_TEAMS"."TEAM_NICKNAME" IS '팀 안에서 보이는 닉네임 — 가입 때 계정 닉네임을 복사하고 이후 독립. NULL이면 읽을 때 계정 닉네임으로 대체'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'USER_TEAMS' AND column_name = 'TEAM_NICKNAME';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "USER_TEAMS" DROP ("TEAM_NICKNAME")';
      END IF;
    END;`);
  }
}

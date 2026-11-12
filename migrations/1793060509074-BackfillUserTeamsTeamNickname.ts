import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * USER_TEAMS.TEAM_NICKNAME 백필 — 기존 팀 멤버의 팀 닉네임을 지금의 계정 닉네임으로 채운다 (docs/tasks/team-nickname D-004)
 *
 * 배경: 팀 닉네임은 가입 때 계정 닉네임을 복사하고 이후 독립한다. 기존 멤버는 복사본이 없어서 NULL이면
 * 계정 닉네임을 그대로 따라가 마이페이지 변경이 팀에 번진다. 지금 값을 복사해 두어 이후 변경과 끊는다.
 *
 * - 값: USERS.USER_NAME, 없으면 '사용자{USER_ID}' (앱의 getDisplayName과 같은 규칙)
 * - 대상: TEAM_NICKNAME IS NULL 행만 — 이미 정한 팀 닉네임은 건드리지 않는다
 * - 비활성(탈퇴) 멤버도 채운다 — 지난 태스크·댓글·채팅의 작성자 이름이다
 * - ⚠️ 순서: …073(컬럼 추가) 뒤에 실행. 이 마이그레이션 실행 후 새 코드 배포 전 사이에 옛 코드로 가입한 행은 NULL로 남지만
 *   읽을 때 계정 닉네임으로 대체되므로 깨지지 않는다(같은 UPDATE를 담당자가 다시 실행하면 채워진다 — 멱등)
 *
 * 멱등: NULL 행만 갱신하므로 다시 실행해도 결과가 같다.
 */
export class BackfillUserTeamsTeamNickname1793060509074 implements MigrationInterface {
  name = 'BackfillUserTeamsTeamNickname1793060509074';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "USER_TEAMS" ut
         SET ut."TEAM_NICKNAME" = (
               SELECT NVL(u."USER_NAME", '사용자' || u."USER_ID")
                 FROM "USERS" u
                WHERE u."USER_ID" = ut."USER_ID"
             )
       WHERE ut."TEAM_NICKNAME" IS NULL
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // 되돌리지 않는다 — 백필한 값과 사용자가 직접 정한 값을 구분할 수 없다.
    // 컬럼째 되돌리려면 …073의 down이 컬럼을 지운다.
  }
}

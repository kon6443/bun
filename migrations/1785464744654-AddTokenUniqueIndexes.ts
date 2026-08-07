import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 초대·텔레그램 연동 토큰에 유니크 인덱스 추가 (D23)
 *
 * 배경: 두 토큰 모두 DB 레벨 유니크 제약이 없었다. 애플리케이션 검증만으로는
 * 동시 요청 시 양쪽 모두 "중복 없음"으로 판단할 수 있어 중복 INSERT가 성립한다.
 *
 * ⚠️ 선행 조건: 초대 토큰은 JWT이고 payload가 {teamId, userId, iat, exp}뿐이면
 * 같은 팀·유저가 1초 안에 두 번 요청할 때 동일한 토큰이 생성된다. 이 인덱스와
 * 함께 team.service.createTeamInvite의 payload에 jti(nonce)를 추가했다.
 * jti 없이 이 마이그레이션만 적용하면 더블클릭이 ORA-00001로 실패한다.
 * (텔레그램 토큰은 randomBytes(32) 기반이라 해당 없음)
 *
 * 사전 확인(2026-07-31 실측): TEAM_INVITATIONS 21행/distinct 21,
 * TEAM_TELEGRAM_LINKS 3행/distinct 3 — 중복 0건, TOKEN에 기존 인덱스 없음.
 *
 * 멱등: 컬럼에 이미 인덱스가 있으면 skip (인덱스명이 달라도 ORA-01408 회피).
 * NULL 허용 컬럼이지만 Oracle 유니크 인덱스는 다중 NULL을 허용하므로 문제없다.
 */
export class AddTokenUniqueIndexes1785464744654 implements MigrationInterface {
  name = 'AddTokenUniqueIndexes1785464744654';

  private static readonly TARGETS = [
    { table: 'TEAM_INVITATIONS', index: 'IDX_INVITE_TOKEN' },
    { table: 'TEAM_TELEGRAM_LINKS', index: 'IDX_TELEGRAM_LINK_TOKEN' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { table, index } of AddTokenUniqueIndexes1785464744654.TARGETS) {
      await queryRunner.query(`DECLARE
        v_cnt NUMBER;
      BEGIN
        -- 인덱스명 또는 동일 컬럼 인덱스가 이미 있으면 skip
        SELECT COUNT(*) INTO v_cnt FROM user_ind_columns
         WHERE table_name = '${table}' AND column_name = 'TOKEN';
        IF v_cnt = 0 THEN
          SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = '${index}';
          IF v_cnt = 0 THEN
            EXECUTE IMMEDIATE 'CREATE UNIQUE INDEX "${index}" ON "${table}" ("TOKEN")';
          END IF;
        END IF;
      END;`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { index } of AddTokenUniqueIndexes1785464744654.TARGETS) {
      await queryRunner.query(`DECLARE
        v_cnt NUMBER;
      BEGIN
        SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = '${index}';
        IF v_cnt > 0 THEN
          EXECUTE IMMEDIATE 'DROP INDEX "${index}"';
        END IF;
      END;`);
    }
  }
}

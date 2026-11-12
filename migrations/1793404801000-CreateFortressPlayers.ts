import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 포트리스 참가자 결과 테이블 생성 (docs/tasks/fortress DESIGN §12 — F6)
 *
 * - PK (MATCH_ID, PLAYER_ID): PLAYER_ID는 방 안의 id(p1, p2, …).
 * - FK MATCH_ID → FORTRESS_MATCHES ON DELETE CASCADE: 경기를 지우면 참가자 결과도 지운다.
 * - USER_ID: 로그인 참가자만. FK → USERS ON DELETE SET NULL(탈퇴해도 경기 기록은 이름으로 남긴다). 게스트 NULL.
 * - NAME: 게임 이름 정책(1~12자) — TETRIS_BATTLE_PLAYERS.NAME과 같은 48바이트 상한.
 * - SLOT 0~3, TEAM 0·1(ffa NULL), TANK_ID 엔진 TANKS 인덱스, HP·DAMAGE·KOS·PLACE는 경기 종료 때 서버 집계(matchEnded와 같은 값).
 *
 * 멱등: 테이블은 존재 확인 후 생성한다. CreateFortressMatches 다음에 실행된다(타임스탬프 순).
 */
export class CreateFortressPlayers1793404801000 implements MigrationInterface {
  name = 'CreateFortressPlayers1793404801000';

  private static readonly TABLE_COMMENT = '포트리스 참가자 결과. 경기 1건당 2~4행. 값은 경기 종료 때 서버 집계';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    MATCH_ID: '경기 ID (PK, FK → FORTRESS_MATCHES, 경기 삭제 시 CASCADE)',
    PLAYER_ID: '방 안의 참가자 ID (PK, p1·p2…)',
    SLOT: '엔진 slot (0~3, 입장 순서)',
    NAME: '표시 이름 (1~12자, 게임 이름 정책)',
    USER_ID: '로그인 참가자의 사용자 ID (FK → USERS.USER_ID, 탈퇴 시 NULL). 게스트는 NULL',
    TEAM: 'team 모드 팀 (0·1). ffa는 NULL',
    TANK_ID: '탱크 종류 (엔진 TANKS 인덱스)',
    HP: '종료 시 남은 HP',
    DAMAGE: '자기 턴 발사로 다른 팀에게 깎은 HP 합',
    KOS: '자기 턴 발사로 다른 팀 탱크를 죽인 수',
    PLACE: '최종 순위 (1 = 우승, 같은 값은 같은 순위)',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'FORTRESS_PLAYERS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "FORTRESS_PLAYERS" (
            "MATCH_ID" VARCHAR2(16 BYTE) NOT NULL,
            "PLAYER_ID" VARCHAR2(8 BYTE) NOT NULL,
            "SLOT" NUMBER(1) NOT NULL,
            "NAME" VARCHAR2(48 BYTE) NOT NULL,
            "USER_ID" NUMBER,
            "TEAM" NUMBER(1),
            "TANK_ID" NUMBER(2) NOT NULL,
            "HP" NUMBER(5) NOT NULL,
            "DAMAGE" NUMBER(10) NOT NULL,
            "KOS" NUMBER(2) NOT NULL,
            "PLACE" NUMBER(1) NOT NULL,
            CONSTRAINT "PK_FT_PLAYERS" PRIMARY KEY ("MATCH_ID", "PLAYER_ID"),
            CONSTRAINT "FT_PLAYERS_SLOT_CK" CHECK ("SLOT" BETWEEN 0 AND 3),
            CONSTRAINT "FT_PLAYERS_TEAM_CK" CHECK ("TEAM" IS NULL OR "TEAM" IN (0, 1)),
            CONSTRAINT "FT_PLAYERS_PLACE_CK" CHECK ("PLACE" BETWEEN 1 AND 4),
            CONSTRAINT "FK_FT_PLAYERS_MATCH" FOREIGN KEY ("MATCH_ID") REFERENCES "FORTRESS_MATCHES" ("MATCH_ID") ON DELETE CASCADE,
            CONSTRAINT "FK_FT_PLAYERS_USER" FOREIGN KEY ("USER_ID") REFERENCES "USERS" ("USER_ID") ON DELETE SET NULL
          )';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateFortressPlayers1793404801000;
    await queryRunner.query(`COMMENT ON TABLE "FORTRESS_PLAYERS" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "FORTRESS_PLAYERS"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ⚠️ 모든 포트리스 참가자 결과가 사라진다(경기·리플레이 행은 남는다).
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'FORTRESS_PLAYERS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "FORTRESS_PLAYERS" PURGE';
      END IF;
    END;`);
  }
}

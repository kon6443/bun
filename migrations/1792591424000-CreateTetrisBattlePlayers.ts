import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 테트리스 대전 참가자 결과 테이블 생성 (docs/tasks/tetris-battle D-021, 정본 DESIGN.md §17-2)
 *
 * - PK (MATCH_ID, PLAYER_ID): PLAYER_ID는 방 안의 id(p1, p2, …).
 * - FK MATCH_ID → TETRIS_BATTLE_MATCHES ON DELETE CASCADE: 경기를 지우면 참가자 결과도 지운다.
 * - USER_ID: 로그인 참가자만. FK → USERS ON DELETE SET NULL(탈퇴해도 경기 기록은 이름으로 남긴다).
 * - NAME: 게임 이름 정책(1~12자) — GAME_SCORES.PLAYER_NAME과 같은 48바이트 상한.
 * - 통계는 실시간 서버 기록. FRAMES는 탈락 프레임(우승자는 마지막 고정 프레임).
 * - KO_REASON: topout·disconnect·leave, 우승자 NULL. VERDICT: VERIFIED·INVALID·MISSING(미제출).
 *
 * 멱등: 테이블은 존재 확인 후 생성한다. CreateTetrisBattleMatches 다음에 실행된다(타임스탬프 순).
 */
export class CreateTetrisBattlePlayers1792591424000 implements MigrationInterface {
  name = 'CreateTetrisBattlePlayers1792591424000';

  private static readonly TABLE_COMMENT =
    '테트리스 대전 참가자 결과. 경기 1건당 2~4행. 통계는 실시간 서버 기록, VERDICT는 리플레이 검증 결과';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    MATCH_ID: '경기 ID (PK, FK → TETRIS_BATTLE_MATCHES, 경기 삭제 시 CASCADE)',
    PLAYER_ID: '방 안의 참가자 ID (PK, p1·p2…)',
    NAME: '표시 이름 (1~12자, 게임 이름 정책)',
    USER_ID: '로그인 참가자의 사용자 ID (FK → USERS.USER_ID, 탈퇴 시 NULL). 게스트는 NULL',
    PLACE: '최종 순위 (1 = 우승)',
    KOS: '이 참가자의 공격으로 탈락한 상대 수',
    SENT: '보낸 공격 줄 합계',
    RECEIVED: '받은 공격 줄 합계',
    PIECES: '고정한 블록 수',
    MAX_COMBO: '최대 콤보',
    FRAMES: '탈락 프레임(우승자는 마지막 고정 프레임, 60fps)',
    KO_REASON: '탈락 사유. topout 판이 넘침 · disconnect 끊김 유예 초과 · leave 기권. 우승자 NULL',
    VERDICT: '리플레이 검증 결과. VERIFIED 통과 · INVALID 실시간 기록과 불일치 · MISSING 미제출',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TETRIS_BATTLE_PLAYERS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "TETRIS_BATTLE_PLAYERS" (
            "MATCH_ID" VARCHAR2(16 BYTE) NOT NULL,
            "PLAYER_ID" VARCHAR2(8 BYTE) NOT NULL,
            "NAME" VARCHAR2(48 BYTE) NOT NULL,
            "USER_ID" NUMBER,
            "PLACE" NUMBER(1) NOT NULL,
            "KOS" NUMBER(5) NOT NULL,
            "SENT" NUMBER(10) NOT NULL,
            "RECEIVED" NUMBER(10) NOT NULL,
            "PIECES" NUMBER(10) NOT NULL,
            "MAX_COMBO" NUMBER(10) NOT NULL,
            "FRAMES" NUMBER(10) NOT NULL,
            "KO_REASON" VARCHAR2(10 BYTE),
            "VERDICT" VARCHAR2(10 BYTE) NOT NULL,
            CONSTRAINT "PK_TB_PLAYERS" PRIMARY KEY ("MATCH_ID", "PLAYER_ID"),
            CONSTRAINT "TB_PLAYERS_PLACE_CK" CHECK ("PLACE" BETWEEN 1 AND 4),
            CONSTRAINT "TB_PLAYERS_KO_REASON_CK" CHECK ("KO_REASON" IS NULL OR "KO_REASON" IN (''topout'', ''disconnect'', ''leave'')),
            CONSTRAINT "TB_PLAYERS_VERDICT_CK" CHECK ("VERDICT" IN (''VERIFIED'', ''INVALID'', ''MISSING'')),
            CONSTRAINT "FK_TB_PLAYERS_MATCH" FOREIGN KEY ("MATCH_ID") REFERENCES "TETRIS_BATTLE_MATCHES" ("MATCH_ID") ON DELETE CASCADE,
            CONSTRAINT "FK_TB_PLAYERS_USER" FOREIGN KEY ("USER_ID") REFERENCES "USERS" ("USER_ID") ON DELETE SET NULL
          )';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateTetrisBattlePlayers1792591424000;
    await queryRunner.query(`COMMENT ON TABLE "TETRIS_BATTLE_PLAYERS" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "TETRIS_BATTLE_PLAYERS"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ⚠️ 모든 대전 참가자 결과가 사라진다. REPLAYS가 이 테이블을 참조하므로 CreateTetrisBattleReplays를 먼저 revert(역순이라 자연히 지켜짐).
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TETRIS_BATTLE_PLAYERS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "TETRIS_BATTLE_PLAYERS" PURGE';
      END IF;
    END;`);
  }
}

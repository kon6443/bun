import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 포트리스 경기 테이블 생성 (docs/tasks/fortress DESIGN §12 — F6)
 *
 * 배경: 포트리스는 서버가 턴마다 엔진을 돌려 결과를 확정하므로(서버 권위), 경기가 끝나면 서버가 결과·행동 로그를 바로 저장한다.
 * 테트리스 대전(TETRIS_BATTLE_*)과 통계·리플레이 구조가 달라 별도 테이블로 둔다.
 *
 * - MATCH_ID: 서버가 발급한 12바이트 base64url 16자 (IDENTITY 아님). 리플레이 id와 같다.
 * - ROOM_NAME: 1~20자(코드 포인트, 이모지 허용) → UTF-8 최대 80바이트. NULL 허용 — 기능 배포 전에 시작한 경기는 방 이름을
 *   모른다(Oracle은 ''를 NULL로 다루므로 빈 문자열 대신 NULL).
 * - MODE ffa·team, RESULT_KIND win·draw, WINNER_TEAM은 team 승리만(그 밖 NULL).
 * - TURNS: 끝난 턴 수(엔진 state.turn.no). 4인 30라운드 상한 120.
 * - IS_HIDDEN: 운영자 숨김(SQL로 갱신). 인덱스 (CRTD_AT) — 최근 경기 목록.
 *
 * 멱등: 테이블·인덱스는 존재 확인 후 생성한다. COMMENT ON은 재실행해도 덮어쓸 뿐이다.
 * 신규 테이블이라 기존 코드에 영향이 없다 — 앱 배포 전에 먼저 적용해야 한다(저장 코드가 이 테이블에 쓴다). PLAYERS·REPLAYS보다 먼저 실행된다.
 */
export class CreateFortressMatches1793404800000 implements MigrationInterface {
  name = 'CreateFortressMatches1793404800000';

  private static readonly TABLE_COMMENT = '포트리스 경기(2~4인). 경기 종료 때 서버가 1건 저장. IS_HIDDEN은 조회 제외';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    MATCH_ID: '경기 ID (PK, 서버 발급 base64url 16자) — 리플레이 id와 같다',
    ROOM_NAME: '경기한 방 이름 (1~20자, 이모지 허용). 기능 배포 전에 시작한 경기는 NULL',
    MODE: '경기 방식. ffa 개인전 · team 2:2 팀전',
    MAP_ID: '맵 id (엔진 MAP_IDS — hills·canyon 등)',
    SEED: '경기 시드 — 지형·시작 순서·바람 (0 ~ 4294967295)',
    ENGINE_VERSION: '경기를 돌린 엔진 버전. 리플레이 재생에 같은 버전이 필요',
    PLAYER_COUNT: '참가 인원 (2~4)',
    TURNS: '끝난 턴 수 (엔진 state.turn.no)',
    RESULT_KIND: '결과. win 승리(개인·팀) · draw 무승부',
    WINNER_TEAM: 'team 모드 승리 팀 (0·1). ffa·무승부는 NULL',
    STARTED_AT: '경기 시작 시각 (UTC, 서버가 시작을 확정한 시각)',
    ENDED_AT: '경기 종료 시각 (UTC, 경기를 끝낸 행동이 확정된 시각)',
    IS_HIDDEN: '운영자 숨김 여부 (1이면 조회 제외). 운영자가 SQL로 갱신',
    CRTD_AT: '저장 시각 (UTC) — 최근 경기 목록 정렬 키',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    // EXECUTE IMMEDIATE 문자열 안의 작은따옴표는 두 번 쓴다 (CHECK의 문자열 리터럴)
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'FORTRESS_MATCHES';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "FORTRESS_MATCHES" (
            "MATCH_ID" VARCHAR2(16 BYTE) NOT NULL,
            "ROOM_NAME" VARCHAR2(80 BYTE),
            "MODE" VARCHAR2(4 BYTE) NOT NULL,
            "MAP_ID" VARCHAR2(16 BYTE) NOT NULL,
            "SEED" NUMBER(10) NOT NULL,
            "ENGINE_VERSION" NUMBER(5) NOT NULL,
            "PLAYER_COUNT" NUMBER(1) NOT NULL,
            "TURNS" NUMBER(5) NOT NULL,
            "RESULT_KIND" VARCHAR2(4 BYTE) NOT NULL,
            "WINNER_TEAM" NUMBER(1),
            "STARTED_AT" TIMESTAMP (6) WITH TIME ZONE NOT NULL,
            "ENDED_AT" TIMESTAMP (6) WITH TIME ZONE NOT NULL,
            "IS_HIDDEN" NUMBER(1) DEFAULT 0 NOT NULL,
            "CRTD_AT" TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT "PK_FT_MATCHES" PRIMARY KEY ("MATCH_ID"),
            CONSTRAINT "FT_MATCHES_MODE_CK" CHECK ("MODE" IN (''ffa'', ''team'')),
            CONSTRAINT "FT_MATCHES_SEED_CK" CHECK ("SEED" BETWEEN 0 AND 4294967295),
            CONSTRAINT "FT_MATCHES_COUNT_CK" CHECK ("PLAYER_COUNT" BETWEEN 2 AND 4),
            CONSTRAINT "FT_MATCHES_TURNS_CK" CHECK ("TURNS" >= 0),
            CONSTRAINT "FT_MATCHES_RESULT_CK" CHECK ("RESULT_KIND" IN (''win'', ''draw'')),
            CONSTRAINT "FT_MATCHES_WINNER_CK" CHECK ("WINNER_TEAM" IS NULL OR "WINNER_TEAM" IN (0, 1)),
            CONSTRAINT "FT_MATCHES_HIDDEN_CK" CHECK ("IS_HIDDEN" IN (0, 1))
          )';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = 'IDX_FT_MATCHES_CRTD';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX "IDX_FT_MATCHES_CRTD" ON "FORTRESS_MATCHES" ("CRTD_AT")';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateFortressMatches1793404800000;
    await queryRunner.query(`COMMENT ON TABLE "FORTRESS_MATCHES" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "FORTRESS_MATCHES"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 인덱스·제약·코멘트를 함께 제거한다. ⚠️ 모든 포트리스 경기 기록이 사라진다.
    // PLAYERS·REPLAYS가 이 테이블을 참조하므로 그 둘을 먼저 revert해야 한다(revert는 역순이라 자연히 지켜진다).
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'FORTRESS_MATCHES';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "FORTRESS_MATCHES" PURGE';
      END IF;
    END;`);
  }
}

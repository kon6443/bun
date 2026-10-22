import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 테트리스 대전 경기 테이블 생성 (docs/tasks/tetris-battle D-008·D-021, 정본 DESIGN.md §17-2)
 *
 * 배경: 대전(2~4인)이 끝나면 각 플레이어가 리플레이를 제출하고, 서버가 실시간 기록과 대조해 검증한 뒤 경기 1건을 저장한다.
 * 기존 GAME_SCORES·GAME_REPLAYS(1인 랭킹)와 구조가 달라 별도 테이블로 둔다(D-021).
 *
 * - MATCH_ID: 서버가 발급한 12바이트 base64url 16자 (IDENTITY 아님).
 * - ROOM_NAME: 1~20자(코드 포인트, 이모지 허용) → UTF-8 최대 80바이트. 저장소 관례대로 VARCHAR2(BYTE).
 * - STATUS: VERIFIED(제출자 전원 검증 통과, 미제출은 MISSING) · DISPUTED(INVALID 1명 이상 — 공유·재생 목록 제외).
 * - IS_HIDDEN: 운영자 숨김(GAME_SCORES와 같은 방식, SQL로 갱신).
 * - 인덱스: (CRTD_AT) — 최근 경기 목록(P6).
 *
 * 멱등: 테이블·인덱스는 존재 확인 후 생성한다. COMMENT ON은 재실행해도 덮어쓸 뿐이다.
 * 신규 테이블이라 기존 코드에 영향이 없다 — 앱 배포 전에 먼저 적용해도 된다. PLAYERS·REPLAYS보다 먼저 실행된다(타임스탬프 순).
 */
export class CreateTetrisBattleMatches1792591423000 implements MigrationInterface {
  name = 'CreateTetrisBattleMatches1792591423000';

  private static readonly TABLE_COMMENT =
    '테트리스 대전 경기(2~4인). 경기 후 리플레이 검증을 거쳐 1건 저장. DISPUTED·IS_HIDDEN은 조회 제외';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    MATCH_ID: '경기 ID (PK, 서버 발급 base64url 16자)',
    ROOM_NAME: '경기한 방 이름 (1~20자, 이모지 허용)',
    SEED: '블록 순서 시드 — 참가자 전원 공통 (0 ~ 4294967295)',
    PLAYER_COUNT: '참가 인원 (2~4)',
    STATUS: '경기 검증 상태. VERIFIED 제출자 전원 통과(미제출은 MISSING) · DISPUTED 검증 실패 참가자 있음(공유·재생 제외)',
    STARTED_AT: '경기 시작 시각 (UTC, 서버가 시작을 확정한 시각)',
    ENDED_AT: '경기 종료 시각 (UTC, 생존자 1명 이하가 된 시각)',
    IS_HIDDEN: '운영자 숨김 여부 (1이면 조회 제외). 운영자가 SQL로 갱신',
    CRTD_AT: '저장 시각 (UTC)',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    // EXECUTE IMMEDIATE 문자열 안의 작은따옴표는 두 번 쓴다 (CHECK의 문자열 리터럴)
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TETRIS_BATTLE_MATCHES';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "TETRIS_BATTLE_MATCHES" (
            "MATCH_ID" VARCHAR2(16 BYTE) NOT NULL,
            "ROOM_NAME" VARCHAR2(80 BYTE) NOT NULL,
            "SEED" NUMBER(10) NOT NULL,
            "PLAYER_COUNT" NUMBER(1) NOT NULL,
            "STATUS" VARCHAR2(10 BYTE) NOT NULL,
            "STARTED_AT" TIMESTAMP (6) WITH TIME ZONE NOT NULL,
            "ENDED_AT" TIMESTAMP (6) WITH TIME ZONE NOT NULL,
            "IS_HIDDEN" NUMBER(1) DEFAULT 0 NOT NULL,
            "CRTD_AT" TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT "PK_TB_MATCHES" PRIMARY KEY ("MATCH_ID"),
            CONSTRAINT "TB_MATCHES_SEED_CK" CHECK ("SEED" BETWEEN 0 AND 4294967295),
            CONSTRAINT "TB_MATCHES_COUNT_CK" CHECK ("PLAYER_COUNT" BETWEEN 2 AND 4),
            CONSTRAINT "TB_MATCHES_STATUS_CK" CHECK ("STATUS" IN (''VERIFIED'', ''DISPUTED'')),
            CONSTRAINT "TB_MATCHES_HIDDEN_CK" CHECK ("IS_HIDDEN" IN (0, 1))
          )';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = 'IDX_TB_MATCHES_CRTD';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX "IDX_TB_MATCHES_CRTD" ON "TETRIS_BATTLE_MATCHES" ("CRTD_AT")';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateTetrisBattleMatches1792591423000;
    await queryRunner.query(`COMMENT ON TABLE "TETRIS_BATTLE_MATCHES" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "TETRIS_BATTLE_MATCHES"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 인덱스·제약·코멘트를 함께 제거한다. ⚠️ 모든 대전 경기 기록이 사라진다.
    // PLAYERS가 이 테이블을 참조하므로 CreateTetrisBattlePlayers를 먼저 revert해야 한다(revert는 역순이라 자연히 지켜진다).
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TETRIS_BATTLE_MATCHES';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "TETRIS_BATTLE_MATCHES" PURGE';
      END IF;
    END;`);
  }
}

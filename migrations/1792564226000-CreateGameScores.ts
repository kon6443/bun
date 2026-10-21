import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 게임 공용 랭킹 기록 테이블 생성 (docs/tasks/games D-003·D-004·D-006·D-010, 정본 DESIGN.md §1)
 *
 * 배경: 게임 모음집의 모든 게임 랭킹 기록을 한 테이블에 둔다(GAME_TYPE으로 구분). 비로그인도 이름을 입력해 등록하고,
 * 점수는 서버가 리플레이를 다시 실행해 계산한 값만 저장한다(클라이언트 점수는 받지 않음).
 *
 * - GAME_TYPE: 코드값 + CHECK. 새 게임은 CHECK 교체 마이그레이션 1개(GAME_REPLAYS도 함께).
 * - PLAYER_NAME: 앱 제한 12자 + 바이트 상한 48(한글·이모지 여유).
 * - DETAIL: 게임별 값(테트리스: 줄·레벨·블록 수 등) JSON. Oracle 19c라 JSON 타입이 없어 CLOB + IS JSON.
 * - IP_HASH: 비로그인 도배 판별용 HMAC-SHA256 hex. 원문 IP는 저장하지 않는다.
 * - USER_ID ON DELETE SET NULL: 탈퇴해도 랭킹 기록은 이름으로 남긴다.
 * - UK (SCORE_ID, GAME_TYPE): GAME_REPLAYS의 복합 FK 대상 — 리플레이의 게임 종류가 기록과 다르면 DB가 거부(D-012).
 * - 인덱스: (GAME_TYPE, SCORE DESC, CRTD_AT) 전체 랭킹 · (GAME_TYPE, CRTD_AT) 일간·주간 랭킹과 통계.
 *
 * 멱등: 테이블·인덱스는 존재 확인 후 생성한다. COMMENT ON은 재실행해도 덮어쓸 뿐이다.
 * 신규 테이블 추가라 기존 테이블·코드에 영향이 없다 — 앱 배포 전에 먼저 적용해도 된다.
 */
export class CreateGameScores1792564226000 implements MigrationInterface {
  name = 'CreateGameScores1792564226000';

  private static readonly TABLE_COMMENT =
    '게임 공용 랭킹 기록. 게임 종류는 GAME_TYPE. 점수는 서버가 리플레이를 재실행해 계산한 값. 비로그인도 이름으로 등록. 운영자는 IS_HIDDEN으로 숨긴다';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    SCORE_ID: '기록 ID (PK, IDENTITY)',
    GAME_TYPE: '게임 종류 코드. TETRIS 테트리스',
    SCORE: '점수 (0 이상 정수, 서버가 리플레이로 계산). 게임마다 의미가 달라 게임 간 비교·합산 금지',
    PLAYER_NAME: '랭킹 표시 이름. 앞뒤 공백 제거 후 1~12자, 한글·영문·숫자·공백·_·- 만 허용, 금칙어 불가',
    USER_ID: '등록한 로그인 사용자 ID (FK → USERS.USER_ID, 탈퇴 시 NULL). 비로그인 등록이면 NULL',
    DURATION_MS: '플레이 시간 (밀리초, 리플레이 프레임 수 × 1000 / 60)',
    DETAIL: '게임별 상세 값 JSON. TETRIS: lines·level·pieces·tSpins·tetrises·maxCombo·engineVersion·das·arr',
    IP_HASH: '등록 요청 IP의 HMAC-SHA256 hex (원문 IP 미저장, 비로그인 도배 판별용). 시크릿 미설정 시 NULL',
    IS_HIDDEN: '운영자 숨김 여부 (1이면 랭킹·리플레이 조회에서 제외). 운영자가 SQL로 갱신',
    CRTD_AT: '등록 시각 (UTC). 일간·주간 랭킹 경계는 KST 기준으로 계산',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    // EXECUTE IMMEDIATE 문자열 안의 작은따옴표는 두 번 쓴다 (CHECK의 문자열 리터럴)
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'GAME_SCORES';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "GAME_SCORES" (
            "SCORE_ID" NUMBER GENERATED ALWAYS AS IDENTITY NOT NULL,
            "GAME_TYPE" VARCHAR2(20 BYTE) NOT NULL,
            "SCORE" NUMBER(12) NOT NULL,
            "PLAYER_NAME" VARCHAR2(48 BYTE) NOT NULL,
            "USER_ID" NUMBER,
            "DURATION_MS" NUMBER(10) NOT NULL,
            "DETAIL" CLOB NOT NULL,
            "IP_HASH" VARCHAR2(64 BYTE),
            "IS_HIDDEN" NUMBER(1) DEFAULT 0 NOT NULL,
            "CRTD_AT" TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT "PK_GAME_SCORES" PRIMARY KEY ("SCORE_ID"),
            CONSTRAINT "UK_GAME_SCORES_ID_TYPE" UNIQUE ("SCORE_ID", "GAME_TYPE"),
            CONSTRAINT "GAME_SCORES_TYPE_CK" CHECK ("GAME_TYPE" IN (''TETRIS'')),
            CONSTRAINT "GAME_SCORES_SCORE_CK" CHECK ("SCORE" >= 0),
            CONSTRAINT "GAME_SCORES_HIDDEN_CK" CHECK ("IS_HIDDEN" IN (0, 1)),
            CONSTRAINT "GAME_SCORES_DETAIL_CK" CHECK ("DETAIL" IS JSON),
            CONSTRAINT "FK_GAME_SCORES_USER" FOREIGN KEY ("USER_ID") REFERENCES "USERS" ("USER_ID") ON DELETE SET NULL
          )';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = 'IDX_GAME_SCORES_TYPE_SCORE';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX "IDX_GAME_SCORES_TYPE_SCORE" ON "GAME_SCORES" ("GAME_TYPE", "SCORE" DESC, "CRTD_AT")';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = 'IDX_GAME_SCORES_TYPE_CRTD';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX "IDX_GAME_SCORES_TYPE_CRTD" ON "GAME_SCORES" ("GAME_TYPE", "CRTD_AT")';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateGameScores1792564226000;
    await queryRunner.query(`COMMENT ON TABLE "GAME_SCORES" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "GAME_SCORES"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 인덱스·제약·코멘트를 함께 제거한다. ⚠️ 모든 게임 랭킹 기록이 사라진다.
    // GAME_REPLAYS가 이 테이블을 참조하므로 CreateGameReplays를 먼저 revert해야 한다(revert는 역순이라 자연히 지켜진다).
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'GAME_SCORES';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "GAME_SCORES" PURGE';
      END IF;
    END;`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 팀 채팅 메시지 테이블 생성 (docs/tasks/team-chat-persistence D-001·D-003·D-006·D-013)
 *
 * 배경: 팀 채팅이 저장 없이 브로드캐스트만 하던 것을 영속화한다.
 *
 * - MESSAGE_ID: IDENTITY (ORDER) — Autonomous DB(RAC)에서 인스턴스 간에도 발급 순서를 보장한다.
 *   읽음 커서가 "이 ID까지 읽음"으로 동작하므로 ID 순서가 시간 순서여야 한다.
 * - CONTENT: CLOB — 앱 제한 4,000자(한글 1자 3바이트라 VARCHAR2 4000바이트로는 약 1,300자가 한계).
 *   약 4000바이트 이하는 행 안에 저장(기본 ENABLE STORAGE IN ROW)되어 짧은 메시지는 실제 크기만 차지한다.
 * - (TEAM_ID, MESSAGE_ID) 인덱스: 최신순 이력 조회, "이 ID 이전" 페이지 조회, 안읽음 수 범위 스캔.
 * - (TEAM_ID, USER_ID, CLIENT_MSG_ID) 유니크: 재전송 시 같은 메시지가 두 번 저장되지 않게 한다.
 *
 * 멱등: 테이블·인덱스는 존재 확인 후 생성한다. COMMENT ON은 재실행해도 덮어쓸 뿐이다.
 * 신규 테이블 추가라 기존 테이블·코드에 영향이 없다 — 앱 배포 전에 먼저 적용해도 된다.
 */
export class CreateTeamChatMessages1791960322000 implements MigrationInterface {
  name = 'CreateTeamChatMessages1791960322000';

  private static readonly TABLE_COMMENT = '팀 채팅 메시지. 팀(room) 단위 단일 채팅방의 대화 이력';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    MESSAGE_ID: '메시지 ID (PK, IDENTITY ORDER). 팀 안에서 단조 증가하며 읽음 커서의 기준값',
    TEAM_ID: '팀 ID (FK → TEAMS.TEAM_ID)',
    USER_ID: '보낸 사용자 ID (FK → USERS.USER_ID)',
    CONTENT: '메시지 본문 (앱 제한: 4000자, 16000바이트)',
    CLIENT_MSG_ID: '클라이언트가 생성한 메시지 식별자(UUID). 재전송 중복 방지 및 낙관적 업데이트 매칭 키',
    STATUS: '노출 상태 (0: 삭제/숨김, 1: 활성)',
    CRTD_AT: '전송 시각 (UTC, 서버 생성)',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TEAM_CHAT_MESSAGES';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "TEAM_CHAT_MESSAGES" (
            "MESSAGE_ID" NUMBER GENERATED ALWAYS AS IDENTITY (ORDER) NOT NULL,
            "TEAM_ID" NUMBER NOT NULL,
            "USER_ID" NUMBER NOT NULL,
            "CONTENT" CLOB NOT NULL,
            "CLIENT_MSG_ID" VARCHAR2(64 BYTE) NOT NULL,
            "STATUS" NUMBER(1,0) DEFAULT 1 NOT NULL,
            "CRTD_AT" TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT "PK_TEAM_CHAT_MESSAGES" PRIMARY KEY ("MESSAGE_ID"),
            CONSTRAINT "TEAM_CHAT_MESSAGES_STATUS_CK" CHECK ("STATUS" IN (0, 1)),
            CONSTRAINT "FK_TEAM_CHAT_MESSAGES_TEAM" FOREIGN KEY ("TEAM_ID") REFERENCES "TEAMS" ("TEAM_ID"),
            CONSTRAINT "FK_TEAM_CHAT_MESSAGES_USER" FOREIGN KEY ("USER_ID") REFERENCES "USERS" ("USER_ID")
          )';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = 'IDX_TEAM_CHAT_MESSAGES_TEAM';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE INDEX "IDX_TEAM_CHAT_MESSAGES_TEAM" ON "TEAM_CHAT_MESSAGES" ("TEAM_ID", "MESSAGE_ID")';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_indexes WHERE index_name = 'UK_TEAM_CHAT_MESSAGES_CLIENT';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'CREATE UNIQUE INDEX "UK_TEAM_CHAT_MESSAGES_CLIENT" ON "TEAM_CHAT_MESSAGES" ("TEAM_ID", "USER_ID", "CLIENT_MSG_ID")';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateTeamChatMessages1791960322000;
    await queryRunner.query(`COMMENT ON TABLE "TEAM_CHAT_MESSAGES" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "TEAM_CHAT_MESSAGES"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 테이블 DROP이 인덱스·제약·코멘트를 함께 제거한다. ⚠️ 저장된 메시지가 전부 사라진다.
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TEAM_CHAT_MESSAGES';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "TEAM_CHAT_MESSAGES" PURGE';
      END IF;
    END;`);
  }
}

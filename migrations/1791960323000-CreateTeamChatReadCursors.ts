import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 팀 채팅 읽음 커서 테이블 생성 (docs/tasks/team-chat-persistence D-001·D-004)
 *
 * 팀·멤버당 1행으로 "어디까지 읽었는가"(LAST_READ_MESSAGE_ID)만 저장한다.
 * 메시지별 읽음 행을 두지 않고 이 값 하나로 안 읽은 인원 수·읽은 사람 목록·안읽음 배지를 계산한다.
 *
 * - PK (TEAM_ID, USER_ID): 조회·갱신이 항상 이 키로 들어온다.
 * - FK ON DELETE CASCADE: 커서는 멤버십의 파생 상태다 — USER_TEAMS와 같은 삭제 정책.
 * - 행이 없으면 앱이 0(아무것도 안 읽음)으로 간주한다.
 *
 * 선행: CreateTeamChatMessages (논리적 선후일 뿐 FK는 없다 — 커서는 숫자만 저장한다).
 */
export class CreateTeamChatReadCursors1791960323000 implements MigrationInterface {
  name = 'CreateTeamChatReadCursors1791960323000';

  private static readonly TABLE_COMMENT =
    '팀 채팅 읽음 커서. 팀·멤버당 1행, 마지막으로 읽은 메시지 ID(이 ID 이하는 모두 읽음)';

  private static readonly COLUMN_COMMENTS: Record<string, string> = {
    TEAM_ID: '팀 ID (PK, FK → TEAMS.TEAM_ID)',
    USER_ID: '사용자 ID (PK, FK → USERS.USER_ID)',
    LAST_READ_MESSAGE_ID: '마지막으로 읽은 TEAM_CHAT_MESSAGES.MESSAGE_ID. 증가만 한다(0 = 아무것도 안 읽음)',
    UPDATED_AT: '커서 마지막 갱신 시각 (UTC)',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TEAM_CHAT_READ_CURSORS';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE '
          CREATE TABLE "TEAM_CHAT_READ_CURSORS" (
            "TEAM_ID" NUMBER NOT NULL,
            "USER_ID" NUMBER NOT NULL,
            "LAST_READ_MESSAGE_ID" NUMBER DEFAULT 0 NOT NULL,
            "UPDATED_AT" TIMESTAMP (6) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT "PK_TEAM_CHAT_READ_CURSORS" PRIMARY KEY ("TEAM_ID", "USER_ID"),
            CONSTRAINT "FK_TEAM_CHAT_READ_CURSORS_TEAM" FOREIGN KEY ("TEAM_ID") REFERENCES "TEAMS" ("TEAM_ID") ON DELETE CASCADE,
            CONSTRAINT "FK_TEAM_CHAT_READ_CURSORS_USER" FOREIGN KEY ("USER_ID") REFERENCES "USERS" ("USER_ID") ON DELETE CASCADE
          )';
      END IF;
    END;`);

    const { TABLE_COMMENT, COLUMN_COMMENTS } = CreateTeamChatReadCursors1791960323000;
    await queryRunner.query(`COMMENT ON TABLE "TEAM_CHAT_READ_CURSORS" IS '${TABLE_COMMENT}'`);
    for (const [column, comment] of Object.entries(COLUMN_COMMENTS)) {
      await queryRunner.query(`COMMENT ON COLUMN "TEAM_CHAT_READ_CURSORS"."${column}" IS '${comment}'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = 'TEAM_CHAT_READ_CURSORS';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'DROP TABLE "TEAM_CHAT_READ_CURSORS" PURGE';
      END IF;
    END;`);
  }
}

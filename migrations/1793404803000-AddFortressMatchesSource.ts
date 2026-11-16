import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FORTRESS_MATCHES.SOURCE 추가 — 경기 출처 구분 (docs/tasks/fortress DECISIONS D-027)
 *
 * - 'online': 서버가 턴마다 판정한 온라인 대전(기존 행 전부). 'solo': 클라이언트가 올린 AI전·같은 기기 대전을 서버가 엔진으로 다시 돌려 검증한 기록
 * - VARCHAR2(6 BYTE) DEFAULT 'online' NOT NULL + CHECK — Oracle 12c+는 DEFAULT 있는 NOT NULL 추가를 메타데이터만 바꿔 처리한다(기존 행 갱신 없음)
 * - 최근 경기 목록은 'online'만 보여 준다(solo는 공유 링크로만). 결과·리플레이 조회는 둘 다
 * - ⚠️ 배포 게이트: Entity에 source가 있는 코드가 이 마이그레이션 전에 배포되면 FORTRESS_MATCHES 조회·저장이 ORA-00904로 실패한다 — 먼저 적용한다
 *
 * 멱등: 컬럼·제약이 이미 있으면 건너뛴다.
 */
export class AddFortressMatchesSource1793404803000 implements MigrationInterface {
  name = 'AddFortressMatchesSource1793404803000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'FORTRESS_MATCHES' AND column_name = 'SOURCE';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "FORTRESS_MATCHES" ADD ("SOURCE" VARCHAR2(6 BYTE) DEFAULT ''online'' NOT NULL)';
      END IF;

      SELECT COUNT(*) INTO v_cnt FROM user_constraints WHERE table_name = 'FORTRESS_MATCHES' AND constraint_name = 'FT_MATCHES_SOURCE_CK';
      IF v_cnt = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "FORTRESS_MATCHES" ADD CONSTRAINT "FT_MATCHES_SOURCE_CK" CHECK ("SOURCE" IN (''online'', ''solo''))';
      END IF;
    END;`);
    await queryRunner.query(
      `COMMENT ON COLUMN "FORTRESS_MATCHES"."SOURCE" IS '경기 출처. online 서버 판정 온라인 대전 · solo 클라이언트가 올린 AI전·같은 기기 대전(서버 재시뮬레이션 검증). 최근 목록은 online만'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 컬럼 DROP이 CHECK 제약도 함께 지운다. solo 행은 남지만 구분이 사라져 최근 목록에 섞인다 — 되돌리기 전에 solo 행을 숨기거나 지운다
    await queryRunner.query(`DECLARE
      v_cnt NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v_cnt FROM user_tab_columns WHERE table_name = 'FORTRESS_MATCHES' AND column_name = 'SOURCE';
      IF v_cnt > 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE "FORTRESS_MATCHES" DROP ("SOURCE")';
      END IF;
    END;`);
  }
}

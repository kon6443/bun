import { checkReadOnlySql, redactSensitiveColumns } from './sql-readonly.utils';

describe('checkReadOnlySql — pnpm db:select 1차 방어선 (LOCAL=PROD)', () => {
  it.each([
    ['단순 SELECT', 'SELECT * FROM TEAM_TAGS'],
    ['소문자·끝 세미콜론 1개', 'select tag_id from team_tags where team_id = 1;'],
    ['WITH 절', 'WITH t AS (SELECT * FROM TEAMS) SELECT COUNT(*) FROM t'],
    ['리터럴 안의 키워드', "SELECT * FROM TEAM_TASKS WHERE TASK_NAME = 'delete; drop table x'"],
    ['따옴표 식별자 안의 키워드', 'SELECT "UPDATE" FROM DUAL'],
    ['주석 안의 키워드', 'SELECT 1 FROM DUAL -- insert into x\n/* drop table y */'],
    ['Oracle 대체 인용', "SELECT q'[it's; delete]' FROM DUAL"],
    ['CRLF 줄바꿈과 줄 주석', 'SELECT 1 -- 주석\r\nFROM DUAL'],
    ['국가 문자셋 대체 인용 Nq', "SELECT Nq'[it's; delete]' FROM DUAL"],
    ['한글 리터럴', "SELECT * FROM TEAMS WHERE TEAM_NAME = '팀'"],
    ['키워드를 포함한 식별자(단어 경계)', 'SELECT UPDATED_AT, CREATED_BY, INTO_X FROM T'],
  ])('허용: %s', (_case, sql) => {
    expect(checkReadOnlySql(sql)).toMatchObject({ ok: true });
  });

  it('끝 세미콜론을 떼어 실행용 SQL을 돌려줘야 함 (oracledb는 세미콜론을 거부한다)', () => {
    expect(checkReadOnlySql('  SELECT 1 FROM DUAL ;  ')).toEqual({ ok: true, sql: 'SELECT 1 FROM DUAL' });
  });

  it.each([
    ['빈 문자열', '   '],
    ['UPDATE', 'UPDATE TEAM_TAGS SET TAG_NAME = TAG_NAME'],
    ['DELETE', 'delete from team_tags'],
    ['INSERT', 'INSERT INTO TEAM_TAGS VALUES (1)'],
    ['MERGE', 'MERGE INTO T USING S ON (1=1) WHEN MATCHED THEN UPDATE SET A=1'],
    ['DDL', 'DROP TABLE TEAM_TAGS'],
    ['TRUNCATE', 'TRUNCATE TABLE TEAM_TAGS'],
    ['다중 문장', 'SELECT 1 FROM DUAL; DELETE FROM TEAM_TAGS'],
    ['세미콜론 2개', 'SELECT 1 FROM DUAL;;'],
    ['FOR UPDATE 잠금', 'SELECT * FROM TEAM_TASKS FOR UPDATE'],
    ['WITH 안의 DML', 'WITH x AS (SELECT 1 FROM DUAL) DELETE FROM TEAM_TAGS'],
    ['WITH FUNCTION(PL/SQL)', 'WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; SELECT f FROM DUAL'],
    ['PL/SQL 블록', 'BEGIN NULL; END'],
    ['SELECT INTO', 'SELECT 1 INTO v FROM DUAL'],
    ['내장 패키지 호출', 'SELECT DBMS_LOCK.SLEEP(10) FROM DUAL'],
    ['UTL 패키지', 'SELECT UTL_HTTP.REQUEST(\'http://x\') FROM DUAL'],
    ['LOCK TABLE', 'LOCK TABLE TEAM_TAGS IN EXCLUSIVE MODE'],
    ['COMMIT', 'COMMIT'],
    ['닫히지 않은 따옴표로 세미콜론 숨기기', "SELECT 'a FROM DUAL; DELETE FROM T"],
    ['닫히지 않은 주석', 'SELECT 1 FROM DUAL /* ; DELETE FROM T'],
    ['리터럴 밖 비ASCII 위장 문자', 'SELECT 1 FROM DUAL; ＤＥＬＥＴＥ FROM T'],
    ['전각 공백 위장', 'SELECT　1 FROM DUAL'],
    ['Nq 인용으로 패키지 호출 숨기기', "SELECT Nq'[ ' ]' || DBMS_LOCK.SLEEP(5) FROM DUAL --'"],
    ['nq 인용으로 FOR UPDATE 숨기기', "SELECT nq'[ ' ]' FROM T FOR UPDATE --'"],
    ['CR 줄바꿈 뒤에 숨긴 패키지 호출', 'SELECT 1 FROM DUAL --x\r WHERE DBMS_LOCK.SLEEP(5) IS NULL'],
    ['CR 줄바꿈 뒤에 숨긴 FOR UPDATE', 'SELECT * FROM T --x\rFOR UPDATE'],
    ['CR 단독으로 따옴표 범위를 어긋나게 해 패키지 호출 숨기기', "SELECT 1 FROM DUAL --\r'\n WHERE DBMS_LOCK.SLEEP(10) IS NULL --'"],
    ['CR 단독으로 따옴표 범위를 어긋나게 해 FOR UPDATE 숨기기', "SELECT 1 FROM DUAL --\r'\n FOR UPDATE --'"],
    ['URIFACTORY 경유 외부 HTTP 요청', "SELECT SYS.URIFACTORY.GETURI('http://x').GETCLOB() FROM DUAL"],
    ['APEX 웹 서비스 호출', "SELECT APEX_WEB_SERVICE.MAKE_REST_REQUEST('http://x', 'GET') FROM DUAL"],
    ['줄 구분 문자(U+2028)로 주석 범위 흐리기', 'SELECT 1 FROM DUAL --x\u2028 FOR UPDATE'],
    ['URI 타입 외부 HTTP 요청', "SELECT HTTPURITYPE('http://x').GETCLOB() FROM DUAL"],
    ['따옴표 식별자로 쓴 패키지명', 'SELECT "DBMS_LOCK".SLEEP(5) FROM DUAL'],
    ['스키마 뒤 따옴표 패키지명', "SELECT SYS.\"UTL_HTTP\".REQUEST('http://x') FROM DUAL"],
    ['$ 식별자에 붙은 q 인용', "SELECT x$q'[ ' || DBMS_X.Y() || ' ]' FROM DUAL"],
    ['# 식별자에 붙은 q 인용', "SELECT x#q'[ ' || DBMS_X.Y() || ' ]' FROM DUAL"],
    ['숫자에 붙은 q 인용', "SELECT 1q'[ ' ]' || DBMS_X.Y() || 1q'[ ' ]' FROM DUAL"],
  ])('거부: %s', (_case, sql) => {
    expect(checkReadOnlySql(sql)).toMatchObject({ ok: false });
  });
});

describe('redactSensitiveColumns', () => {
  it('토큰·웹훅·비밀번호 컬럼 값은 가리고 나머지와 null은 그대로 둬야 함', () => {
    const rows = [
      { USER_ID: 1, KAKAO_REFRESH_TOKEN: 'abc', DISCORD_WEBHOOK_URL: 'https://x', USER_NAME: '홍', DB_PASSWORD: null },
    ];

    expect(redactSensitiveColumns(rows)).toEqual([
      { USER_ID: 1, KAKAO_REFRESH_TOKEN: '[REDACTED]', DISCORD_WEBHOOK_URL: '[REDACTED]', USER_NAME: '홍', DB_PASSWORD: null },
    ]);
  });
});

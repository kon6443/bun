import oracledb from 'oracledb';

/**
 * DB 차단 가드레일이 실제로 살아 있는지 검증한다.
 *
 * `test/setup/forbid-db.ts`를 `jest-e2e.json`의 `setupFiles`에 등록해 뒀지만,
 * 등록이 지워지거나 mock이 무력화되면 **조용히 상용 DB에 붙는 상태로 되돌아간다**.
 * 가드레일은 스스로를 검증하지 못하므로 여기서 한 번 확인한다.
 */
describe('E2E 가드레일 — 실제 DB 접속 차단', () => {
  it.each([
    ['getConnection', () => oracledb.getConnection({})],
    ['createPool', () => oracledb.createPool({})],
    ['initOracleClient', () => oracledb.initOracleClient({})],
  ])('oracledb.%s()는 차단돼야 함', (_name, call) => {
    // 이 테스트가 실패한다면 setupFiles 등록이 풀린 것이다 —
    // 그 상태로 AppModule을 import하는 E2E를 추가하면 상용 DB에 접속하게 된다
    expect(call).toThrow(/E2E 차단/);
  });
});

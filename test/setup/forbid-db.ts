/**
 * E2E가 실제 DB에 접속하는 것을 원천 차단하는 가드레일.
 *
 * 이 프로젝트는 **LOCAL/PROD가 같은 상용 Oracle**을 쓴다(CLAUDE.md의 DB 접속 금지 규칙).
 * 지금 E2E는 Repository를 mock으로 끊어 DB에 닿지 않지만, 나중에 누군가
 * `AppModule`을 그대로 import하는 E2E를 추가하면 `TypeOrmModule.forRootAsync`가
 * 부팅 중 커넥션 풀을 만들면서 **상용 DB에 붙는다**. 그때 조용히 성공하는 대신
 * 여기서 즉시 터지게 한다.
 *
 * 드라이버(oracledb) 레벨에서 막는 이유: TypeORM은 여러 경로로 연결을 시도할 수 있지만
 * 결국 전부 이 드라이버를 거친다. 가장 아래에서 한 번 막는 것이 확실하다.
 */
jest.mock('oracledb', () => {
  const refuse = (fnName: string) => () => {
    throw new Error(
      `[E2E 차단] oracledb.${fnName}() 호출이 감지됐다. ` +
        'LOCAL/PROD가 같은 상용 DB이므로 E2E는 실제 DB에 접속할 수 없다. ' +
        'AppModule을 직접 import하지 말고 test/helpers/e2e-app.ts의 createE2eApp()을 사용하거나, ' +
        'Repository를 createMockRepository()로 주입했는지 확인할 것.',
    );
  };

  const stub = {
    getConnection: refuse('getConnection'),
    createPool: refuse('createPool'),
    initOracleClient: refuse('initOracleClient'),
    // 상수는 참조만 해도 터지면 안 되므로 값으로 남긴다
    OUT_FORMAT_OBJECT: 4002,
    BIND_OUT: 3003,
  };

  return { ...stub, default: stub, __esModule: true };
});

export {};

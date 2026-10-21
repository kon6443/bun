/**
 * 읽기 전용 조회 — `pnpm db:select "<SQL>" [--max-rows=N] [--json]`
 *
 * LOCAL과 PROD가 같은 DB다. 쓰기를 2겹으로 막는다 (docs/tasks/claude-sessions-2026-10 D-003):
 *   1) checkReadOnlySql — 단일 SELECT·WITH만, 쓰기·DDL·잠금·PL/SQL·내장 패키지 거부
 *   2) autoCommit 없는 연결에서 SET TRANSACTION READ ONLY 후 실행, 끝나면 rollback
 *      → 가드를 우회한 DML도 ORA-01456으로 거부된다 (DDL은 트랜잭션 밖이라 1)이 막는다)
 * 행 상한·호출 타임아웃으로 운영 부하를 제한하고, 민감 컬럼 값은 가린다.
 * 이 파일 외의 스크립트로 DB를 여는 것은 여전히 금지다(CLAUDE.md Never).
 *
 * claude-db-guard: readonly-runner
 *   ↑ 글로벌 db-guard 훅의 "신뢰된 읽기 전용 러너" 마커 — 이 파일이 커밋본(HEAD)과 바이트가 같을 때만
 *     `tsx scripts/db-select.ts '<SQL>'` 단독 호출을 게이트 없이 통과시킨다. 고치면 커밋 전까지 다시 ask가 된다.
 *     단 이 HEAD 고정은 위 직접 호출에만 적용된다 — 실제 사용 경로 `pnpm db:select`는 훅 대상 밖이라,
 *     이 파일·가드 파일의 수정은 프로젝트 settings deny(Edit/Write)로 막는다 (D-014).
 */
import dotenv from 'dotenv';
import oracledb from 'oracledb';
import { checkReadOnlySql, redactSensitiveColumns } from '../src/common/utils/sql-readonly.utils';

const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 1000;
const CALL_TIMEOUT_MS = 30_000;

function parseArgs(argv: string[]): { sql: string; maxRows: number; json: boolean } {
  let maxRows = DEFAULT_MAX_ROWS;
  let json = false;
  const parts: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--max-rows=')) maxRows = Math.min(Math.max(Number(arg.split('=')[1]) || DEFAULT_MAX_ROWS, 1), HARD_MAX_ROWS);
    else if (arg === '--json') json = true;
    else parts.push(arg);
  }
  return { sql: parts.join(' '), maxRows, json };
}

async function main(): Promise<number> {
  const { sql, maxRows, json } = parseArgs(process.argv.slice(2));
  const check = checkReadOnlySql(sql);
  if (!check.ok) {
    console.error(`거부: ${check.reason}`);
    return 2;
  }

  dotenv.config();
  // Oracle thick client (wallet 접속) — migration-datasource.ts와 같은 조건
  if (process.env.ORACLE_LIB_DIR && process.env.ORACLE_WALLET_PATH) {
    oracledb.initOracleClient({ libDir: process.env.ORACLE_LIB_DIR, configDir: process.env.ORACLE_WALLET_PATH });
  }

  const connection = await oracledb.getConnection({
    user: process.env.ORACLE_DB_USER,
    password: process.env.ORACLE_DB_PW,
    connectString: process.env.ORACLE_DB_CONNECT_STR,
  });
  try {
    connection.callTimeout = CALL_TIMEOUT_MS;
    await connection.execute('SET TRANSACTION READ ONLY');
    const result = await connection.execute<Record<string, unknown>>(check.sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      maxRows: maxRows + 1, // 상한을 넘는지 알기 위해 1행 더 받는다
      autoCommit: false,
    });
    const rows = redactSensitiveColumns(result.rows ?? []);
    const truncated = rows.length > maxRows;
    const shown = rows.slice(0, maxRows);

    if (json) console.log(JSON.stringify(shown, null, 2));
    else if (shown.length) console.table(shown);
    console.error(`${shown.length}행${truncated ? ` (상한 ${maxRows}행에서 잘림 — --max-rows=N, 최대 ${HARD_MAX_ROWS})` : ''}`);
    return 0;
  } finally {
    await connection.rollback().catch(() => undefined);
    await connection.close();
  }
}

// process.exit()는 파이프로 이어진 stdout을 다 쓰기 전에 끊는다(큰 --json 결과가 64KB에서 잘림) — exitCode만 정하고 자연 종료한다
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);

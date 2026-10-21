/**
 * 읽기 전용 조회 도구(`pnpm db:select`)의 SQL 가드 · 민감 컬럼 가림.
 *
 * LOCAL과 PROD가 같은 DB라 이 가드가 1차 방어선이다(2차는 `SET TRANSACTION READ ONLY` — scripts/db-select.ts).
 * 근거: docs/tasks/claude-sessions-2026-10 D-003
 */

export type ReadOnlySqlCheck = { ok: true; sql: string } | { ok: false; reason: string };

/** 조회 외 동작(쓰기·DDL·트랜잭션 제어·PL/SQL·잠금)을 뜻하는 키워드 — 단어 단위로 거부한다 */
const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'RENAME',
  'COMMENT',
  'PURGE',
  'FLASHBACK',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'BEGIN',
  'DECLARE',
  'EXEC',
  'EXECUTE',
  'CALL',
  'LOCK',
  'INTO',
  'FUNCTION',
  'PROCEDURE',
];

/** 부수효과가 있을 수 있는 내장 패키지·타입 호출 (DBMS_*, UTL_*, URI 타입의 외부 HTTP 요청) */
// 거부 목록은 완전할 수 없다 — 근본 경계는 계정 권한·네트워크 ACL(D-014 후속: 읽기 전용 계정)
const FORBIDDEN_PACKAGE = /\b((DBMS|UTL)_\w+|\w*URITYPE|URIFACTORY|APEX_WEB_SERVICE)\b/i;

/** Oracle 따옴표 없는 식별자·숫자를 이루는 문자 (JS `\w`에 `$`·`#`을 더함) */
const IDENTIFIER_CHAR = /[\w$#]/;

/** i 위치의 q가 대체 인용의 시작인가 — 앞이 식별자 경계이거나, 식별자 경계 뒤의 국가 문자셋 접두 N(Nq'…') */
function startsAltQuote(sql: string, i: number): boolean {
  const prev = sql[i - 1] ?? '';
  if (!IDENTIFIER_CHAR.test(prev)) return true;
  return (prev === 'N' || prev === 'n') && !IDENTIFIER_CHAR.test(sql[i - 2] ?? '');
}

/**
 * 주석·문자열 리터럴·따옴표 식별자를 지운다 — 그 안의 단어(예: 'delete me')로 오탐하지 않고,
 * 반대로 그 안에 숨긴 세미콜론으로 다중 문장을 만들지 못하게 한다.
 */
function stripLiteralsAndComments(sql: string): string | null {
  const closing: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' };
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      // 줄 주석은 \n에서 끝난다 — CR 단독 줄바꿈은 checkReadOnlySql이 먼저 거부한다
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return null; // 닫히지 않은 주석
      i = end + 2;
      out += ' ';
    } else if ((ch === 'q' || ch === 'Q') && next === "'") {
      // Oracle 대체 인용 q'X…X'·Nq'X…X' — 여는 문자가 괄호류면 짝 괄호로 닫힌다.
      // 식별자·숫자에 붙은 q'는 Oracle과 따옴표 범위를 다르게 잡을 수 있어 거부한다(fail-closed)
      if (!startsAltQuote(sql, i)) return null;
      const open = sql[i + 2];
      if (open === undefined) return null;
      const end = sql.indexOf(`${closing[open] ?? open}'`, i + 3);
      if (end === -1) return null;
      i = end + 2;
      out += "''";
    } else if (ch === "'" || ch === '"') {
      // 문자열 리터럴·따옴표 식별자 — 같은 따옴표 2개는 이스케이프
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j += 1;
      }
      if (j >= sql.length) return null; // 닫히지 않은 따옴표
      // 따옴표 식별자로 쓴 패키지명("DBMS_LOCK".SLEEP)은 지우지 않고 남겨 패키지 검사에 걸리게 한다
      const quotedIdentifier = ch === '"' ? sql.slice(i + 1, j) : '';
      out += FORBIDDEN_PACKAGE.test(quotedIdentifier) ? ` ${quotedIdentifier.replace(/\W/g, '_')} ` : `${ch}${ch}`;
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** 단일 SELECT(또는 WITH … SELECT) 문장만 통과시킨다. 끝의 세미콜론 1개는 떼어 낸다 */
export function checkReadOnlySql(input: string): ReadOnlySqlCheck {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'SQL이 비어 있습니다.' };

  // CR 단독 줄바꿈은 줄 주석이 어디서 끝나는지 Oracle과 판단이 갈릴 수 있다 — 어느 쪽으로 어긋나도 우회가 되므로 거부한다(fail-closed)
  if (/\r(?!\n)|[\v\f\u0085\u2028\u2029]/.test(trimmed)) {
    return { ok: false, reason: '줄바꿈은 LF(\\n) 또는 CRLF만 허용됩니다.' };
  }

  const withoutTrailing = trimmed.replace(/;\s*$/, '').trimEnd();
  const scanned = stripLiteralsAndComments(withoutTrailing);
  if (scanned === null) return { ok: false, reason: "닫히지 않은 주석·따옴표가 있거나, 식별자·숫자에 붙은 q 인용(…q'…')이 있습니다." };

  if (scanned.includes(';')) return { ok: false, reason: '문장은 하나만 실행할 수 있습니다.' };
  // 리터럴·식별자·주석을 지운 나머지는 ASCII여야 한다 — 키워드를 유사 문자로 위장하는 것을 막는다
  if (/[^\t\n\r\x20-\x7E]/.test(scanned)) return { ok: false, reason: '허용되지 않는 문자가 있습니다.' };

  const head = scanned.trim().split(/\s+/)[0]?.toUpperCase();
  if (head !== 'SELECT' && head !== 'WITH') {
    return { ok: false, reason: 'SELECT 또는 WITH로 시작하는 조회만 실행할 수 있습니다.' };
  }

  const forbidden = FORBIDDEN_KEYWORDS.find((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(scanned));
  if (forbidden) return { ok: false, reason: `조회 외 동작 키워드(${forbidden})는 허용되지 않습니다.` };

  const pkg = FORBIDDEN_PACKAGE.exec(scanned);
  if (pkg) return { ok: false, reason: `내장 패키지 호출(${pkg[0]})은 허용되지 않습니다.` };

  return { ok: true, sql: withoutTrailing };
}

/** 값을 가릴 컬럼명 패턴 — 토큰·비밀·웹훅 URL(보유자는 누구나 채널에 게시 가능)·wallet */
const SENSITIVE_COLUMN = /TOKEN|SECRET|PASSWORD|PASSWD|WEBHOOK|WALLET|CREDENTIAL/i;

export function redactSensitiveColumns(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([column, value]) => [
        column,
        SENSITIVE_COLUMN.test(column) && value !== null && value !== undefined ? '[REDACTED]' : value,
      ]),
    ),
  );
}

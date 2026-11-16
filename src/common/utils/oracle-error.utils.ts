import { QueryFailedError } from 'typeorm';

/**
 * Oracle 드라이버 에러 판정 — 메시지 문자열이 아니라 oracledb의 errorNum으로 판정한다(메시지는 NLS 설정·드라이버 버전에 따라 바뀐다).
 * 모듈마다 같은 판정을 따로 두던 것을 모았다.
 */

/** QueryFailedError의 Oracle 에러 번호. QueryFailedError가 아니거나 번호가 없으면 undefined */
export function oraErrorNum(error: unknown): number | undefined {
  if (!(error instanceof QueryFailedError)) return undefined;
  return (error.driverError as { errorNum?: number } | undefined)?.errorNum;
}

/** ORA-00001 유니크(PK) 제약 위반 — 다른 요청이 같은 키를 먼저 넣었다 */
export function isUniqueViolation(error: unknown): boolean {
  return oraErrorNum(error) === 1;
}

/** ORA-02291 참조 무결성 위반 — 부모 키(예: 그 사이 탈퇴한 USER_ID)가 없다 */
export function isForeignKeyViolation(error: unknown): boolean {
  return oraErrorNum(error) === 2291;
}

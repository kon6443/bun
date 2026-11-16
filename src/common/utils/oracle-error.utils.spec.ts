import { QueryFailedError } from 'typeorm';
import { isForeignKeyViolation, isUniqueViolation, oraErrorNum } from './oracle-error.utils';

const oraError = (errorNum: number) => new QueryFailedError('q', [], Object.assign(new Error(`ORA-${errorNum}`), { errorNum }));

describe('oracle-error.utils', () => {
  it('QueryFailedError의 driverError.errorNum으로 판정한다', () => {
    expect(oraErrorNum(oraError(1))).toBe(1);
    expect(isUniqueViolation(oraError(1))).toBe(true);
    expect(isUniqueViolation(oraError(2291))).toBe(false);
    expect(isForeignKeyViolation(oraError(2291))).toBe(true);
    expect(isForeignKeyViolation(oraError(1))).toBe(false);
  });

  it('메시지에 ORA 번호가 있어도 errorNum이 없거나 QueryFailedError가 아니면 아니다', () => {
    expect(oraErrorNum(new QueryFailedError('q', [], new Error('ORA-00001: unique constraint violated')))).toBeUndefined();
    expect(isUniqueViolation(new Error('ORA-00001'))).toBe(false);
    expect(isForeignKeyViolation(undefined)).toBe(false);
  });
});

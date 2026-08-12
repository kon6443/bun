import { toErrorDetail } from './error.utils';

describe('toErrorDetail', () => {
  it('Error면 stack을 반환해야 함', () => {
    const err = new Error('connection lost');

    const result = toErrorDetail(err);

    expect(result).toBe(err.stack);
    expect(result).toContain('connection lost');
  });

  it('stack이 없는 Error면 undefined를 반환해야 함', () => {
    const err = new Error('no stack');
    err.stack = undefined;

    expect(toErrorDetail(err)).toBeUndefined();
  });

  it('객체 예외는 JSON으로 직렬화해야 함 — [object Object]로 뭉개지 않는다', () => {
    const result = toErrorDetail({ code: 'ORA-01722', table: 'USERS' });

    expect(result).toBe('{"code":"ORA-01722","table":"USERS"}');
    expect(result).not.toBe('[object Object]');
  });

  it('순환 참조 객체는 throw하지 않고 폴백해야 함 — catch 안에서 다시 던지면 예외를 삼키려던 목적이 깨진다', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(() => toErrorDetail(circular)).not.toThrow();
    expect(toErrorDetail(circular)).toBe('[object Object]');
  });

  it.each([
    ['문자열', 'plain failure', 'plain failure'],
    ['숫자', 500, '500'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
  ])('원시값 %s는 문자열로 변환해야 함', (_desc, input, expected) => {
    expect(toErrorDetail(input)).toBe(expected);
  });
});

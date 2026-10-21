import { MaxLength, validateSync } from 'class-validator';
import { MaxByteLength } from './max-byte-length.decorator';

class Target {
  @MaxLength(100)
  @MaxByteLength(400)
  value: unknown;
}

class ByteOnlyTarget {
  @MaxByteLength(400)
  value: unknown;
}

const errorsFor = (value: unknown, Cls: new () => { value: unknown } = Target) => {
  const target = new Cls();
  target.value = value;
  return validateSync(target);
};

/**
 * `@MaxLength`가 통과시키는 바이트 초과 입력을 `@MaxByteLength`가 막는지 고정한다.
 * 이 데코레이터를 빼면 '❤️' 100자 케이스는 MaxLength만으로 통과해 DB에서 ORA-12899(500)가 난다.
 */
describe('MaxByteLength', () => {
  it.each([
    ['한글 100자 (300바이트)', '가'.repeat(100)],
    ['4바이트 이모지 100자 (400바이트, 경계)', '😀'.repeat(100)],
  ])('%s는 통과해야 함', (_name, value) => {
    expect(errorsFor(value)).toHaveLength(0);
  });

  it("'❤️' 100자 — MaxLength는 100자로 세어 통과시키지만 600바이트라 maxByteLength만 거부해야 함", () => {
    const [error] = errorsFor('❤️'.repeat(100));

    expect(error.constraints).toEqual({ maxByteLength: 'value는 400바이트 이하여야 합니다.' });
  });

  it('401바이트 ASCII는 거부해야 함 (경계)', () => {
    expect(errorsFor('a'.repeat(401), ByteOnlyTarget)[0].constraints).toEqual({
      maxByteLength: 'value는 400바이트 이하여야 합니다.',
    });
  });

  it('문자열이 아니면 판단하지 않아야 함 (타입 검증은 @IsString 책임)', () => {
    expect(errorsFor(123, ByteOnlyTarget)).toHaveLength(0);
  });
});

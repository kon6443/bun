import { buildMessage, ValidateBy, ValidationOptions } from 'class-validator';

/**
 * UTF-8 바이트 길이 상한 검증 — `VARCHAR2(n BYTE)` 컬럼의 최종 방어선.
 *
 * `@MaxLength`(validator `isLength`)는 서로게이트 쌍과 이체 선택자(U+FE0F·U+FE0E)를 글자 수에서 빼므로
 * 글자 수 제한만으로는 바이트 상한을 보장하지 못한다 (예: '❤️' 100자 = 600바이트 → ORA-12899로 500).
 * 글자 수 제한(`@MaxLength`)과 함께 붙인다. 문자열이 아니면 통과시킨다 — 타입은 `@IsString`이 본다.
 */
export const MaxByteLength = (max: number, validationOptions?: ValidationOptions): PropertyDecorator =>
  ValidateBy(
    {
      name: 'maxByteLength',
      constraints: [max],
      validator: {
        validate: (value: unknown): boolean => typeof value !== 'string' || Buffer.byteLength(value, 'utf8') <= max,
        defaultMessage: buildMessage((eachPrefix) => `${eachPrefix}$property는 ${max}바이트 이하여야 합니다.`, validationOptions),
      },
    },
    validationOptions,
  );

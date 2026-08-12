/**
 * catch 절에서 받은 `unknown` 예외를 로거의 stack 인자로 넘길 문자열로 변환한다.
 *
 * `catch (e: any)`를 쓰지 않으려면 매번 타입 좁히기가 필요한데, 그 분기를 한 곳에 모은다.
 * `String(err)`만 쓰면 객체 예외가 `[object Object]`가 되어 디버깅 정보를 잃으므로
 * 객체는 JSON으로 직렬화한다. 순환 참조가 있으면 `JSON.stringify`가 throw하는데,
 * catch 블록 안에서 다시 던지면 예외를 삼키려던 목적이 깨지므로 반드시 폴백한다.
 */
export function toErrorDetail(err: unknown): string | undefined {
  if (err instanceof Error) return err.stack;
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

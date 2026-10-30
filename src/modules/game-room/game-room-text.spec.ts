import { chatTextAllowed, checkRoomName, containsDisallowedChars } from './game-room-text';

describe('game-room-text', () => {
  it('containsDisallowedChars: 제어·bidi는 막고 이모지 구성 문자(ZWJ·변형 선택자)는 허용', () => {
    expect(containsDisallowedChars('a\nb')).toBe(true);
    expect(containsDisallowedChars('abc‮def')).toBe(true);
    expect(containsDisallowedChars('⁦x')).toBe(true);
    expect(containsDisallowedChars('👩‍💻 ❤️ 안녕!')).toBe(false);
  });

  // 금지 bidi 범위 전체를 고정 — 눈에 안 보이는 문자라 목록에서 빠져도 diff로 알아채기 어렵다
  it.each([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c])(
    'containsDisallowedChars: bidi 제어 U+%s는 막는다',
    (codePoint) => {
      expect(containsDisallowedChars(`a${String.fromCodePoint(codePoint)}b`)).toBe(true);
    },
  );

  describe('checkRoomName', () => {
    it.each([
      ['', 'INVALID'],
      ['가'.repeat(21), 'INVALID'],
      ['방‮이름', 'INVALID'],
      ['씨발 방', 'FORBIDDEN'],
      ['가'.repeat(20), null],
      ['👩‍💻 코딩방!', null],
    ])('%j → %s', (name, expected) => {
      expect(checkRoomName(name, 20)).toBe(expected);
    });

    it('길이는 UTF-16 단위가 아니라 코드 포인트 단위', () => {
      expect(checkRoomName('😀'.repeat(20), 20)).toBeNull();
      expect(checkRoomName('😀'.repeat(21), 20)).toBe('INVALID');
    });
  });

  it('chatTextAllowed: 금지 문자·금칙어면 false', () => {
    expect(chatTextAllowed('좋은 경기!')).toBe(true);
    expect(chatTextAllowed('줄\n바꿈')).toBe(false);
    expect(chatTextAllowed('s h i t')).toBe(false);
  });
});

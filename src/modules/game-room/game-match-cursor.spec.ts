import { decodeGameMatchCursor, encodeGameMatchCursor } from './game-match-cursor';

const ID = /^[A-Za-z0-9_-]{16}$/;
const NOW = 1_800_000_000_000;

describe('game-match-cursor', () => {
  it('왕복 — 인코딩한 커서를 그대로 되돌린다', () => {
    const c = { t: NOW - 1, id: 'AAAAAAAAAAAAAAAA' };
    expect(decodeGameMatchCursor(encodeGameMatchCursor(c), ID, NOW)).toEqual(c);
  });

  it.each([
    ['base64 아님', '!!!'],
    ['id가 게임 형식과 다름', encodeGameMatchCursor({ t: 1, id: 'short' })],
    ['음수 시각', encodeGameMatchCursor({ t: -1, id: 'AAAAAAAAAAAAAAAA' })],
    ['미래 1일 초과', encodeGameMatchCursor({ t: NOW + 24 * 60 * 60 * 1000 + 1, id: 'AAAAAAAAAAAAAAAA' })],
    ['정수 아님', encodeGameMatchCursor({ t: 1.5, id: 'AAAAAAAAAAAAAAAA' })],
  ])('%s → null', (_label, raw) => {
    expect(decodeGameMatchCursor(raw, ID, NOW)).toBeNull();
  });
});

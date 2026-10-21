import { checkPlayerName, containsForbiddenWord } from './player-name-policy';

/** 금칙어 판정 (D-003) — 공백·숫자·특수문자 끼워 넣기, 대소문자 우회를 막는지 고정한다 */
describe('containsForbiddenWord', () => {
  it.each(['테트리스왕', 'Tetris King', '김철수_01', '블록-마스터'])('정상 이름 "%s"는 통과해야 함', (name) => {
    expect(containsForbiddenWord(name)).toBe(false);
  });

  it.each([
    ['그대로', '시발'],
    ['공백 끼워 넣기', '시 발'],
    ['숫자 끼워 넣기', '시1발'],
    ['특수문자 끼워 넣기', '병_신'],
    ['영문 대소문자', 'FuCk'],
    ['운영자 사칭', '공식운영자'],
    ['영문 사칭', 'Admin-1'],
  ])('%s(%s)는 거부해야 함', (_name, value) => {
    expect(containsForbiddenWord(value)).toBe(true);
  });
});

/** 이름 형식 판정 (DESIGN §3) — 이름 전용 에러 코드(GAME_PLAYER_NAME_INVALID·FORBIDDEN)의 근거 */
describe('checkPlayerName', () => {
  it.each(['가', '테트리스왕', 'a'.repeat(12), '가'.repeat(12), 'Tetris Kin_1'])('"%s"는 통과(null)', (name) => {
    expect(checkPlayerName(name)).toBeNull();
  });

  it.each([
    ['빈 값', ''],
    ['13자', 'a'.repeat(13)],
    ['허용 외 문자(꺾쇠)', '<script>'],
    ['허용 외 문자(이모지)', '왕👑'],
    ['자모만', 'ㅋㅋㅋ'],
  ])('%s → INVALID', (_name, value) => {
    expect(checkPlayerName(value)).toBe('INVALID');
  });

  it('형식은 맞지만 금칙어면 FORBIDDEN', () => {
    expect(checkPlayerName('시1발')).toBe('FORBIDDEN');
  });
});

import { isLeaderReplica } from './replica.utils';

describe('isLeaderReplica', () => {
  it.each([
    ['문자열 1', '1', true],
    ['숫자 1', 1, true],
    ['공백 포함', ' 1 ', true],
    ['2', '2', false],
    ['0', '0', false],
    ['미설정', undefined, false],
    ['빈 값', '', false],
    ['숫자 아님', 'abc', false],
  ])('%s → %s', (_desc, value, expected) => {
    expect(isLeaderReplica(value)).toBe(expected);
  });
});

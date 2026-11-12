import { generateRandomNickname, getDisplayName, getTeamDisplayName } from './user.utils';

describe('user.utils', () => {
  describe('getTeamDisplayName — 팀 닉네임 → 계정 닉네임 → 사용자{id}', () => {
    it.each([
      ['팀 닉네임이 있으면 팀 닉네임', '팀닉', '계정닉', '팀닉'],
      ['팀 닉네임이 없으면 계정 닉네임', null, '계정닉', '계정닉'],
      ['빈 팀 닉네임은 미설정으로 본다', '', '계정닉', '계정닉'],
      ['둘 다 없으면 기본 표시명', null, null, '사용자7'],
    ])('%s', (_desc, teamNickname, userName, expected) => {
      expect(getTeamDisplayName(teamNickname, userName, 7)).toBe(expected);
    });

    it('계정 닉네임 폴백은 getDisplayName과 같다', () => {
      expect(getTeamDisplayName(undefined, undefined, 3)).toBe(getDisplayName(null, 3));
    });
  });

  describe('generateRandomNickname', () => {
    it('형용사+동물(한글) + 4자리 숫자이고 계정 닉네임 상한 20자 이내다', () => {
      for (let i = 0; i < 200; i++) {
        const nickname = generateRandomNickname();
        expect(nickname).toMatch(/^[가-힣]+\d{4}$/);
        expect(nickname.length).toBeLessThanOrEqual(20);
      }
    });
  });
});

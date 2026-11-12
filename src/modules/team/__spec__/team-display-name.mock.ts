import { TeamDisplayNameService } from '../team-display-name.service';

export type MockTeamDisplayNameService = jest.Mocked<Pick<TeamDisplayNameService, 'getDisplayNames' | 'getDisplayName'>>;

/**
 * TeamDisplayNameService mock — 실제 해석(팀 닉네임 → 계정 닉네임)은 team-display-name.service.spec.ts가 검증한다.
 * 여기서는 `names`(userId → 표시 이름)를 돌려주고, 없는 userId는 "사용자{id}"로 채운다.
 */
export const createMockTeamDisplayNameService = (
  names: Record<number, string> = {},
): MockTeamDisplayNameService => {
  const resolve = (userId: number) => names[userId] ?? `사용자${userId}`;
  return {
    getDisplayNames: jest.fn(async (_teamId: number, userIds: readonly number[]) => {
      return new Map(userIds.map((userId) => [userId, resolve(userId)]));
    }),
    getDisplayName: jest.fn(async (_teamId: number, userId: number) => resolve(userId)),
  };
};

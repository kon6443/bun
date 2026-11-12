import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TeamDisplayNameService } from './team-display-name.service';
import { User } from '../../entities/User';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';

/**
 * 팀 안 표시 이름 해석 — 팀 닉네임 → 계정 닉네임 → "사용자{id}" (docs/tasks/team-nickname D-001)
 *
 * 고정하는 것:
 *  1. 팀 닉네임은 **이 팀의** USER_TEAMS 행에서만 가져온다(조인 조건에 teamId) — 다른 팀 닉네임이 새지 않는다
 *  2. 해석 순서와 폴백
 *  3. 요청한 userId는 조회 결과가 없어도 빠짐없이 채운다(탈퇴 등)
 */
describe('TeamDisplayNameService', () => {
  let service: TeamDisplayNameService;
  let userRepository: MockRepository<User>;

  beforeEach(async () => {
    userRepository = createMockRepository<User>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [TeamDisplayNameService, { provide: getRepositoryToken(User), useValue: userRepository }],
    }).compile();
    service = module.get(TeamDisplayNameService);
  });

  const mockRows = (rows: Array<{ userId: number | string; userName: string | null; teamNickname: string | null }>) => {
    const qb = createMockQueryBuilder({ getRawMany: rows });
    userRepository.createQueryBuilder.mockReturnValue(qb as never);
    return qb;
  };

  it('팀 닉네임은 이 팀의 멤버십 행에서만 조인해야 함', async () => {
    const qb = mockRows([]);

    await service.getDisplayNames(7, [1]);

    expect(qb.leftJoin).toHaveBeenCalledWith('u.teamMembers', 'tm', 'tm.teamId = :teamId', { teamId: 7 });
    expect(qb.where).toHaveBeenCalledWith('u.userId IN (:...userIds)', { userIds: [1] });
  });

  it('팀 닉네임 → 계정 닉네임 → 기본 표시명 순으로 해석해야 함', async () => {
    mockRows([
      { userId: '1', userName: '계정A', teamNickname: '팀A' },
      { userId: '2', userName: '계정B', teamNickname: null },
      { userId: '3', userName: null, teamNickname: null },
    ]);

    const names = await service.getDisplayNames(7, [1, 2, 3]);

    expect([...names]).toEqual([
      [1, '팀A'],
      [2, '계정B'],
      [3, '사용자3'],
    ]);
  });

  it('조회되지 않은 userId도 기본 표시명으로 채우고, 중복 id는 한 번만 조회해야 함', async () => {
    const qb = mockRows([]);

    const names = await service.getDisplayNames(7, [5, 5]);

    expect(qb.where).toHaveBeenCalledWith('u.userId IN (:...userIds)', { userIds: [5] });
    expect(names.get(5)).toBe('사용자5');
  });

  it('빈 목록이면 쿼리하지 않아야 함 (IN () 구문 오류 방지)', async () => {
    const names = await service.getDisplayNames(7, []);

    expect(names.size).toBe(0);
    expect(userRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('getDisplayName은 한 명의 표시 이름을 돌려줘야 함', async () => {
    mockRows([{ userId: 1, userName: '계정A', teamNickname: '팀A' }]);

    await expect(service.getDisplayName(7, 1)).resolves.toBe('팀A');
  });
});

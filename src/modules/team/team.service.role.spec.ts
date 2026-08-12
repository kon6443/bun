import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TeamService } from './team.service';
import { Team } from '../../entities/Team';
import { TeamMember } from '../../entities/TeamMember';
import { TeamTask } from '../../entities/TeamTask';
import { TaskComment } from '../../entities/TaskComment';
import { TeamInvitation } from '../../entities/TeamInvitation';
import { User } from '../../entities/User';
import { NOTIFICATION_PORT } from '../../common/port/notification.port';
import { createUser, createTeamMemberView } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import {
  TeamForbiddenErrorResponseDto,
  TeamSelfRoleChangeErrorResponseDto,
  TeamRoleChangeForbiddenErrorResponseDto,
  TeamMemberNotFoundErrorResponseDto,
  TeamInvalidRoleErrorResponseDto,
} from './team-error.dto';

/**
 * 역할 변경은 권한 정책(role.constants)이 실제로 적용되는 지점이다.
 * 정책 함수 자체는 role.constants.spec.ts에서 27조합 전수 검증했으므로,
 * 여기서는 **서비스가 그 정책을 올바른 인자로 호출하고 결과에 따라 분기하는지**를 본다.
 */
describe('TeamService — 역할 변경', () => {
  let service: TeamService;
  let teamMemberRepository: MockRepository<TeamMember>;
  let userRepository: MockRepository<User>;
  let notificationPort: { notifyTeam: jest.Mock };

  beforeEach(async () => {
    teamMemberRepository = createMockRepository<TeamMember>();
    userRepository = createMockRepository<User>();
    notificationPort = { notifyTeam: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamService,
        {
          provide: getDataSourceToken(),
          useValue: { transaction: jest.fn() } as unknown as DataSource,
        },
        { provide: getRepositoryToken(Team), useValue: createMockRepository<Team>() },
        { provide: getRepositoryToken(TeamMember), useValue: teamMemberRepository },
        { provide: getRepositoryToken(TeamTask), useValue: createMockRepository<TeamTask>() },
        { provide: getRepositoryToken(TaskComment), useValue: createMockRepository<TaskComment>() },
        {
          provide: getRepositoryToken(TeamInvitation),
          useValue: createMockRepository<TeamInvitation>(),
        },
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: NOTIFICATION_PORT, useValue: notificationPort },
      ],
    }).compile();

    service = module.get(TeamService);
  });

  afterEach(() => jest.restoreAllMocks());

  /**
   * getTeamMembersBy는 actor·target 조회에 각각 한 번씩 호출된다.
   * userIds로 어느 쪽 조회인지 구분해 역할을 돌려준다.
   */
  const mockMembers = (
    actor: { userId: number; role: string } | null,
    target: { userId: number; role: string } | null,
  ) =>
    jest.spyOn(service, 'getTeamMembersBy').mockImplementation(async ({ userIds }) => {
      const id = userIds?.[0];
      const match = [actor, target].find((m) => m && m.userId === id);
      return match ? [createTeamMemberView({ userId: match.userId, role: match.role })] : [];
    });

  const changeRole = (newRole: 'MANAGER' | 'MEMBER' = 'MANAGER') =>
    service.updateMemberRole({ teamId: 1, actorUserId: 1, targetUserId: 2, newRole });

  describe('사전 차단', () => {
    it('본인의 역할은 변경할 수 없어야 함', async () => {
      const spy = mockMembers({ userId: 1, role: 'MASTER' }, null);

      await expect(
        service.updateMemberRole({
          teamId: 1,
          actorUserId: 1,
          targetUserId: 1,
          newRole: 'MEMBER',
        }),
      ).rejects.toThrow(TeamSelfRoleChangeErrorResponseDto);
      // 조회 전에 차단되어야 한다 (불필요한 쿼리 방지 + 의도 명확화)
      expect(spy).not.toHaveBeenCalled();
    });

    it('요청자가 팀 멤버가 아니면 차단해야 함', async () => {
      mockMembers(null, { userId: 2, role: 'MEMBER' });

      await expect(changeRole()).rejects.toThrow(TeamForbiddenErrorResponseDto);
    });

    it('요청자가 MEMBER면 관리 권한 없음으로 차단해야 함', async () => {
      mockMembers({ userId: 1, role: 'MEMBER' }, { userId: 2, role: 'MEMBER' });

      await expect(changeRole()).rejects.toThrow(TeamRoleChangeForbiddenErrorResponseDto);
      expect(teamMemberRepository.update).not.toHaveBeenCalled();
    });

    it('대상이 팀 멤버가 아니면 차단해야 함', async () => {
      mockMembers({ userId: 1, role: 'MASTER' }, null);

      await expect(changeRole()).rejects.toThrow(TeamMemberNotFoundErrorResponseDto);
    });

    it('요청자 역할은 대소문자 무관하게 인식해야 함 (DB에 소문자가 있어도)', async () => {
      mockMembers({ userId: 1, role: 'master' }, { userId: 2, role: 'member' });
      userRepository.findOne.mockResolvedValue(createUser());

      await expect(changeRole('MANAGER')).resolves.toHaveProperty('newRole', 'MANAGER');
    });
  });

  describe('권한 정책 적용', () => {
    it.each([
      // [요청자, 대상 현재, 변경할 역할, 허용 여부]
      ['MASTER', 'MEMBER', 'MANAGER', true],
      ['MASTER', 'MANAGER', 'MEMBER', true],
      ['MANAGER', 'MEMBER', 'MANAGER', true],
      // MANAGER는 강등 불가
      ['MANAGER', 'MANAGER', 'MEMBER', false],
      // MASTER는 대상이 될 수 없다 (팀당 1명 보장)
      ['MASTER', 'MASTER', 'MEMBER', false],
      ['MANAGER', 'MASTER', 'MEMBER', false],
    ] as [string, string, 'MANAGER' | 'MEMBER', boolean][])(
      '%s가 %s를 %s로: 허용=%s',
      async (actorRole, targetRole, newRole, allowed) => {
        mockMembers({ userId: 1, role: actorRole }, { userId: 2, role: targetRole });
        userRepository.findOne.mockResolvedValue(createUser());

        const promise = changeRole(newRole);

        if (allowed) {
          await expect(promise).resolves.toHaveProperty('newRole', newRole);
          expect(teamMemberRepository.update).toHaveBeenCalled();
        } else {
          await expect(promise).rejects.toThrow(TeamRoleChangeForbiddenErrorResponseDto);
          expect(teamMemberRepository.update).not.toHaveBeenCalled();
        }
      },
    );

    it('현재와 같은 역할로는 변경할 수 없어야 함', async () => {
      mockMembers({ userId: 1, role: 'MASTER' }, { userId: 2, role: 'MANAGER' });

      await expect(changeRole('MANAGER')).rejects.toThrow(TeamInvalidRoleErrorResponseDto);
      expect(teamMemberRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('변경 성공 시', () => {
    beforeEach(() => {
      mockMembers({ userId: 1, role: 'MASTER' }, { userId: 2, role: 'MEMBER' });
    });

    it('대상 멤버만 지정해 역할을 갱신해야 함', async () => {
      userRepository.findOne.mockResolvedValue(createUser({ userName: '대상자' }));

      await changeRole('MANAGER');

      expect(teamMemberRepository.update).toHaveBeenCalledWith(
        { teamId: 1, userId: 2 },
        { role: 'MANAGER' },
      );
    });

    it('이전 역할과 새 역할을 함께 반환해야 함', async () => {
      userRepository.findOne.mockResolvedValue(createUser({ userName: '대상자' }));

      const result = await changeRole('MANAGER');

      expect(result).toEqual({
        teamId: 1,
        userId: 2,
        userName: '대상자',
        previousRole: 'MEMBER',
        newRole: 'MANAGER',
        teamName: '테스트팀',
      });
    });

    it('대상 사용자 조회 시 userName만 select해야 함 (민감정보 미조회)', async () => {
      userRepository.findOne.mockResolvedValue(createUser());

      await changeRole('MANAGER');

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { userId: 2 },
        select: ['userName'],
      });
    });

    it('userName이 없으면 null로 반환해야 함', async () => {
      userRepository.findOne.mockResolvedValue(createUser({ userName: null }));

      const result = await changeRole('MANAGER');

      expect(result.userName).toBeNull();
    });

    it('팀에 역할 변경 알림을 보내야 함', async () => {
      userRepository.findOne.mockResolvedValue(createUser({ userName: '대상자' }));

      await changeRole('MANAGER');

      expect(notificationPort.notifyTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          team: expect.objectContaining({ teamId: 1, teamName: '테스트팀' }),
          message: expect.stringContaining('멤버 → 매니저'),
        }),
      );
    });

    it('대상 사용자를 못 찾아도 알림은 userId로 대체 표기해야 함', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await changeRole('MANAGER');

      expect(notificationPort.notifyTeam).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('사용자 2') }),
      );
    });
  });
});

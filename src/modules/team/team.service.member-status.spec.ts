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
import { ActStatus } from '../../common/enums/task-status.enum';
import { createUser, createTeamMemberView } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import {
  TeamForbiddenErrorResponseDto,
  TeamSelfStatusChangeErrorResponseDto,
  TeamMasterStatusChangeErrorResponseDto,
  TeamMemberStatusChangeForbiddenErrorResponseDto,
  TeamMemberNotFoundErrorResponseDto,
  TeamInvalidRoleErrorResponseDto,
} from './team-error.dto';

const ACTOR_ID = 1;
const TARGET_ID = 2;

/**
 * 멤버 활성/비활성 전환(강제 탈퇴·복구)을 검증한다.
 *
 * 역할 변경(`team.service.role.spec.ts`)과 **같은 권한 정책**(hasManagementPermission·canManageRole)을
 * 쓰지만 결정적 차이가 하나 있다: 대상 조회 시 **`userActStatus` 필터를 걸지 않는다**.
 * 비활성 멤버를 찾을 수 있어야 재활성화가 가능하기 때문이며, 이 필터가 실수로 추가되면
 * "한 번 비활성화된 멤버는 영원히 되살릴 수 없는" 상태가 된다.
 */
describe('TeamService — 멤버 상태 변경', () => {
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
    userRepository.findOne.mockResolvedValue(createUser({ userName: '김대상' }));
  });

  afterEach(() => jest.restoreAllMocks());

  /**
   * getTeamMembersBy는 actor·target 조회에 각각 한 번씩 호출된다.
   * userIds로 어느 쪽 조회인지 구분해 응답을 돌려준다.
   */
  const mockMembers = (
    actor: { role: string } | null,
    target: { role: string; userActStatus?: number } | null,
  ) =>
    jest.spyOn(service, 'getTeamMembersBy').mockImplementation(async ({ userIds }) => {
      if (userIds?.[0] === ACTOR_ID) {
        return actor ? [createTeamMemberView({ userId: ACTOR_ID, role: actor.role })] : [];
      }
      return target
        ? [
            createTeamMemberView({
              userId: TARGET_ID,
              role: target.role,
              userActStatus: target.userActStatus ?? ActStatus.ACTIVE,
            }),
          ]
        : [];
    });

  const changeStatus = (newStatus: ActStatus = ActStatus.INACTIVE, targetUserId = TARGET_ID) =>
    service.updateMemberStatus({
      teamId: 1,
      actorUserId: ACTOR_ID,
      targetUserId,
      newStatus,
    });

  describe('사전 차단', () => {
    it('본인의 상태는 변경할 수 없어야 함', async () => {
      const spy = mockMembers({ role: 'MASTER' }, null);

      await expect(changeStatus(ActStatus.INACTIVE, ACTOR_ID)).rejects.toThrow(
        TeamSelfStatusChangeErrorResponseDto,
      );
      // 조회 전에 차단되어야 한다 — MASTER가 스스로를 비활성화하면 팀에 관리자가 사라진다
      expect(spy).not.toHaveBeenCalled();
    });

    it('요청자가 팀 멤버가 아니면 차단해야 함', async () => {
      mockMembers(null, { role: 'MEMBER' });

      await expect(changeStatus()).rejects.toThrow(TeamForbiddenErrorResponseDto);
      expect(teamMemberRepository.update).not.toHaveBeenCalled();
    });

    it('요청자가 MEMBER면 관리 권한 없음으로 차단해야 함', async () => {
      mockMembers({ role: 'MEMBER' }, { role: 'MEMBER' });

      await expect(changeStatus()).rejects.toThrow(
        TeamMemberStatusChangeForbiddenErrorResponseDto,
      );
      expect(teamMemberRepository.update).not.toHaveBeenCalled();
    });

    it('대상이 팀 멤버가 아니면 NOT_FOUND를 던져야 함', async () => {
      mockMembers({ role: 'MASTER' }, null);

      await expect(changeStatus()).rejects.toThrow(TeamMemberNotFoundErrorResponseDto);
    });

    it('MASTER는 상태를 변경할 수 없어야 함', async () => {
      mockMembers({ role: 'MASTER' }, { role: 'MASTER' });

      // 팀당 1명뿐이라 비활성화되면 관리 주체가 사라진다
      await expect(changeStatus()).rejects.toThrow(TeamMasterStatusChangeErrorResponseDto);
      expect(teamMemberRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('권한 정책 (canManageRole 적용)', () => {
    it.each([
      ['MASTER', 'MANAGER', true],
      ['MASTER', 'MEMBER', true],
      ['MANAGER', 'MEMBER', true],
      ['MANAGER', 'MANAGER', false],
      ['MEMBER', 'MEMBER', false],
    ])('%s가 %s의 상태를 변경할 수 있는가: %s', async (actorRole, targetRole, allowed) => {
      mockMembers({ role: actorRole }, { role: targetRole });

      const promise = changeStatus();

      if (allowed) {
        await expect(promise).resolves.toMatchObject({ newStatus: ActStatus.INACTIVE });
      } else {
        await expect(promise).rejects.toThrow(TeamMemberStatusChangeForbiddenErrorResponseDto);
        expect(teamMemberRepository.update).not.toHaveBeenCalled();
      }
    });

    it('역할 대소문자가 섞여도 동일하게 판정해야 함', async () => {
      mockMembers({ role: 'master' }, { role: 'member' });

      await expect(changeStatus()).resolves.toMatchObject({ newStatus: ActStatus.INACTIVE });
    });
  });

  describe('대상 조회 조건', () => {
    it('대상은 비활성 멤버도 찾을 수 있어야 함 (재활성화 경로)', async () => {
      const spy = mockMembers({ role: 'MASTER' }, {
        role: 'MEMBER',
        userActStatus: ActStatus.INACTIVE,
      });

      await changeStatus(ActStatus.ACTIVE);

      const targetQuery = spy.mock.calls.find((c) => c[0].userIds?.[0] === TARGET_ID)?.[0];
      // userActStatus 필터가 추가되면 비활성 멤버를 못 찾아 재활성화가 영구 불가능해진다
      expect(targetQuery).toEqual({ teamIds: [1], userIds: [TARGET_ID], actStatus: [ActStatus.ACTIVE] });
      expect(targetQuery).not.toHaveProperty('userActStatus');
    });

    it('요청자는 활성 멤버만 조회해야 함', async () => {
      const spy = mockMembers({ role: 'MASTER' }, { role: 'MEMBER' });

      await changeStatus();

      const actorQuery = spy.mock.calls.find((c) => c[0].userIds?.[0] === ACTOR_ID)?.[0];
      expect(actorQuery).toEqual({
        teamIds: [1],
        userIds: [ACTOR_ID],
        actStatus: [ActStatus.ACTIVE],
        userActStatus: [ActStatus.ACTIVE],
      });
    });
  });

  describe('상태 전이', () => {
    it.each([
      ['이미 활성인 멤버를 활성화', ActStatus.ACTIVE, ActStatus.ACTIVE],
      ['이미 비활성인 멤버를 비활성화', ActStatus.INACTIVE, ActStatus.INACTIVE],
    ])('%s하면 차단해야 함', async (_desc, current, requested) => {
      mockMembers({ role: 'MASTER' }, { role: 'MEMBER', userActStatus: current });

      await expect(changeStatus(requested)).rejects.toThrow(TeamInvalidRoleErrorResponseDto);
      expect(teamMemberRepository.update).not.toHaveBeenCalled();
    });

    it.each([
      ['비활성화', ActStatus.ACTIVE, ActStatus.INACTIVE],
      ['활성화', ActStatus.INACTIVE, ActStatus.ACTIVE],
    ])('%s는 해당 멤버 행만 갱신해야 함', async (_desc, current, requested) => {
      mockMembers({ role: 'MASTER' }, { role: 'MEMBER', userActStatus: current });

      await changeStatus(requested);

      expect(teamMemberRepository.update).toHaveBeenCalledWith(
        { teamId: 1, userId: TARGET_ID },
        { actStatus: requested },
      );
    });

    it('이전 상태와 이후 상태를 함께 반환해야 함', async () => {
      mockMembers({ role: 'MASTER' }, { role: 'MEMBER', userActStatus: ActStatus.ACTIVE });

      await expect(changeStatus(ActStatus.INACTIVE)).resolves.toEqual({
        teamId: 1,
        userId: TARGET_ID,
        userName: '김대상',
        previousStatus: ActStatus.ACTIVE,
        newStatus: ActStatus.INACTIVE,
        teamName: '테스트팀',
      });
    });
  });

  describe('사용자 이름 조회와 알림', () => {
    beforeEach(() => mockMembers({ role: 'MASTER' }, { role: 'MEMBER' }));

    it('이름 조회는 userName 컬럼만 select해야 함', async () => {
      await changeStatus();

      // 민감 컬럼이 응답·로그로 새지 않도록 필요한 컬럼만 가져온다
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { userId: TARGET_ID },
        select: ['userName'],
      });
    });

    it('이름이 없으면 사용자 ID로 대체해 알려야 함', async () => {
      userRepository.findOne.mockResolvedValue(createUser({ userName: null }));

      const result = await changeStatus();

      expect(result.userName).toBeNull();
      const { message } = notificationPort.notifyTeam.mock.calls[0][0] as { message: string };
      expect(message).toContain(`사용자 ${TARGET_ID}님이 비활성화되었습니다.`);
    });

    it('조회된 사용자가 없어도 실패하지 않아야 함', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(changeStatus()).resolves.toMatchObject({ userName: null });
    });

    it.each([
      [ActStatus.INACTIVE, '비활성화'],
      [ActStatus.ACTIVE, '활성화'],
    ])('상태 %s는 "%s"로 표기해 알려야 함', async (newStatus, label) => {
      mockMembers({ role: 'MASTER' }, {
        role: 'MEMBER',
        userActStatus: newStatus === ActStatus.ACTIVE ? ActStatus.INACTIVE : ActStatus.ACTIVE,
      });

      await changeStatus(newStatus);

      expect(notificationPort.notifyTeam).toHaveBeenCalledWith({
        team: {
          teamId: 1,
          teamName: '테스트팀',
          telegramChatId: null,
          discordWebhookUrl: null,
        },
        message: ['[테스트팀]', '🔄 멤버 상태 변경 알림 🔄', `김대상님이 ${label}되었습니다.`].join(
          '\n',
        ),
      });
    });
  });
});

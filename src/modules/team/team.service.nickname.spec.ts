import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TeamService } from './team.service';
import { TeamDisplayNameService } from './team-display-name.service';
import { createMockTeamDisplayNameService, MockTeamDisplayNameService } from './__spec__/team-display-name.mock';
import { Team } from '../../entities/Team';
import { TeamMember } from '../../entities/TeamMember';
import { TeamTask } from '../../entities/TeamTask';
import { TaskComment } from '../../entities/TaskComment';
import { TeamInvitation } from '../../entities/TeamInvitation';
import { NOTIFICATION_PORT } from '../../common/port/notification.port';
import { createTeam, createTeamMemberView, createTeamTask } from '../../entities/__spec__/entity.factory';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { TeamForbiddenErrorResponseDto } from './team-error.dto';

/**
 * 팀 단위 닉네임 (docs/tasks/team-nickname)
 *
 * 고정하는 것:
 *  1. 변경은 **본인 행만**, **활성 멤버만** 바꾼다 (D-002)
 *  2. 멤버 목록은 팀 안 표시 이름(userName)과 설정 화면용 원값(teamNickname)을 함께 준다
 *  3. 태스크 작성자 이름은 **태스크가 속한 팀**의 표시 이름이다 — 여러 팀을 한 번에 읽어도 섞이지 않는다
 */
describe('TeamService — 팀 닉네임', () => {
  let service: TeamService;
  let teamMemberRepository: MockRepository<TeamMember>;
  let teamTaskRepository: MockRepository<TeamTask>;
  let teamDisplayNameService: MockTeamDisplayNameService;

  beforeEach(async () => {
    teamMemberRepository = createMockRepository<TeamMember>();
    teamTaskRepository = createMockRepository<TeamTask>();
    teamDisplayNameService = createMockTeamDisplayNameService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamService,
        { provide: TeamDisplayNameService, useValue: teamDisplayNameService },
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } as unknown as DataSource },
        { provide: getRepositoryToken(Team), useValue: createMockRepository<Team>() },
        { provide: getRepositoryToken(TeamMember), useValue: teamMemberRepository },
        { provide: getRepositoryToken(TeamTask), useValue: teamTaskRepository },
        { provide: getRepositoryToken(TaskComment), useValue: createMockRepository<TaskComment>() },
        { provide: getRepositoryToken(TeamInvitation), useValue: createMockRepository<TeamInvitation>() },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: NOTIFICATION_PORT, useValue: { notifyTeam: jest.fn() } },
      ],
    }).compile();

    service = module.get(TeamService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('updateMyTeamNickname', () => {
    it('활성 멤버면 본인 행의 팀 닉네임만 바꾸고 바뀐 표시 이름을 돌려줘야 함', async () => {
      const verify = jest.spyOn(service, 'verifyTeamMemberAccess').mockResolvedValue(createTeamMemberView());
      teamDisplayNameService.getDisplayName.mockResolvedValue('기획 길동');

      const result = await service.updateMyTeamNickname({ teamId: 7, userId: 3, teamNickname: '기획 길동' });

      expect(verify).toHaveBeenCalledWith(7, 3);
      expect(teamMemberRepository.update).toHaveBeenCalledWith({ teamId: 7, userId: 3 }, { teamNickname: '기획 길동' });
      expect(teamDisplayNameService.getDisplayName).toHaveBeenCalledWith(7, 3);
      expect(result).toEqual({ teamId: 7, userId: 3, teamNickname: '기획 길동', userName: '기획 길동' });
    });

    it('활성 멤버가 아니면 403 TEAM_FORBIDDEN이고 아무것도 바꾸지 않아야 함', async () => {
      jest.spyOn(service, 'verifyTeamMemberAccess').mockRejectedValue(new TeamForbiddenErrorResponseDto());

      await expect(
        service.updateMyTeamNickname({ teamId: 7, userId: 3, teamNickname: '침입자' }),
      ).rejects.toMatchObject({ status: 403, code: 'TEAM_FORBIDDEN' });
      expect(teamMemberRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('getTeamUsers — 표시 이름과 원값', () => {
    beforeEach(() => {
      jest.spyOn(service, 'verifyTeamMemberAccess').mockResolvedValue(createTeamMemberView());
    });

    const mockRaw = (rows: Array<Record<string, unknown>>) => {
      const qb = createMockQueryBuilder({ getRawMany: rows });
      teamMemberRepository.createQueryBuilder.mockReturnValue(qb as never);
      return qb;
    };
    const raw = (userId: number, userName: string | null, teamNickname: string | null) => ({
      user_USER_ID: userId,
      user_USER_NAME: userName,
      tm_TEAM_NICKNAME: teamNickname,
      tm_ROLE: 'MEMBER',
      tm_ACT_STATUS: 1,
    });

    it('팀 닉네임 컬럼을 함께 읽어야 함', async () => {
      const qb = mockRaw([]);

      await service.getTeamUsers(7, 3);

      expect(qb.select).toHaveBeenCalledWith(expect.arrayContaining(['user.userName', 'tm.teamNickname']));
    });

    it('userName은 팀 닉네임 → 계정 닉네임 → 기본 표시명, teamNickname은 원값이어야 함', async () => {
      mockRaw([raw(1, '계정A', '팀A'), raw(2, '계정B', null), raw(3, null, null)]);

      const users = await service.getTeamUsers(7, 3);

      expect(users.map((u) => [u.userId, u.userName, u.teamNickname])).toEqual([
        [1, '팀A', '팀A'],
        [2, '계정B', null],
        [3, '사용자3', null],
      ]);
    });
  });

  describe('getTeamTasksBy — 작성자 이름은 태스크가 속한 팀 기준', () => {
    it('팀별로 작성자를 모아 그 팀의 표시 이름으로 해석해야 함', async () => {
      const task = (taskId: number, teamId: number, crtdBy: number) =>
        createTeamTask({ taskId, teamId, crtdBy, team: createTeam({ teamId }) });
      teamTaskRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ getMany: [task(1, 7, 3), task(2, 8, 3), task(3, 7, 4)] }) as never,
      );
      teamDisplayNameService.getDisplayNames.mockImplementation(async (teamId) =>
        teamId === 7
          ? new Map([
              [3, '7팀닉'],
              [4, '계정D'],
            ])
          : new Map([[3, '8팀닉']]),
      );

      const tasks = await service.getTeamTasksBy({ taskIds: [1, 2, 3] });

      expect(teamDisplayNameService.getDisplayNames).toHaveBeenCalledWith(7, [3, 4]);
      expect(teamDisplayNameService.getDisplayNames).toHaveBeenCalledWith(8, [3]);
      // 같은 사람(3)이라도 팀마다 다른 이름
      expect(tasks.map((t) => [t.taskId, t.userName])).toEqual([
        [1, '7팀닉'],
        [2, '8팀닉'],
        [3, '계정D'],
      ]);
    });
  });
});

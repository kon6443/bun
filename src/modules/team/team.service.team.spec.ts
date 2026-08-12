import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { TeamService, TeamMemberType } from './team.service';
import { Team } from '../../entities/Team';
import { TeamMember } from '../../entities/TeamMember';
import { TeamTask } from '../../entities/TeamTask';
import { TaskComment } from '../../entities/TaskComment';
import { TeamInvitation } from '../../entities/TeamInvitation';
import { User } from '../../entities/User';
import { NOTIFICATION_PORT } from '../../common/port/notification.port';
import { ActStatus } from '../../common/enums/task-status.enum';
import { createTeam, createTeamMemberView } from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import {
  TeamForbiddenErrorResponseDto,
  TeamNotFoundErrorResponseDto,
} from './team-error.dto';

const TEAM_ID = 7;
const LEADER_ID = 42;

/**
 * 팀 자체의 생성·수정.
 *
 * `insertTeam`의 핵심은 **팀과 MASTER 멤버가 한 트랜잭션**이라는 점이다.
 * 갈라지면 "팀은 있는데 멤버가 아무도 없는" 상태가 생기고, 모든 팀 API가
 * `verifyTeamMemberAccess`를 통과하지 못해 **생성자조차 접근할 수 없는 유령 팀**이 남는다.
 * 팀 삭제 API가 없으므로 그 상태는 수동 DB 조작 없이는 복구되지 않는다.
 */
describe('TeamService — 팀 생성·수정', () => {
  let service: TeamService;
  let teamRepository: MockRepository<Team>;
  let manager: { create: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    teamRepository = createMockRepository<Team>();
    manager = {
      create: jest.fn((_entity, data) => data),
      save: jest.fn((_entity, data) => Promise.resolve(data)),
    };
    // 실제 트랜잭션 대신 콜백을 즉시 실행 — 롤백이 아니라 "무엇을 한 단위로 묶었는가"가 관심사
    dataSource = {
      transaction: jest.fn((cb: (m: EntityManager) => Promise<void>) =>
        cb(manager as unknown as EntityManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamService,
        { provide: getDataSourceToken(), useValue: dataSource as unknown as DataSource },
        { provide: getRepositoryToken(Team), useValue: teamRepository },
        { provide: getRepositoryToken(TeamMember), useValue: createMockRepository<TeamMember>() },
        { provide: getRepositoryToken(TeamTask), useValue: createMockRepository<TeamTask>() },
        { provide: getRepositoryToken(TaskComment), useValue: createMockRepository<TaskComment>() },
        {
          provide: getRepositoryToken(TeamInvitation),
          useValue: createMockRepository<TeamInvitation>(),
        },
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: NOTIFICATION_PORT, useValue: { notifyTeam: jest.fn() } },
      ],
    }).compile();

    service = module.get(TeamService);
    teamRepository.save.mockImplementation((entity) => Promise.resolve(entity as Team));
  });

  afterEach(() => jest.restoreAllMocks());

  const mockMember = (member: TeamMemberType | null = createTeamMemberView()) =>
    jest.spyOn(service, 'getTeamMembersBy').mockResolvedValue(member ? [member] : []);

  describe('insertTeam', () => {
    const createTeamDto = {
      teamName: '새 팀',
      teamDescription: '설명',
      actStatus: ActStatus.ACTIVE,
      leaderId: LEADER_ID,
    };

    it('팀과 멤버를 한 트랜잭션으로 묶어야 함', async () => {
      manager.save.mockResolvedValueOnce({ ...createTeamDto, teamId: TEAM_ID });

      await service.insertTeam({ createTeamDto });

      // 갈라지면 멤버 없는 유령 팀이 남고, 팀 삭제 API가 없어 복구가 안 된다
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenCalledTimes(2);
    });

    it('생성자를 MASTER로 등록해야 함', async () => {
      manager.save.mockResolvedValueOnce({ ...createTeamDto, teamId: TEAM_ID });

      await service.insertTeam({ createTeamDto });

      // MASTER가 아니면 생성자가 자기 팀의 초대·역할 변경을 못 한다
      expect(manager.create).toHaveBeenCalledWith(TeamMember, {
        userId: LEADER_ID,
        teamId: TEAM_ID,
        role: 'MASTER',
      });
    });

    it('멤버의 teamId는 저장된 팀에서 받아와야 함', async () => {
      // DB가 발번한 ID여야 한다 — DTO에는 teamId가 없다
      manager.save.mockResolvedValueOnce({ ...createTeamDto, teamId: 999 });

      await service.insertTeam({ createTeamDto });

      expect(manager.create).toHaveBeenCalledWith(
        TeamMember,
        expect.objectContaining({ teamId: 999 }),
      );
    });

    it('팀은 DTO 값 그대로 생성해야 함', async () => {
      manager.save.mockResolvedValueOnce({ ...createTeamDto, teamId: TEAM_ID });

      await service.insertTeam({ createTeamDto });

      expect(manager.create).toHaveBeenCalledWith(Team, createTeamDto);
    });

    it('트랜잭션이 실패하면 예외를 전파해야 함', async () => {
      dataSource.transaction.mockRejectedValue(new Error('ORA-00001'));

      // 삼키면 컨트롤러가 SUCCESS를 반환해 사용자는 팀이 생긴 줄 안다
      await expect(service.insertTeam({ createTeamDto })).rejects.toThrow('ORA-00001');
    });
  });

  describe('updateTeam', () => {
    const update = (dto: { teamName?: string; teamDescription?: string }) =>
      service.updateTeam({ teamId: TEAM_ID, updateTeamDto: dto, userId: 1 });

    it('팀 멤버가 아니면 팀을 조회하기도 전에 차단해야 함', async () => {
      mockMember(null);

      await expect(update({ teamName: '변경' })).rejects.toThrow(TeamForbiddenErrorResponseDto);
      expect(teamRepository.findOne).not.toHaveBeenCalled();
    });

    it('역할과 무관하게 모든 활성 멤버가 수정할 수 있어야 함 (현재 정책)', async () => {
      mockMember(createTeamMemberView({ role: 'MEMBER' }));
      teamRepository.findOne.mockResolvedValue(createTeam({ teamId: TEAM_ID }));

      // 초대·역할 변경과 달리 관리 권한을 요구하지 않는다.
      // 정책을 "MANAGER 이상"으로 바꾸면 이 테스트가 먼저 깨진다
      await expect(update({ teamName: '변경' })).resolves.toMatchObject({ teamName: '변경' });
    });

    it('팀이 없으면 404를 던져야 함', async () => {
      mockMember();
      teamRepository.findOne.mockResolvedValue(null);

      await expect(update({ teamName: '변경' })).rejects.toThrow(TeamNotFoundErrorResponseDto);
      expect(teamRepository.save).not.toHaveBeenCalled();
    });

    it('지정한 필드만 바꾸고 나머지는 유지해야 함', async () => {
      mockMember();
      teamRepository.findOne.mockResolvedValue(
        createTeam({ teamId: TEAM_ID, teamName: '원본', teamDescription: '원본 설명' }),
      );

      const result = await update({ teamName: '변경' });

      expect(result.teamName).toBe('변경');
      expect(result.teamDescription).toBe('원본 설명');
    });

    it('설명을 빈 문자열로 보내면 null로 지워야 함', async () => {
      mockMember();
      teamRepository.findOne.mockResolvedValue(
        createTeam({ teamId: TEAM_ID, teamDescription: '원본 설명' }),
      );

      const result = await update({ teamDescription: '' });

      expect(result.teamDescription).toBeNull();
    });

    it('아무 필드도 안 보내면 그대로 저장해야 함', async () => {
      mockMember();
      const team = createTeam({ teamId: TEAM_ID, teamName: '원본' });
      teamRepository.findOne.mockResolvedValue(team);

      const result = await update({});

      expect(result.teamName).toBe('원본');
      expect(teamRepository.save).toHaveBeenCalledWith(team);
    });

    it('활성 상태와 무관하게 팀을 조회해야 함 (비활성 팀 정보 수정 경로)', async () => {
      mockMember();
      teamRepository.findOne.mockResolvedValue(createTeam({ teamId: TEAM_ID }));

      await update({ teamName: '변경' });

      // 멤버 검증이 이미 활성 팀만 통과시키므로 여기서 actStatus를 다시 걸지 않는다
      expect(teamRepository.findOne).toHaveBeenCalledWith({ where: { teamId: TEAM_ID } });
    });
  });
});

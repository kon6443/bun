import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { TeamService, TeamMemberType } from './team.service';
import { Team } from '../../entities/Team';
import { TeamMember } from '../../entities/TeamMember';
import { TeamTask } from '../../entities/TeamTask';
import { TaskComment } from '../../entities/TaskComment';
import { TeamInvitation } from '../../entities/TeamInvitation';
import { User } from '../../entities/User';
import { NOTIFICATION_PORT, TeamNotificationParams } from '../../common/port/notification.port';
import { ActStatus, TaskStatus } from '../../common/enums/task-status.enum';
import {
  createTeam,
  createTeamTask,
  createTeamTaskView,
  createTeamMemberView,
  createTeamTag,
  createTeamTaskTag,
  FIXED_DATE,
} from '../../entities/__spec__/entity.factory';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import {
  TeamForbiddenErrorResponseDto,
  TeamTaskNotFoundErrorResponseDto,
  TeamTaskBadRequestErrorResponseDto,
} from './team-error.dto';

const DOMAIN = 'https://example.test';
const CONFIG: Record<string, string> = { NEXT_PUBLIC_DOMAIN: DOMAIN };

/**
 * TeamService의 태스크 상태 변경 계열(`verifyTeamMemberAccess` 포함)을 검증한다.
 *
 * 핵심은 두 가지다:
 *  1. **팀 격리** — 멤버 검증과 `task.teamId` 대조가 모든 경로에서 선행하는가.
 *  2. **`completedAt` 자동 관리** — 이 값은 SchedulerService 자동 아카이브의 기준값이라
 *     로직이 깨지면 아카이브가 안 되거나 엉뚱한 태스크가 보관함으로 사라진다.
 *
 * `getTeamMembersBy`는 같은 서비스의 쿼리 헬퍼이므로 spy로 격리한다 —
 * 여기서 볼 것은 쿼리 조립이 아니라 "어떤 조건으로 물었고 결과에 따라 어떻게 분기하는가"다.
 */
describe('TeamService — 태스크 상태', () => {
  let service: TeamService;
  let teamRepository: MockRepository<Team>;
  let teamTaskRepository: MockRepository<TeamTask>;
  let notificationPort: { notifyTeam: jest.Mock };
  /** 트랜잭션·태그 조회(task-tags.ts)가 쓰는 EntityManager */
  let manager: {
    find: jest.Mock;
    count: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    insert: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  /** 태스크 행 잠금(SELECT … FOR UPDATE) 쿼리 빌더 */
  let lockQueryBuilder: ReturnType<typeof createMockQueryBuilder>;

  /** 첫 알림의 부가 정보 줄 */
  const notifiedLines = (): string[] =>
    (notificationPort.notifyTeam.mock.calls[0][0] as TeamNotificationParams).content.lines ?? [];

  beforeEach(async () => {
    teamRepository = createMockRepository<Team>();
    teamTaskRepository = createMockRepository<TeamTask>();
    notificationPort = { notifyTeam: jest.fn() };
    lockQueryBuilder = createMockQueryBuilder({ getMany: [] });
    manager = {
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn(),
      save: jest.fn((entity: TeamTask) => Promise.resolve(createTeamTask(entity))),
      delete: jest.fn(),
      insert: jest.fn(),
      createQueryBuilder: jest.fn(() => lockQueryBuilder),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamService,
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: jest.fn((run: (m: typeof manager) => unknown) => run(manager)),
            manager,
          } as unknown as DataSource,
        },
        { provide: getRepositoryToken(Team), useValue: teamRepository },
        { provide: getRepositoryToken(TeamMember), useValue: createMockRepository<TeamMember>() },
        { provide: getRepositoryToken(TeamTask), useValue: teamTaskRepository },
        { provide: getRepositoryToken(TaskComment), useValue: createMockRepository<TaskComment>() },
        {
          provide: getRepositoryToken(TeamInvitation),
          useValue: createMockRepository<TeamInvitation>(),
        },
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: ConfigService, useValue: { get: jest.fn((k: string) => CONFIG[k]) } },
        { provide: NOTIFICATION_PORT, useValue: notificationPort },
      ],
    }).compile();

    service = module.get(TeamService);
    teamTaskRepository.save.mockImplementation((entity) => Promise.resolve(entity as TeamTask));
  });

  afterEach(() => jest.restoreAllMocks());

  /** 팀 멤버 조회 결과를 고정한다. null이면 "멤버가 아님". */
  const mockMember = (member: TeamMemberType | null = createTeamMemberView()) =>
    jest.spyOn(service, 'getTeamMembersBy').mockResolvedValue(member ? [member] : []);

  const updateStatus = (
    taskStatus: TaskStatus = TaskStatus.IN_PROGRESS,
    { teamId = 1, taskId = 1, userId = 1 } = {},
  ) => service.updateTaskStatus({ teamId, taskId, updateStatusDto: { taskStatus }, userId });

  const updateActiveStatus = (
    actStatus: ActStatus = ActStatus.INACTIVE,
    { teamId = 1, taskId = 1, userId = 1 } = {},
  ) =>
    service.updateTaskActiveStatus({
      teamId,
      taskId,
      updateActiveStatusDto: { actStatus },
      userId,
    });

  /** save에 넘어간 엔티티 — 서비스가 "무엇을 저장하려 했는가"를 본다. */
  const savedTask = () => teamTaskRepository.save.mock.calls[0][0] as TeamTask;

  describe('verifyTeamMemberAccess — 모든 팀 API의 공통 진입점', () => {
    it('활성 팀 + 활성 멤버 조건으로만 조회해야 함', async () => {
      const spy = mockMember();

      await service.verifyTeamMemberAccess(7, 42);

      // 조건 하나라도 빠지면 비활성 팀·탈퇴 멤버가 팀 데이터에 접근한다
      expect(spy).toHaveBeenCalledWith({
        teamIds: [7],
        userIds: [42],
        actStatus: [ActStatus.ACTIVE],
        userActStatus: [ActStatus.ACTIVE],
      });
    });

    it('조회 결과가 없으면 TEAM_FORBIDDEN을 던져야 함', async () => {
      mockMember(null);

      await expect(service.verifyTeamMemberAccess(1, 1)).rejects.toThrow(
        TeamForbiddenErrorResponseDto,
      );
    });

    it('멤버면 조회된 팀+멤버 정보를 그대로 반환해야 함', async () => {
      const member = createTeamMemberView({ teamId: 7, userId: 42, role: 'MANAGER' });
      mockMember(member);

      await expect(service.verifyTeamMemberAccess(7, 42)).resolves.toEqual(member);
    });
  });

  describe('조회 응답 — 팀 알림 채널 정보를 싣지 않는다', () => {
    /** 조회 헬퍼는 알림 경로도 쓰므로 웹훅 URL·chatId를 담고 있다 — 응답으로 새면 일반 멤버가 채널에 임의 게시할 수 있다 */
    const leakyTask = () =>
      createTeamTaskView({ telegramChatId: 123456, discordWebhookUrl: 'https://discord.test/api/webhooks/1/secret' });

    it('getTasksByTeamId의 tasks에 discordWebhookUrl·telegramChatId가 없어야 함', async () => {
      mockMember();
      teamRepository.findOne.mockResolvedValue(createTeam({ teamId: 1 }));
      jest.spyOn(service, 'getTeamTasksBy').mockResolvedValue([leakyTask()]);

      const { tasks } = await service.getTasksByTeamId(1, 1);

      expect(tasks).toHaveLength(1);
      expect(tasks[0]).not.toHaveProperty('discordWebhookUrl');
      expect(tasks[0]).not.toHaveProperty('telegramChatId');
      expect(tasks[0]).toMatchObject({ taskId: 1, teamId: 1, taskName: '테스트 태스크', userName: '홍길동' });
    });

    it('getTaskWithComments의 task에 discordWebhookUrl·telegramChatId가 없어야 함', async () => {
      mockMember();
      jest.spyOn(service, 'getTeamTasksBy').mockResolvedValue([leakyTask()]);
      jest.spyOn(service, 'getCommentsByTaskId').mockResolvedValue([]);

      const { task } = await service.getTaskWithComments(1, 1, 1);

      expect(task).not.toHaveProperty('discordWebhookUrl');
      expect(task).not.toHaveProperty('telegramChatId');
      expect(task).toMatchObject({ taskId: 1, teamId: 1 });
    });
  });

  describe('createTask', () => {
    const create = ({ teamId = 1, userId = 1, taskName = '새 태스크' } = {}) =>
      service.createTask({
        teamId,
        createTaskDto: { taskName, taskDescription: '설명' },
        userId,
      });

    beforeEach(() => {
      teamTaskRepository.create.mockImplementation((data) => data as TeamTask);
      teamTaskRepository.save.mockImplementation((entity) =>
        Promise.resolve(createTeamTask(entity as Partial<TeamTask>)),
      );
    });

    it('팀 멤버가 아니면 태스크를 만들지 못해야 함', async () => {
      mockMember(null);

      await expect(create()).rejects.toThrow(TeamForbiddenErrorResponseDto);
      expect(teamTaskRepository.save).not.toHaveBeenCalled();
      expect(notificationPort.notifyTeam).not.toHaveBeenCalled();
    });

    it('멤버 검증이 팀 존재·활성 확인을 겸해야 함 (별도 팀 조회 없음)', async () => {
      const spy = mockMember();

      await create({ teamId: 3 });

      // 팀이 없거나 비활성이면 이 조회에서 걸러진다 — teamRepository를 따로 보지 않는 이유
      expect(spy).toHaveBeenCalledWith({
        teamIds: [3],
        userIds: [1],
        actStatus: [ActStatus.ACTIVE],
        userActStatus: [ActStatus.ACTIVE],
      });
      expect(teamRepository.findOne).not.toHaveBeenCalled();
    });

    it('활성 상태 + 기본 작업 상태로 생성해야 함', async () => {
      mockMember();

      await create({ teamId: 3, userId: 9, taskName: '배포 준비' });

      expect(teamTaskRepository.create).toHaveBeenCalledWith({
        teamId: 3,
        taskName: '배포 준비',
        taskDescription: '설명',
        taskStatus: TaskStatus.CREATED,
        actStatus: ActStatus.ACTIVE,
        crtdBy: 9,
        startAt: null,
        endAt: null,
      });
    });

    it('알림 대상 팀 정보는 멤버 검증 결과에서 가져와야 함', async () => {
      const member = createTeamMemberView({ teamId: 3, telegramChatId: 555 });
      mockMember(member);

      await create({ teamId: 3, taskName: '배포 준비' });

      expect(notificationPort.notifyTeam).toHaveBeenCalledWith({
        team: member,
        content: { title: '🆕 새 태스크', subject: '배포 준비', lines: [] },
        url: `${DOMAIN}/teams/3/tasks/1`,
      });
    });
  });

  describe('createTask — 기간 검증', () => {
    const start = new Date('2026-10-19T15:00:00Z');
    const end = new Date('2026-10-20T14:59:59Z');
    const createWith = (startAt?: Date, endAt?: Date) =>
      service.createTask({
        teamId: 1,
        createTaskDto: { taskName: '기간', taskDescription: '설명', startAt, endAt },
        userId: 1,
      });

    beforeEach(() => {
      teamTaskRepository.create.mockImplementation((data) => data as TeamTask);
      teamTaskRepository.save.mockImplementation((entity) =>
        Promise.resolve(createTeamTask(entity as Partial<TeamTask>)),
      );
    });

    it('종료가 시작보다 빠르면 TEAM_TASK_BAD_REQUEST(400)로 거부하고 저장·알림하지 않아야 함', async () => {
      mockMember();

      const error = await createWith(end, start).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TeamTaskBadRequestErrorResponseDto);
      expect(error).toMatchObject({ code: 'TEAM_TASK_BAD_REQUEST', status: 400 });
      expect(teamTaskRepository.save).not.toHaveBeenCalled();
      expect(notificationPort.notifyTeam).not.toHaveBeenCalled();
    });

    it('시작과 종료가 같은 시각이면 허용해야 함', async () => {
      mockMember();

      await expect(createWith(start, start)).resolves.toBeDefined();
    });

    it('한쪽만 있으면 검증하지 않아야 함', async () => {
      mockMember();

      await expect(createWith(undefined, start)).resolves.toBeDefined();
      await expect(createWith(end, undefined)).resolves.toBeDefined();
    });
  });

  describe('updateTask', () => {
    const update = (
      dto: { taskName?: string; taskDescription?: string; startAt?: Date; endAt?: Date },
      { teamId = 1, taskId = 1, userId = 1 } = {},
    ) => service.updateTask({ teamId, taskId, updateTaskDto: dto, userId });

    it('팀 멤버가 아니면 태스크를 조회하기도 전에 차단해야 함', async () => {
      mockMember(null);

      await expect(update({ taskName: '변경' })).rejects.toThrow(TeamForbiddenErrorResponseDto);
      expect(teamTaskRepository.findOne).not.toHaveBeenCalled();
    });

    it('태스크가 없으면 TEAM_TASK_NOT_FOUND를 던져야 함', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(null);

      await expect(update({ taskName: '변경' })).rejects.toThrow(TeamTaskNotFoundErrorResponseDto);
      expect(teamTaskRepository.save).not.toHaveBeenCalled();
    });

    it('다른 팀의 태스크면 차단해야 함 (팀 격리)', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(createTeamTask({ teamId: 99 }));

      await expect(update({ taskName: '변경' }, { teamId: 1 })).rejects.toThrow(
        TeamTaskBadRequestErrorResponseDto,
      );
      expect(teamTaskRepository.save).not.toHaveBeenCalled();
      expect(notificationPort.notifyTeam).not.toHaveBeenCalled();
    });

    it('종료만 바꿔도 기존 시작과 역전되면 거부하고 저장하지 않아야 함 (병합 결과로 검증)', async () => {
      mockMember();
      const start = new Date('2026-10-19T15:00:00Z');
      teamTaskRepository.findOne.mockResolvedValue(createTeamTask({ startAt: start, endAt: null }));

      const error = await update({ endAt: new Date('2026-10-18T15:00:00Z') }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TeamTaskBadRequestErrorResponseDto);
      expect(error).toMatchObject({ code: 'TEAM_TASK_BAD_REQUEST', status: 400 });
      expect(teamTaskRepository.save).not.toHaveBeenCalled();
      expect(notificationPort.notifyTeam).not.toHaveBeenCalled();
    });

    it('지정한 필드만 바꾸고 나머지는 유지해야 함', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(
        createTeamTask({ taskName: '원본', taskDescription: '원본 설명', startAt: FIXED_DATE }),
      );

      await update({ taskName: '변경' });

      const saved = savedTask();
      expect(saved.taskName).toBe('변경');
      // dto에 없는 키는 undefined이므로 건드리면 안 된다
      expect(saved.taskDescription).toBe('원본 설명');
      expect(saved.startAt).toEqual(FIXED_DATE);
    });

    it.each([
      ['설명', { taskDescription: '' }, 'taskDescription' as const],
      ['시작일', { startAt: null }, 'startAt' as const],
      ['종료일', { endAt: null }, 'endAt' as const],
    ])('%s을 빈 값으로 보내면 null로 지워야 함', async (_desc, dto, field) => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(
        createTeamTask({ taskDescription: '설명', startAt: FIXED_DATE, endAt: FIXED_DATE }),
      );

      // 빈 문자열·null은 "지우기" 의도 — undefined(미지정)와 구분된다
      await update(dto as never);

      expect(savedTask()[field]).toBeNull();
    });

    it('작업 상태와 활성 상태는 이 API로 바꿀 수 없어야 함', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(
        createTeamTask({ taskStatus: TaskStatus.IN_PROGRESS, actStatus: ActStatus.ACTIVE }),
      );

      // 상태 전용 API를 우회하면 completedAt 자동 관리가 건너뛰어져 자동 아카이브가 어긋난다
      await update({
        taskName: '변경',
        taskStatus: TaskStatus.COMPLETED,
        actStatus: ActStatus.INACTIVE,
      } as never);

      expect(savedTask().taskStatus).toBe(TaskStatus.IN_PROGRESS);
      expect(savedTask().actStatus).toBe(ActStatus.ACTIVE);
      expect(savedTask().completedAt).toBeNull();
    });

    it('수정 알림을 보내고 저장된 태스크를 반환해야 함', async () => {
      const member = createTeamMemberView();
      mockMember(member);
      const task = createTeamTask({ teamId: 3, taskId: 8, startAt: null, endAt: null });
      teamTaskRepository.findOne.mockResolvedValue(task);

      const result = await update({ taskName: '변경' }, { teamId: 3, taskId: 8 });

      expect(result).toBe(task);
      expect(notificationPort.notifyTeam).toHaveBeenCalledWith({
        team: member,
        // 무엇이 수정됐는지 알 수 있게 태스크명을 대상으로 싣는다
        content: { title: '✏️ 태스크 수정', subject: '변경', lines: [] },
        url: `${DOMAIN}/teams/3/tasks/8`,
      });
    });

    it('기간이 있으면 알림에 기간 줄을 포함해야 함', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(createTeamTask({ endAt: FIXED_DATE }));

      await update({ taskName: '변경' });

      expect(notifiedLines()).toEqual([expect.stringMatching(/^📅 /)]);
    });
  });

  describe('updateTaskStatus — 접근 제어', () => {
    it('팀 멤버가 아니면 태스크를 조회하기도 전에 차단해야 함', async () => {
      mockMember(null);

      await expect(updateStatus()).rejects.toThrow(TeamForbiddenErrorResponseDto);
      expect(teamTaskRepository.findOne).not.toHaveBeenCalled();
    });

    it('태스크가 없으면 TEAM_TASK_NOT_FOUND를 던져야 함', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(null);

      await expect(updateStatus()).rejects.toThrow(TeamTaskNotFoundErrorResponseDto);
      expect(teamTaskRepository.save).not.toHaveBeenCalled();
    });

    it('다른 팀의 태스크면 차단해야 함 (팀 격리)', async () => {
      mockMember();
      // taskId만 알면 조회는 되므로, teamId 대조가 유일한 방어선이다
      teamTaskRepository.findOne.mockResolvedValue(createTeamTask({ taskId: 1, teamId: 99 }));

      await expect(updateStatus(TaskStatus.COMPLETED, { teamId: 1 })).rejects.toThrow(
        TeamTaskBadRequestErrorResponseDto,
      );
      expect(teamTaskRepository.save).not.toHaveBeenCalled();
      expect(notificationPort.notifyTeam).not.toHaveBeenCalled();
    });
  });

  describe('updateTaskStatus — completedAt 자동 관리 (자동 아카이브 기준값)', () => {
    it.each([
      [TaskStatus.CREATED, false],
      [TaskStatus.IN_PROGRESS, false],
      [TaskStatus.COMPLETED, true],
      [TaskStatus.ON_HOLD, false],
      [TaskStatus.CANCELLED, true],
    ])('상태 %s → completedAt 설정 여부: %s', async (taskStatus, shouldSet) => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(createTeamTask());
      const before = Date.now();

      const result = await updateStatus(taskStatus);

      expect(result.taskStatus).toBe(taskStatus);
      if (shouldSet) {
        expect(result.completedAt).toBeInstanceOf(Date);
        // 실행 시간 오차를 감안해 ±5초 이내인지 확인
        expect(Math.abs((result.completedAt as Date).getTime() - before)).toBeLessThan(5_000);
      } else {
        expect(result.completedAt).toBeNull();
      }
    });

    it('완료를 되돌리면 completedAt을 null로 초기화해야 함', async () => {
      mockMember();
      // 이미 완료 처리되어 아카이브 대기 중이던 태스크
      teamTaskRepository.findOne.mockResolvedValue(
        createTeamTask({ taskStatus: TaskStatus.COMPLETED, completedAt: FIXED_DATE }),
      );

      const result = await updateStatus(TaskStatus.IN_PROGRESS);

      // 남아 있으면 진행중 태스크가 14일 뒤 보관함으로 사라진다
      expect(result.completedAt).toBeNull();
      expect(savedTask().completedAt).toBeNull();
    });

    it('변경된 엔티티를 저장하고 그 엔티티를 반환해야 함', async () => {
      mockMember();
      const task = createTeamTask();
      teamTaskRepository.findOne.mockResolvedValue(task);

      const result = await updateStatus(TaskStatus.COMPLETED);

      expect(teamTaskRepository.findOne).toHaveBeenCalledWith({ where: { taskId: 1 } });
      expect(teamTaskRepository.save).toHaveBeenCalledTimes(1);
      expect(result).toBe(task);
    });
  });

  describe('updateTaskStatus — 알림', () => {
    it('팀 정보·이전/이후 상태·태스크 URL을 담아 전송해야 함', async () => {
      const member = createTeamMemberView();
      mockMember(member);
      teamTaskRepository.findOne.mockResolvedValue(
        createTeamTask({ teamId: 3, taskId: 8, taskName: '배포 준비', taskStatus: TaskStatus.CREATED }),
      );

      await updateStatus(TaskStatus.IN_PROGRESS, { teamId: 3, taskId: 8 });

      expect(notificationPort.notifyTeam).toHaveBeenCalledWith({
        team: member,
        content: { title: '🔄 상태 변경', subject: '배포 준비', lines: ['생성됨 → 진행중'] },
        url: `${DOMAIN}/teams/3/tasks/8`,
      });
    });

    it('기간이 없는 태스크는 기간 줄을 넣지 않아야 함', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(
        createTeamTask({ startAt: null, endAt: null }),
      );

      await updateStatus();

      expect(notifiedLines().some((line) => line.startsWith('📅'))).toBe(false);
    });

    it('기간이 있는 태스크는 기간 줄을 포함해야 함', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(createTeamTask({ startAt: FIXED_DATE }));

      await updateStatus();

      expect(notifiedLines()).toContainEqual(expect.stringMatching(/^📅 /));
    });
  });

  describe('updateTaskActiveStatus', () => {
    it('팀 멤버가 아니면 태스크를 조회하기도 전에 차단해야 함', async () => {
      mockMember(null);

      await expect(updateActiveStatus()).rejects.toThrow(TeamForbiddenErrorResponseDto);
      expect(teamTaskRepository.findOne).not.toHaveBeenCalled();
    });

    it('태스크가 없으면 TEAM_TASK_NOT_FOUND를 던져야 함', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(null);

      await expect(updateActiveStatus()).rejects.toThrow(TeamTaskNotFoundErrorResponseDto);
      expect(teamTaskRepository.save).not.toHaveBeenCalled();
    });

    it('다른 팀의 태스크면 차단해야 함 (팀 격리)', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(createTeamTask({ teamId: 99 }));

      await expect(updateActiveStatus(ActStatus.INACTIVE, { teamId: 1 })).rejects.toThrow(
        TeamTaskBadRequestErrorResponseDto,
      );
      expect(teamTaskRepository.save).not.toHaveBeenCalled();
    });

    it.each([
      [ActStatus.INACTIVE],
      [ActStatus.ACTIVE],
    ])('actStatus %s로 저장하고 저장 결과를 반환해야 함', async (actStatus) => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(
        createTeamTask({ actStatus: actStatus === ActStatus.ACTIVE ? ActStatus.INACTIVE : ActStatus.ACTIVE }),
      );

      const result = await updateActiveStatus(actStatus);

      expect(savedTask().actStatus).toBe(actStatus);
      expect(result.actStatus).toBe(actStatus);
    });

    it('작업 상태와 completedAt은 건드리지 않아야 함 (보관 처리는 진행 상태와 무관)', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(
        createTeamTask({ taskStatus: TaskStatus.COMPLETED, completedAt: FIXED_DATE }),
      );

      await updateActiveStatus(ActStatus.INACTIVE);

      expect(savedTask().taskStatus).toBe(TaskStatus.COMPLETED);
      expect(savedTask().completedAt).toEqual(FIXED_DATE);
    });

    it('알림을 보내지 않아야 함 (보관 토글은 팀 전체에 알릴 사건이 아니다)', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(createTeamTask());

      await updateActiveStatus();

      // updateTaskStatus와의 의도적 차이 — 알림이 추가되면 이 테스트가 먼저 깨진다
      expect(notificationPort.notifyTeam).not.toHaveBeenCalled();
    });
  });

  /**
   * 태스크 태그 연결 (docs/tasks/team-task-tags D-005).
   * 다른 팀 태그가 붙는 것을 막는 방어는 assertTeamTagIds 하나뿐이다(DB 팀 일치 제약 없음, D-018).
   */
  describe('태그 — tagIds 연결과 응답 tags', () => {
    /** findTagsByTaskIds가 읽는 연결 행 */
    const linkRow = (taskId: number, tagId: number, tagName: string) =>
      createTeamTaskTag({ taskId, tagId, tag: createTeamTag({ tagId, tagName }) });

    beforeEach(() => {
      teamTaskRepository.create.mockImplementation((data) => data as TeamTask);
      teamTaskRepository.save.mockImplementation((entity) =>
        Promise.resolve(createTeamTask(entity as Partial<TeamTask>)),
      );
    });

    describe('createTask', () => {
      const createWithTags = (tagIds?: number[]) =>
        service.createTask({ teamId: 1, createTaskDto: { taskName: '태그', taskDescription: '설명', tagIds }, userId: 1 });

      it('다른 팀·없는 태그가 섞이면 TEAM_TASK_BAD_REQUEST(400)로 거부하고 태스크를 남기지 않아야 함', async () => {
        mockMember();
        manager.count.mockResolvedValue(1); // 2개 요청 중 이 팀 태그는 1개

        const error = await createWithTags([1, 2]).catch((e: unknown) => e);

        expect(error).toMatchObject({ code: 'TEAM_TASK_BAD_REQUEST', status: 400 });
        expect(manager.save).not.toHaveBeenCalled();
        expect(teamTaskRepository.save).not.toHaveBeenCalled();
        expect(notificationPort.notifyTeam).not.toHaveBeenCalled();
      });

      it('태스크 저장과 연결을 같은 트랜잭션에서 하고 붙은 태그를 반환해야 함', async () => {
        mockMember();
        manager.count.mockResolvedValue(2);
        manager.find.mockResolvedValue([linkRow(1, 2, '디자인'), linkRow(1, 1, '긴급')]);

        const task = await createWithTags([1, 2]);

        expect(manager.save).toHaveBeenCalledTimes(1);
        expect(teamTaskRepository.save).not.toHaveBeenCalled();
        expect(manager.insert.mock.calls.map(([, row]) => row as unknown)).toEqual([
          { taskId: 1, tagId: 1 },
          { taskId: 1, tagId: 2 },
        ]);
        // 순서는 조회 결과(팀 태그 sortOrder) 그대로
        expect(task.tags).toEqual([
          { tagId: 2, tagName: '디자인', tagColor: '#F87171' },
          { tagId: 1, tagName: '긴급', tagColor: '#F87171' },
        ]);
      });

      it('tagIds가 없으면 트랜잭션 없이 저장하고 tags는 빈 배열이어야 함', async () => {
        mockMember();

        const task = await createWithTags(undefined);

        expect(teamTaskRepository.save).toHaveBeenCalledTimes(1);
        expect(manager.insert).not.toHaveBeenCalled();
        expect(task.tags).toEqual([]);
      });
    });

    describe('updateTask', () => {
      const updateWithTags = (tagIds?: number[]) =>
        service.updateTask({ teamId: 1, taskId: 1, updateTaskDto: { taskName: '변경', tagIds }, userId: 1 });

      beforeEach(() => {
        teamTaskRepository.findOne.mockResolvedValue(createTeamTask());
      });

      it('tagIds를 생략하면 연결을 건드리지 않고 현재 태그를 반환해야 함', async () => {
        mockMember();
        manager.find.mockResolvedValue([linkRow(1, 5, '기존')]);

        const task = await updateWithTags(undefined);

        expect(manager.delete).not.toHaveBeenCalled();
        expect(manager.insert).not.toHaveBeenCalled();
        expect(teamTaskRepository.save).toHaveBeenCalledTimes(1);
        expect(task.tags).toEqual([{ tagId: 5, tagName: '기존', tagColor: '#F87171' }]);
      });

      it('빈 배열이면 모든 태그를 제거해야 함', async () => {
        mockMember();

        const task = await updateWithTags([]);

        expect(manager.delete).toHaveBeenCalledTimes(1);
        expect(manager.insert).not.toHaveBeenCalled();
        expect(task.tags).toEqual([]);
      });

      it('배열이면 기존 연결을 지우고 그 목록으로 전체 교체해야 함', async () => {
        mockMember();
        manager.count.mockResolvedValue(2);

        await updateWithTags([3, 4]);

        expect(manager.delete.mock.invocationCallOrder[0]).toBeLessThan(manager.insert.mock.invocationCallOrder[0]);
        expect(manager.insert.mock.calls.map(([, row]) => row as unknown)).toEqual([
          { taskId: 1, tagId: 3 },
          { taskId: 1, tagId: 4 },
        ]);
        expect(teamTaskRepository.save).not.toHaveBeenCalled();
      });

      it('연결을 지우기 전에 태스크 행을 잠가야 함 (동시 교체 직렬화, row-limit 없는 FOR UPDATE)', async () => {
        mockMember();
        manager.count.mockResolvedValue(1);

        await updateWithTags([3]);

        expect(manager.createQueryBuilder).toHaveBeenCalledWith(TeamTask, 'task');
        expect(lockQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
        // findOne(take 1)을 쓰면 Oracle이 FETCH NEXT와 FOR UPDATE 조합을 거부한다(ORA-02014)
        expect(lockQueryBuilder.take).not.toHaveBeenCalled();
        expect(lockQueryBuilder.getMany.mock.invocationCallOrder[0]).toBeLessThan(
          manager.delete.mock.invocationCallOrder[0],
        );
      });

      it('검증 직후 태그가 삭제돼 FK 위반(ORA-02291)이 나면 500 대신 TEAM_TASK_BAD_REQUEST(400)여야 함', async () => {
        mockMember();
        manager.count.mockResolvedValue(1);
        manager.insert.mockRejectedValue(new QueryFailedError('INSERT', [], Object.assign(new Error('ORA-02291'), { errorNum: 2291 })));

        const error = await updateWithTags([3]).catch((e: unknown) => e);

        expect(error).toMatchObject({ code: 'TEAM_TASK_BAD_REQUEST', status: 400 });
        expect(notificationPort.notifyTeam).not.toHaveBeenCalled();
      });

      it('다른 팀 태그가 섞이면 400으로 거부하고 태스크도 저장하지 않아야 함', async () => {
        mockMember();
        manager.count.mockResolvedValue(0);

        const error = await updateWithTags([9]).catch((e: unknown) => e);

        expect(error).toMatchObject({ code: 'TEAM_TASK_BAD_REQUEST', status: 400 });
        expect(manager.save).not.toHaveBeenCalled();
        expect(manager.delete).not.toHaveBeenCalled();
        expect(notificationPort.notifyTeam).not.toHaveBeenCalled();
      });
    });

    describe('알림 — 태그 줄 (D-022)', () => {
      /** 기간 줄(📅)을 뺀 태그 관련 줄만 */
      const tagLines = () => notifiedLines().filter((line) => !line.startsWith('📅'));
      const updateWithTags = (tagIds?: number[]) =>
        service.updateTask({ teamId: 1, taskId: 1, updateTaskDto: { taskName: '변경', tagIds }, userId: 1 });

      beforeEach(() => {
        teamTaskRepository.findOne.mockResolvedValue(createTeamTask());
      });

      it('생성 알림에 붙인 태그를 팀 정렬 순서로 실어야 함', async () => {
        mockMember();
        manager.count.mockResolvedValue(2);
        manager.find.mockResolvedValue([linkRow(1, 2, '디자인'), linkRow(1, 1, '긴급')]);

        await service.createTask({ teamId: 1, createTaskDto: { taskName: '태그', taskDescription: '', tagIds: [1, 2] }, userId: 1 });

        expect(tagLines()).toEqual(['🏷️ 디자인 · 긴급']);
      });

      it('태그를 바꾼 수정 알림에 현재 태그와 추가·제거 줄을 실어야 함', async () => {
        mockMember();
        manager.count.mockResolvedValue(2);
        manager.find
          .mockResolvedValueOnce([linkRow(1, 1, '긴급'), linkRow(1, 9, '버그')]) // 교체 전
          .mockResolvedValueOnce([linkRow(1, 1, '긴급'), linkRow(1, 2, '디자인')]); // 교체 후

        await updateWithTags([1, 2]);

        expect(tagLines()).toEqual(['🏷️ 긴급 · 디자인', '➕ 추가: 디자인', '➖ 제거: 버그']);
      });

      it('태그를 모두 빼면 "태그 없음"과 제거 줄을 실어야 함', async () => {
        mockMember();
        manager.find.mockResolvedValueOnce([linkRow(1, 9, '버그')]).mockResolvedValueOnce([]);

        await updateWithTags([]);

        expect(tagLines()).toEqual(['🏷️ 태그 없음', '➖ 제거: 버그']);
      });

      it('태그가 그대로이거나 tagIds를 생략하면 현재 태그 줄만 실어야 함', async () => {
        mockMember();
        manager.count.mockResolvedValue(1);
        manager.find.mockResolvedValue([linkRow(1, 1, '긴급')]);

        await updateWithTags([1]);
        await updateWithTags(undefined);

        const lines = notificationPort.notifyTeam.mock.calls.map(
          ([params]) => (params as TeamNotificationParams).content.lines?.filter((line) => !line.startsWith('📅')),
        );
        expect(lines).toEqual([['🏷️ 긴급'], ['🏷️ 긴급']]);
      });
    });

    it('getTasksByTeamId는 태스크별 태그를 붙이고 태그가 없으면 빈 배열이어야 함', async () => {
      mockMember();
      teamRepository.findOne.mockResolvedValue(createTeam({ teamId: 1 }));
      jest
        .spyOn(service, 'getTeamTasksBy')
        .mockResolvedValue([createTeamTaskView({ taskId: 1 }), createTeamTaskView({ taskId: 2 })]);
      manager.find.mockResolvedValue([linkRow(1, 7, '긴급')]);

      const { tasks } = await service.getTasksByTeamId(1, 1);

      expect(tasks.map((task) => task.tags)).toEqual([[{ tagId: 7, tagName: '긴급', tagColor: '#F87171' }], []]);
      // 태스크 수와 무관하게 조회 1회 (N+1 아님)
      expect(manager.find).toHaveBeenCalledTimes(1);
    });
  });
});

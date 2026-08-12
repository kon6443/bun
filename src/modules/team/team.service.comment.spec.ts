import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TeamService, TeamMemberType } from './team.service';
import { Team } from '../../entities/Team';
import { TeamMember } from '../../entities/TeamMember';
import { TeamTask } from '../../entities/TeamTask';
import { TaskComment } from '../../entities/TaskComment';
import { TeamInvitation } from '../../entities/TeamInvitation';
import { User } from '../../entities/User';
import { NOTIFICATION_PORT } from '../../common/port/notification.port';
import { ActStatus } from '../../common/enums/task-status.enum';
import {
  createTaskComment,
  createTeamTask,
  createTeamTaskView,
  createTeamMemberView,
  FIXED_DATE,
} from '../../entities/__spec__/entity.factory';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import {
  TeamForbiddenErrorResponseDto,
  TeamTaskNotFoundErrorResponseDto,
  TeamTaskBadRequestErrorResponseDto,
  TeamCommentNotFoundErrorResponseDto,
  TeamCommentForbiddenErrorResponseDto,
} from './team-error.dto';

const DOMAIN = 'https://example.test';
const CONFIG: Record<string, string> = { NEXT_PUBLIC_DOMAIN: DOMAIN };

/** 댓글 소유자 */
const AUTHOR_ID = 1;
/** 같은 팀의 다른 멤버 */
const OTHER_ID = 2;

/**
 * TeamService의 댓글 CRUD를 검증한다.
 *
 * 세 메서드 모두 **팀 멤버 검증(`verifyTeamMemberAccess`)이 선행**하고, 수정·삭제는 그 위에
 * 작성자 검증 + 태스크·팀 소속 대조를 더한다. 멤버 검증이 작성자 검증보다 앞이라는 순서 자체가
 * 계약이다 — 뒤로 가면 남의 팀 댓글의 존재 여부가 404/403 차이로 새어나간다.
 *
 * 삭제는 물리 삭제가 아니라 `status = INACTIVE` 소프트 삭제이며, 삭제만 알림을 보내지 않는다.
 */
describe('TeamService — 댓글 CRUD', () => {
  let service: TeamService;
  let teamTaskRepository: MockRepository<TeamTask>;
  let taskCommentRepository: MockRepository<TaskComment>;
  let notificationPort: { notifyTeam: jest.Mock };

  beforeEach(async () => {
    teamTaskRepository = createMockRepository<TeamTask>();
    taskCommentRepository = createMockRepository<TaskComment>();
    notificationPort = { notifyTeam: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamService,
        {
          provide: getDataSourceToken(),
          useValue: { transaction: jest.fn() } as unknown as DataSource,
        },
        { provide: getRepositoryToken(Team), useValue: createMockRepository<Team>() },
        { provide: getRepositoryToken(TeamMember), useValue: createMockRepository<TeamMember>() },
        { provide: getRepositoryToken(TeamTask), useValue: teamTaskRepository },
        { provide: getRepositoryToken(TaskComment), useValue: taskCommentRepository },
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
    taskCommentRepository.create.mockImplementation((data) => data as TaskComment);
    taskCommentRepository.save.mockImplementation((entity) =>
      Promise.resolve(entity as TaskComment),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const mockMember = (member: TeamMemberType | null = createTeamMemberView()) =>
    jest.spyOn(service, 'getTeamMembersBy').mockResolvedValue(member ? [member] : []);

  /** save에 넘어간 엔티티 — 서비스가 "무엇을 저장하려 했는가"를 본다. */
  const savedComment = () => taskCommentRepository.save.mock.calls[0][0] as TaskComment;

  describe('createTaskComment', () => {
    const create = ({ teamId = 1, taskId = 1, userId = AUTHOR_ID, content = '새 댓글' } = {}) =>
      service.createTaskComment({
        teamId,
        taskId,
        createCommentDto: { commentContent: content },
        userId,
      });

    it('팀 멤버가 아니면 태스크를 조회하기도 전에 차단해야 함', async () => {
      mockMember(null);

      await expect(create()).rejects.toThrow(TeamForbiddenErrorResponseDto);
      expect(teamTaskRepository.findOne).not.toHaveBeenCalled();
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it('태스크를 팀 소속 조건과 함께 조회해야 함 (팀 격리)', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(createTeamTask({ taskId: 8, teamId: 3 }));

      await create({ teamId: 3, taskId: 8 });

      // teamId를 조건에서 빼면 남의 팀 태스크에 댓글을 달 수 있다
      expect(teamTaskRepository.findOne).toHaveBeenCalledWith({
        where: { taskId: 8, teamId: 3 },
      });
    });

    it('태스크가 없으면 TEAM_TASK_NOT_FOUND를 던져야 함', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(null);

      await expect(create()).rejects.toThrow(TeamTaskNotFoundErrorResponseDto);
      expect(taskCommentRepository.create).not.toHaveBeenCalled();
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it('활성 상태로 생성하며 commentId는 할당하지 않아야 함 (D27: DB IDENTITY)', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(createTeamTask());

      await create({ teamId: 3, taskId: 8, userId: OTHER_ID, content: '리뷰 부탁드립니다' });

      const created = taskCommentRepository.create.mock.calls[0][0] as Partial<TaskComment>;
      expect(created).toEqual({
        teamId: 3,
        taskId: 8,
        userId: OTHER_ID,
        commentContent: '리뷰 부탁드립니다',
        status: ActStatus.ACTIVE,
      });
      // GENERATED ALWAYS AS IDENTITY 컬럼에 값을 넣으면 ORA-32795로 INSERT가 거부된다
      expect(Object.keys(created)).not.toContain('commentId');
    });

    it('저장 결과를 반환해야 함', async () => {
      mockMember();
      teamTaskRepository.findOne.mockResolvedValue(createTeamTask());
      const persisted = createTaskComment({ commentId: 77, commentContent: '새 댓글' });
      taskCommentRepository.save.mockResolvedValue(persisted);

      await expect(create()).resolves.toBe(persisted);
    });

    it('팀 정보·댓글 내용·태스크 URL을 담아 알림을 보내야 함', async () => {
      const member = createTeamMemberView();
      mockMember(member);
      teamTaskRepository.findOne.mockResolvedValue(createTeamTask({ taskName: '배포 준비' }));

      await create({ teamId: 3, taskId: 8, content: '확인했습니다' });

      expect(notificationPort.notifyTeam).toHaveBeenCalledWith({
        team: member,
        message: ['[테스트팀] - 배포 준비', '💬 새로운 댓글이 등록되었습니다 💬', '확인했습니다'].join(
          '\n',
        ),
        url: `${DOMAIN}/teams/3/tasks/8`,
      });
    });
  });

  describe('updateTaskComment — 접근 제어', () => {
    const update = ({
      teamId = 1,
      taskId = 1,
      commentId = 1,
      userId = AUTHOR_ID,
      content = '수정된 내용',
    } = {}) =>
      service.updateTaskComment({
        teamId,
        taskId,
        commentId,
        updateCommentDto: { commentContent: content },
        userId,
      });

    beforeEach(() => mockMember());

    it('팀 멤버가 아니면 댓글을 조회하기도 전에 차단해야 함 (탈퇴자·비활성 팀)', async () => {
      mockMember(null);

      await expect(update()).rejects.toThrow(TeamForbiddenErrorResponseDto);
      // 작성자여도 통과하지 못한다 — 조회조차 하지 않는 것이 계약
      expect(taskCommentRepository.findOne).not.toHaveBeenCalled();
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it('댓글이 없으면 TEAM_COMMENT_NOT_FOUND를 던져야 함', async () => {
      taskCommentRepository.findOne.mockResolvedValue(null);

      await expect(update()).rejects.toThrow(TeamCommentNotFoundErrorResponseDto);
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it('작성자가 아니면 차단해야 함', async () => {
      taskCommentRepository.findOne.mockResolvedValue(
        createTaskComment({ userId: AUTHOR_ID }),
      );

      await expect(update({ userId: OTHER_ID })).rejects.toThrow(
        TeamCommentForbiddenErrorResponseDto,
      );
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it('작성자 검증이 소속 검증보다 먼저여야 함 (남의 댓글 존재 여부를 400으로 흘리지 않는다)', async () => {
      // 작성자도 아니고 태스크 소속도 다른 댓글 → 먼저 걸리는 쪽이 403
      taskCommentRepository.findOne.mockResolvedValue(
        createTaskComment({ userId: AUTHOR_ID, taskId: 99, teamId: 99 }),
      );

      await expect(update({ userId: OTHER_ID })).rejects.toThrow(
        TeamCommentForbiddenErrorResponseDto,
      );
    });

    it.each([
      ['태스크', { taskId: 99 }],
      ['팀', { teamId: 99 }],
    ])('%s 소속이 다르면 차단해야 함', async (_label, mismatch) => {
      taskCommentRepository.findOne.mockResolvedValue(
        createTaskComment({ userId: AUTHOR_ID, ...mismatch }),
      );

      await expect(update()).rejects.toThrow(TeamTaskBadRequestErrorResponseDto);
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it('삭제된 댓글은 수정할 수 없어야 함', async () => {
      taskCommentRepository.findOne.mockResolvedValue(
        createTaskComment({ userId: AUTHOR_ID, status: ActStatus.INACTIVE }),
      );

      await expect(update()).rejects.toThrow(TeamTaskBadRequestErrorResponseDto);
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it('태스크가 조회되지 않으면 TEAM_TASK_NOT_FOUND를 던져야 함', async () => {
      taskCommentRepository.findOne.mockResolvedValue(createTaskComment({ userId: AUTHOR_ID }));
      jest.spyOn(service, 'getTeamTasksBy').mockResolvedValue([]);

      await expect(update()).rejects.toThrow(TeamTaskNotFoundErrorResponseDto);
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it('멤버 검증이 작성자 검증보다 먼저여야 함', async () => {
      mockMember(null);
      // 작성자가 아닌 댓글이지만, 멤버가 아니므로 TEAM_FORBIDDEN이 먼저 나와야 한다
      taskCommentRepository.findOne.mockResolvedValue(createTaskComment({ userId: AUTHOR_ID }));

      await expect(update({ userId: OTHER_ID })).rejects.toThrow(TeamForbiddenErrorResponseDto);
    });
  });

  describe('updateTaskComment — 수정', () => {
    const updateWith = (dto: { commentContent?: string }) =>
      service.updateTaskComment({
        teamId: 1,
        taskId: 1,
        commentId: 1,
        updateCommentDto: dto,
        userId: AUTHOR_ID,
      });

    beforeEach(() => {
      mockMember();
      taskCommentRepository.findOne.mockResolvedValue(
        createTaskComment({ userId: AUTHOR_ID, commentContent: '원본 내용', mdfdAt: null }),
      );
      jest.spyOn(service, 'getTeamTasksBy').mockResolvedValue([createTeamTaskView()]);
    });

    it('내용과 수정 시각을 갱신해야 함', async () => {
      const before = Date.now();

      const result = await updateWith({ commentContent: '수정된 내용' });

      expect(savedComment().commentContent).toBe('수정된 내용');
      expect(result.mdfdAt).toBeInstanceOf(Date);
      // 실행 시간 오차를 감안해 ±5초 이내인지 확인
      expect(Math.abs((result.mdfdAt as Date).getTime() - before)).toBeLessThan(5_000);
    });

    it('내용이 없으면 기존 내용을 유지하되 수정 시각은 갱신해야 함', async () => {
      const result = await updateWith({});

      expect(result.commentContent).toBe('원본 내용');
      expect(result.mdfdAt).toBeInstanceOf(Date);
    });

    it('해당 태스크·팀으로 좁혀 태스크를 조회해야 함', async () => {
      taskCommentRepository.findOne.mockResolvedValue(
        createTaskComment({ userId: AUTHOR_ID, teamId: 3, taskId: 8 }),
      );
      const spy = jest.spyOn(service, 'getTeamTasksBy');

      await service.updateTaskComment({
        teamId: 3,
        taskId: 8,
        commentId: 1,
        updateCommentDto: { commentContent: 'x' },
        userId: AUTHOR_ID,
      });

      expect(spy).toHaveBeenCalledWith({ taskIds: [8], teamIds: [3] });
    });

    it('알림 대상 팀 정보는 조회한 태스크에서 가져와야 함', async () => {
      jest.spyOn(service, 'getTeamTasksBy').mockResolvedValue([
        createTeamTaskView({
          teamId: 3,
          teamName: '알림팀',
          taskName: '배포 준비',
          telegramChatId: 555,
          discordWebhookUrl: 'https://discord.test/hook',
        }),
      ]);

      await updateWith({ commentContent: '수정된 내용' });

      expect(notificationPort.notifyTeam).toHaveBeenCalledWith({
        team: {
          teamId: 3,
          teamName: '알림팀',
          telegramChatId: 555,
          discordWebhookUrl: 'https://discord.test/hook',
        },
        message: [
          '[알림팀]',
          '💬 배포 준비 태스크에 댓글이 수정되었습니다 💬',
          '수정된 내용',
        ].join('\n'),
        url: `${DOMAIN}/teams/1/tasks/1`,
      });
    });
  });

  describe('deleteTaskComment', () => {
    const remove = ({ teamId = 1, taskId = 1, commentId = 1, userId = AUTHOR_ID } = {}) =>
      service.deleteTaskComment({ teamId, taskId, commentId, userId });

    beforeEach(() => mockMember());

    it('팀 멤버가 아니면 댓글을 조회하기도 전에 차단해야 함 (탈퇴자·비활성 팀)', async () => {
      mockMember(null);

      await expect(remove()).rejects.toThrow(TeamForbiddenErrorResponseDto);
      expect(taskCommentRepository.findOne).not.toHaveBeenCalled();
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it('댓글이 없으면 TEAM_COMMENT_NOT_FOUND를 던져야 함', async () => {
      taskCommentRepository.findOne.mockResolvedValue(null);

      await expect(remove()).rejects.toThrow(TeamCommentNotFoundErrorResponseDto);
    });

    it('작성자가 아니면 차단해야 함', async () => {
      taskCommentRepository.findOne.mockResolvedValue(createTaskComment({ userId: AUTHOR_ID }));

      await expect(remove({ userId: OTHER_ID })).rejects.toThrow(
        TeamCommentForbiddenErrorResponseDto,
      );
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it.each([
      ['태스크', { taskId: 99 }],
      ['팀', { teamId: 99 }],
    ])('%s 소속이 다르면 차단해야 함', async (_label, mismatch) => {
      taskCommentRepository.findOne.mockResolvedValue(
        createTaskComment({ userId: AUTHOR_ID, ...mismatch }),
      );

      await expect(remove()).rejects.toThrow(TeamTaskBadRequestErrorResponseDto);
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it('이미 삭제된 댓글은 다시 삭제할 수 없어야 함', async () => {
      taskCommentRepository.findOne.mockResolvedValue(
        createTaskComment({ userId: AUTHOR_ID, status: ActStatus.INACTIVE }),
      );

      await expect(remove()).rejects.toThrow(TeamTaskBadRequestErrorResponseDto);
      expect(taskCommentRepository.save).not.toHaveBeenCalled();
    });

    it('물리 삭제가 아니라 status를 비활성으로 바꾸는 소프트 삭제여야 함', async () => {
      taskCommentRepository.findOne.mockResolvedValue(
        createTaskComment({ userId: AUTHOR_ID, mdfdAt: FIXED_DATE }),
      );
      const before = Date.now();

      await expect(remove()).resolves.toBeUndefined();

      expect(savedComment().status).toBe(ActStatus.INACTIVE);
      expect(Math.abs(savedComment().mdfdAt!.getTime() - before)).toBeLessThan(5_000);
      // 물리 삭제하면 태스크 상세의 댓글 이력이 통째로 사라진다
      expect(taskCommentRepository.delete).not.toHaveBeenCalled();
      expect(taskCommentRepository.remove).not.toHaveBeenCalled();
    });

    it('멤버 검증이 작성자 검증보다 먼저여야 함', async () => {
      mockMember(null);
      taskCommentRepository.findOne.mockResolvedValue(createTaskComment({ userId: AUTHOR_ID }));

      await expect(remove({ userId: OTHER_ID })).rejects.toThrow(TeamForbiddenErrorResponseDto);
    });

    it('알림을 보내지 않아야 함 (삭제 알림은 노이즈라 의도적으로 생략)', async () => {
      taskCommentRepository.findOne.mockResolvedValue(createTaskComment({ userId: AUTHOR_ID }));

      await remove();

      // 생성·수정과의 의도적 차이 — 알림이 추가되면 이 테스트가 먼저 깨진다
      expect(notificationPort.notifyTeam).not.toHaveBeenCalled();
    });
  });
});

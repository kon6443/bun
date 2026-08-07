import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { verify, JwtPayload } from 'jsonwebtoken';
import { TeamService } from './team.service';
import { Team } from '../../entities/Team';
import { TeamMember } from '../../entities/TeamMember';
import { TeamTask } from '../../entities/TeamTask';
import { TaskComment } from '../../entities/TaskComment';
import { TeamInvitation } from '../../entities/TeamInvitation';
import { User } from '../../entities/User';
import { NOTIFICATION_PORT } from '../../common/port/notification.port';
import { ActStatus } from '../../common/enums/task-status.enum';
import {
  createTeamInvitation,
  createTeamMember,
  createTeamMemberView,
} from '../../entities/__spec__/entity.factory';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../common/__spec__/mock-repository';
import { AuthUnauthorizedErrorResponseDto } from '../auth/auth-error.dto';
import {
  TeamInviteForbiddenErrorResponseDto,
  TeamInviteExpiredErrorResponseDto,
  TeamInviteNotFoundErrorResponseDto,
  TeamMemberAlreadyExistsErrorResponseDto,
  TeamTaskBadRequestErrorResponseDto,
} from './team-error.dto';

const SECRET = 'test-jwt-secret';
const CONFIG: Record<string, string> = {
  JWT_SECRET: SECRET,
  NEXT_PUBLIC_DOMAIN: 'https://example.test',
};

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000);

/**
 * TeamService의 초대 플로우만 분리해 검증한다.
 * TeamService는 1,520줄이라 D1(분리) 전에는 도메인 단위로 spec 파일을 나눈다.
 *
 * `getTeamMembersBy`는 같은 서비스의 쿼리 헬퍼이므로 spy로 격리한다 —
 * 목적은 "권한 판정과 토큰 생성"이지 쿼리 조립이 아니다.
 */
describe('TeamService — 초대 플로우', () => {
  let service: TeamService;
  let teamMemberRepository: MockRepository<TeamMember>;
  let teamInvitationRepository: MockRepository<TeamInvitation>;
  let manager: { createQueryBuilder: jest.Mock; update: jest.Mock; create: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    teamMemberRepository = createMockRepository<TeamMember>();
    teamInvitationRepository = createMockRepository<TeamInvitation>();

    manager = {
      createQueryBuilder: jest.fn(),
      update: jest.fn(),
      create: jest.fn((_entity, data) => data),
      save: jest.fn(),
    };
    // 실제 트랜잭션 대신 콜백을 즉시 실행 — 롤백 검증이 아니라 로직 검증이 목적
    dataSource = {
      transaction: jest.fn((cb: (m: EntityManager) => Promise<void>) =>
        cb(manager as unknown as EntityManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamService,
        { provide: getDataSourceToken(), useValue: dataSource as unknown as DataSource },
        { provide: getRepositoryToken(Team), useValue: createMockRepository<Team>() },
        { provide: getRepositoryToken(TeamMember), useValue: teamMemberRepository },
        { provide: getRepositoryToken(TeamTask), useValue: createMockRepository<TeamTask>() },
        { provide: getRepositoryToken(TaskComment), useValue: createMockRepository<TaskComment>() },
        { provide: getRepositoryToken(TeamInvitation), useValue: teamInvitationRepository },
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: ConfigService, useValue: { get: jest.fn((k: string) => CONFIG[k]) } },
        { provide: NOTIFICATION_PORT, useValue: { notifyTeam: jest.fn() } },
      ],
    }).compile();

    service = module.get(TeamService);
  });

  afterEach(() => jest.restoreAllMocks());

  /**
   * getTeamMembersBy를 특정 역할의 멤버 1명으로 고정.
   * 반환은 Entity가 아니라 flatten된 쿼리 결과(TeamMemberType)여야 한다 —
   * Entity factory를 캐스팅해 넣으면 shape 불일치가 조용히 숨는다.
   */
  const mockMemberRole = (role: string | null) =>
    jest
      .spyOn(service, 'getTeamMembersBy')
      .mockResolvedValue(role === null ? [] : [createTeamMemberView({ role })]);

  describe('createTeamInvite — 권한', () => {
    it.each([
      ['MASTER', true],
      ['MANAGER', true],
      ['MEMBER', false],
    ])('%s의 초대 생성 허용 여부: %s', async (role, allowed) => {
      mockMemberRole(role);

      const promise = service.createTeamInvite({
        teamId: 1,
        userId: 1,
        createInviteDto: { endAt: hoursFromNow(24), usageMaxCnt: 1 },
      });

      if (allowed) {
        await expect(promise).resolves.toHaveProperty('inviteLink');
      } else {
        await expect(promise).rejects.toThrow(TeamInviteForbiddenErrorResponseDto);
      }
    });

    it('팀 멤버가 아니면 차단해야 함', async () => {
      mockMemberRole(null);

      await expect(
        service.createTeamInvite({
          teamId: 1,
          userId: 1,
          createInviteDto: { endAt: hoursFromNow(24), usageMaxCnt: 1 },
        }),
      ).rejects.toThrow(TeamInviteForbiddenErrorResponseDto);
    });

    it('활성 팀·활성 유저 조건으로만 멤버를 조회해야 함', async () => {
      const spy = mockMemberRole('MASTER');

      await service.createTeamInvite({
        teamId: 5,
        userId: 9,
        createInviteDto: { endAt: hoursFromNow(24), usageMaxCnt: 1 },
      });

      expect(spy).toHaveBeenCalledWith({
        teamIds: [5],
        userIds: [9],
        actStatus: [ActStatus.ACTIVE],
        userActStatus: [ActStatus.ACTIVE],
      });
    });

    it.each([
      ['userId 없음', { teamId: 1, userId: 0 }, AuthUnauthorizedErrorResponseDto],
      ['teamId 없음', { teamId: 0, userId: 1 }, TeamTaskBadRequestErrorResponseDto],
    ])('%s → 조회 전에 차단', async (_desc, args, expected) => {
      const spy = mockMemberRole('MASTER');

      await expect(
        service.createTeamInvite({
          ...args,
          createInviteDto: { endAt: hoursFromNow(24), usageMaxCnt: 1 },
        }),
      ).rejects.toThrow(expected);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('createTeamInvite — 만료 시간 검증', () => {
    it.each([
      ['과거 시각', hoursFromNow(-1)],
      ['현재와 동일 취급(1초 전)', new Date(Date.now() - 1000)],
      ['7일 초과 (8일)', hoursFromNow(8 * 24)],
    ])('%s → TeamInviteExpiredErrorResponseDto', async (_desc, endAt) => {
      mockMemberRole('MASTER');

      await expect(
        service.createTeamInvite({
          teamId: 1,
          userId: 1,
          createInviteDto: { endAt, usageMaxCnt: 1 },
        }),
      ).rejects.toThrow(TeamInviteExpiredErrorResponseDto);
      expect(teamInvitationRepository.save).not.toHaveBeenCalled();
    });

    it.each([
      ['1시간 후', hoursFromNow(1)],
      ['7일 직전', hoursFromNow(7 * 24 - 1)],
    ])('%s → 허용', async (_desc, endAt) => {
      mockMemberRole('MASTER');

      await expect(
        service.createTeamInvite({
          teamId: 1,
          userId: 1,
          createInviteDto: { endAt, usageMaxCnt: 1 },
        }),
      ).resolves.toHaveProperty('inviteLink');
    });
  });

  describe('createTeamInvite — 토큰 생성', () => {
    /** 저장 호출에서 생성된 토큰을 꺼낸다 */
    const savedToken = (): string => {
      const created = teamInvitationRepository.create.mock.calls[0][0] as { token: string };
      return created.token;
    };

    beforeEach(() => {
      teamInvitationRepository.create.mockImplementation((data) => data as TeamInvitation);
      mockMemberRole('MASTER');
    });

    it('토큰 payload에 teamId·userId가 담겨야 함', async () => {
      await service.createTeamInvite({
        teamId: 3,
        userId: 8,
        createInviteDto: { endAt: hoursFromNow(24), usageMaxCnt: 1 },
      });

      const payload = verify(savedToken(), SECRET) as JwtPayload & {
        teamId: number;
        userId: number;
      };
      expect(payload.teamId).toBe(3);
      expect(payload.userId).toBe(8);
    });

    /**
     * 회귀 방어(D23): payload에 jti가 없으면 같은 팀·유저가 1초 안에 두 번 요청할 때
     * 완전히 동일한 JWT가 나온다. TOKEN에 유니크 인덱스가 있으므로 두 번째는 ORA-00001로 실패한다.
     */
    it('토큰에 jti(nonce)가 있어 같은 조건에서도 매번 달라야 함', async () => {
      const args = {
        teamId: 1,
        userId: 1,
        createInviteDto: { endAt: hoursFromNow(24), usageMaxCnt: 1 },
      };

      await service.createTeamInvite(args);
      const first = savedToken();
      teamInvitationRepository.create.mockClear();
      await service.createTeamInvite(args);
      const second = savedToken();

      const firstPayload = verify(first, SECRET) as JwtPayload;
      expect(firstPayload.jti).toBeTruthy();
      expect(first).not.toBe(second);
    });

    it('초대 링크는 프론트 도메인 + token 쿼리로 만들어야 함', async () => {
      const result = await service.createTeamInvite({
        teamId: 1,
        userId: 1,
        createInviteDto: { endAt: hoursFromNow(24), usageMaxCnt: 1 },
      });

      expect(result.inviteLink).toContain('https://example.test');
      expect(result.inviteLink).toContain(`token=${savedToken()}`);
    });

    it('usageCurCnt는 0, actStatus는 ACTIVE로 저장해야 함', async () => {
      await service.createTeamInvite({
        teamId: 1,
        userId: 1,
        createInviteDto: { endAt: hoursFromNow(24), usageMaxCnt: 5 },
      });

      expect(teamInvitationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ usageCurCnt: 0, usageMaxCnt: 5, actStatus: ActStatus.ACTIVE }),
      );
    });
  });

  describe('acceptTeamInvite', () => {
    const VALID_TOKEN = 'valid-token';

    /** verifyTeamInviteToken을 통과한 상태로 고정 */
    const mockVerified = (teamId = 1) =>
      jest.spyOn(service, 'verifyTeamInviteToken').mockResolvedValue({
        teamId,
        teamName: '테스트팀',
        userId: 1,
        endAt: hoursFromNow(24),
        usageMaxCnt: 5,
        usageCurCnt: 0,
        actStatus: ActStatus.ACTIVE,
      });

    it('비회원(userId null)은 토큰 검증 전에 차단해야 함', async () => {
      const spy = mockVerified();

      await expect(
        service.acceptTeamInvite({ token: VALID_TOKEN, userId: null }),
      ).rejects.toThrow(AuthUnauthorizedErrorResponseDto);
      expect(spy).not.toHaveBeenCalled();
    });

    it('신규 멤버는 MEMBER 역할로 생성하고 사용 횟수를 증가시켜야 함', async () => {
      mockVerified();
      teamMemberRepository.findOne.mockResolvedValue(null);
      const invite = createTeamInvitation({ usageCurCnt: 0, usageMaxCnt: 5 });
      manager.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getOne: invite }));

      const result = await service.acceptTeamInvite({ token: VALID_TOKEN, userId: 20 });

      expect(result.message).toBe('팀에 성공적으로 가입했습니다.');
      expect(manager.create).toHaveBeenCalledWith(
        TeamMember,
        expect.objectContaining({ userId: 20, teamId: 1, role: 'MEMBER', actStatus: ActStatus.ACTIVE }),
      );
      expect(invite.usageCurCnt).toBe(1);
      expect(manager.save).toHaveBeenCalledWith(TeamInvitation, invite);
    });

    it('동시성 제어를 위해 pessimistic_write 락을 걸어야 함', async () => {
      mockVerified();
      teamMemberRepository.findOne.mockResolvedValue(null);
      const qb = createMockQueryBuilder({ getOne: createTeamInvitation() });
      manager.createQueryBuilder.mockReturnValue(qb);

      await service.acceptTeamInvite({ token: VALID_TOKEN, userId: 20 });

      // 락 없이 조회하면 동시 요청이 사용 횟수를 함께 통과해 초과 가입이 발생한다
      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it('이미 활성 멤버면 중복 가입을 차단해야 함', async () => {
      mockVerified();
      teamMemberRepository.findOne.mockResolvedValue(
        createTeamMember({ actStatus: ActStatus.ACTIVE }),
      );
      manager.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ getOne: createTeamInvitation() }),
      );

      await expect(
        service.acceptTeamInvite({ token: VALID_TOKEN, userId: 20 }),
      ).rejects.toThrow(TeamMemberAlreadyExistsErrorResponseDto);
      expect(manager.create).not.toHaveBeenCalled();
    });

    it('비활성 멤버는 MEMBER 역할로 초기화하며 재활성화해야 함', async () => {
      mockVerified();
      teamMemberRepository.findOne.mockResolvedValue(
        createTeamMember({ actStatus: ActStatus.INACTIVE, role: 'MANAGER' }),
      );
      manager.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ getOne: createTeamInvitation() }),
      );

      const result = await service.acceptTeamInvite({ token: VALID_TOKEN, userId: 20 });

      expect(result.message).toBe('팀에 다시 가입했습니다.');
      // 재가입 시 이전 역할(MANAGER)을 물려받으면 권한이 새어나간다
      expect(manager.update).toHaveBeenCalledWith(
        TeamMember,
        { teamId: 1, userId: 20 },
        expect.objectContaining({ actStatus: ActStatus.ACTIVE, role: 'MEMBER' }),
      );
      expect(manager.create).not.toHaveBeenCalled();
    });

    it('락을 건 상태에서 초대를 못 찾으면 차단해야 함', async () => {
      mockVerified();
      teamMemberRepository.findOne.mockResolvedValue(null);
      manager.createQueryBuilder.mockReturnValue(createMockQueryBuilder({ getOne: null }));

      await expect(
        service.acceptTeamInvite({ token: VALID_TOKEN, userId: 20 }),
      ).rejects.toThrow(TeamInviteNotFoundErrorResponseDto);
    });

    it.each([
      ['정확히 소진', 1, 1],
      ['초과 상태', 3, 2],
    ])('사용 횟수 %s(cur=%i, max=%i)면 차단해야 함', async (_desc, cur, max) => {
      mockVerified();
      teamMemberRepository.findOne.mockResolvedValue(null);
      manager.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getOne: createTeamInvitation({ usageCurCnt: cur, usageMaxCnt: max }),
        }),
      );

      await expect(
        service.acceptTeamInvite({ token: VALID_TOKEN, userId: 20 }),
      ).rejects.toThrow(TeamInviteExpiredErrorResponseDto);
      expect(manager.create).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });
  });
});

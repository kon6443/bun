import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { sign, verify, JwtPayload } from 'jsonwebtoken';
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
  createTeam,
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
  TeamNotFoundErrorResponseDto,
  TeamTaskBadRequestErrorResponseDto,
} from './team-error.dto';
import { AuthInvalidTokenErrorResponseDto } from '../auth/auth-error.dto';

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
  let teamRepository: MockRepository<Team>;
  let teamMemberRepository: MockRepository<TeamMember>;
  let teamInvitationRepository: MockRepository<TeamInvitation>;
  let configService: { get: jest.Mock };
  let manager: { createQueryBuilder: jest.Mock; update: jest.Mock; create: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    teamRepository = createMockRepository<Team>();
    teamMemberRepository = createMockRepository<TeamMember>();
    teamInvitationRepository = createMockRepository<TeamInvitation>();
    configService = { get: jest.fn((k: string) => CONFIG[k]) };

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
        { provide: getRepositoryToken(Team), useValue: teamRepository },
        { provide: getRepositoryToken(TeamMember), useValue: teamMemberRepository },
        { provide: getRepositoryToken(TeamTask), useValue: createMockRepository<TeamTask>() },
        { provide: getRepositoryToken(TaskComment), useValue: createMockRepository<TaskComment>() },
        { provide: getRepositoryToken(TeamInvitation), useValue: teamInvitationRepository },
        { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
        { provide: ConfigService, useValue: configService },
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

  /**
   * 초대 링크를 연 사람에게 팀 정보를 보여주기 전 관문이다.
   * JWT만 통과하면 되는 게 아니라 **DB 상태(활성 초대·만료·팀 활성·사용 횟수)** 를 모두 본다 —
   * 토큰은 발급 후 바뀌지 않으므로, 초대 회수·팀 비활성화가 먹히려면 DB 검증이 살아 있어야 한다.
   */
  describe('verifyTeamInviteToken', () => {
    const TEAM_ID = 7;
    const INVITER_ID = 3;

    const makeToken = (payload: Record<string, unknown> = {}, options = {}) =>
      sign({ teamId: TEAM_ID, userId: INVITER_ID, ...payload }, SECRET, {
        expiresIn: '1h',
        ...options,
      });

    /** DB에 유효한 초대 + 활성 팀이 있는 상태로 고정 */
    const mockValidInvite = (overrides: Partial<TeamInvitation> = {}) => {
      // factory 기본 endAt은 FIXED_DATE 기준이라 이미 과거다 — 유효 케이스는 반드시 덮어쓴다
      const invite = createTeamInvitation({
        teamId: TEAM_ID,
        userId: INVITER_ID,
        endAt: hoursFromNow(24),
        ...overrides,
      });
      teamInvitationRepository.findOne.mockResolvedValue(invite);
      teamRepository.findOne.mockResolvedValue(
        createTeam({ teamId: TEAM_ID, teamName: '초대팀' }),
      );
      return invite;
    };

    it('JWT_SECRET이 없으면 DB를 보기 전에 차단해야 함', async () => {
      configService.get.mockReturnValue(undefined);

      await expect(service.verifyTeamInviteToken(makeToken())).rejects.toThrow(
        AuthInvalidTokenErrorResponseDto,
      );
      expect(teamInvitationRepository.findOne).not.toHaveBeenCalled();
    });

    it.each([
      ['다른 시크릿으로 서명된 토큰', sign({ teamId: TEAM_ID, userId: INVITER_ID }, 'other-secret')],
      ['만료된 토큰', sign({ teamId: TEAM_ID, userId: INVITER_ID }, SECRET, { expiresIn: '-1h' })],
      ['토큰 형식이 아닌 문자열', 'not-a-jwt'],
    ])('%s는 만료로 처리해야 함', async (_desc, token) => {
      await expect(service.verifyTeamInviteToken(token)).rejects.toThrow(
        TeamInviteExpiredErrorResponseDto,
      );
      // 위조와 만료를 구분해 알려주지 않는다 (토큰 유효성 탐색 방지)
      expect(teamInvitationRepository.findOne).not.toHaveBeenCalled();
    });

    it('초대 조회는 payload의 teamId + 토큰 + 활성 상태를 모두 걸어야 함', async () => {
      mockValidInvite();

      await service.verifyTeamInviteToken(makeToken());

      // actStatus가 빠지면 회수(비활성화)된 초대가 되살아난다
      expect(teamInvitationRepository.findOne).toHaveBeenCalledWith({
        where: { teamId: TEAM_ID, token: expect.any(String), actStatus: ActStatus.ACTIVE },
      });
    });

    it('토큰의 teamId를 위조하면 조회 단계에서 걸러져야 함', async () => {
      // findOne이 teamId 조건을 실제로 반영하도록 흉내낸다.
      // 서비스가 조회 조건에서 teamId를 빼면 위조 토큰으로도 초대가 반환되어 이 테스트가 깨진다 —
      // teamId 검증은 별도 분기가 아니라 이 조회 조건 자체가 담당한다.
      const invite = createTeamInvitation({ teamId: TEAM_ID, endAt: hoursFromNow(24) });
      teamInvitationRepository.findOne.mockImplementation(async (options) => {
        const where = options?.where as { teamId: number };
        return where.teamId === TEAM_ID ? invite : null;
      });

      await expect(service.verifyTeamInviteToken(makeToken({ teamId: 999 }))).rejects.toThrow(
        TeamInviteNotFoundErrorResponseDto,
      );
    });

    it('DB에 초대가 없으면 NOT_FOUND를 던져야 함', async () => {
      teamInvitationRepository.findOne.mockResolvedValue(null);

      await expect(service.verifyTeamInviteToken(makeToken())).rejects.toThrow(
        TeamInviteNotFoundErrorResponseDto,
      );
    });

    it('JWT가 유효해도 DB의 endAt이 지났으면 만료여야 함', async () => {
      // 두 만료가 독립이라는 것이 핵심 — 만료 시각은 DB가 SSOT다
      mockValidInvite({ endAt: hoursFromNow(-1) });

      await expect(service.verifyTeamInviteToken(makeToken())).rejects.toThrow(
        TeamInviteExpiredErrorResponseDto,
      );
      expect(teamRepository.findOne).not.toHaveBeenCalled();
    });

    it('팀이 없거나 비활성이면 차단해야 함', async () => {
      mockValidInvite();
      teamRepository.findOne.mockResolvedValue(null);

      await expect(service.verifyTeamInviteToken(makeToken())).rejects.toThrow(
        TeamNotFoundErrorResponseDto,
      );
      expect(teamRepository.findOne).toHaveBeenCalledWith({
        where: { teamId: TEAM_ID, actStatus: ActStatus.ACTIVE },
      });
    });

    it.each([
      ['정확히 소진', 1, 1],
      ['초과 상태', 3, 2],
    ])('사용 횟수 %s(cur=%i, max=%i)면 만료로 처리해야 함', async (_desc, cur, max) => {
      mockValidInvite({ usageCurCnt: cur, usageMaxCnt: max });

      await expect(service.verifyTeamInviteToken(makeToken())).rejects.toThrow(
        TeamInviteExpiredErrorResponseDto,
      );
    });

    it('남은 횟수가 있으면 통과해야 함 (경계값 cur < max)', async () => {
      mockValidInvite({ usageCurCnt: 1, usageMaxCnt: 2 });

      await expect(service.verifyTeamInviteToken(makeToken())).resolves.toMatchObject({
        usageCurCnt: 1,
        usageMaxCnt: 2,
      });
    });

    it('통과 시 DB 기준 팀 정보와 토큰의 초대자 ID를 반환해야 함', async () => {
      const invite = mockValidInvite();

      await expect(service.verifyTeamInviteToken(makeToken())).resolves.toEqual({
        teamId: TEAM_ID,
        teamName: '초대팀',
        userId: INVITER_ID,
        endAt: invite.endAt,
        usageMaxCnt: invite.usageMaxCnt,
        usageCurCnt: invite.usageCurCnt,
        actStatus: ActStatus.ACTIVE,
      });
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

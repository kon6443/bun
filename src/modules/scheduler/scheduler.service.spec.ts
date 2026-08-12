import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { In, LessThan } from 'typeorm';
import { SchedulerService } from './scheduler.service';
import { User } from '../../entities/User';
import { TeamTask } from '../../entities/TeamTask';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { ActStatus, TaskStatus } from '../../common/enums/task-status.enum';

/**
 * 이 서비스의 가장 중요한 계약은 **실행 게이트**다.
 * 백엔드는 Swarm에서 3 replicas로 돌기 때문에, TASK_SLOT 가드가 무너지면
 * 모든 크론이 replica 수만큼 중복 실행된다(자동 아카이브가 3번 도는 등).
 * ENV·TASK_SLOT은 생성자에서 읽으므로 조합마다 인스턴스를 새로 만들어 검증한다.
 */
describe('SchedulerService', () => {
  let userRepository: MockRepository<User>;
  let teamTaskRepository: MockRepository<TeamTask>;

  const buildService = async (env?: string, taskSlot?: string): Promise<SchedulerService> => {
    userRepository = createMockRepository<User>();
    teamTaskRepository = createMockRepository<TeamTask>();

    const config: Record<string, string | undefined> = { ENV: env, TASK_SLOT: taskSlot };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: ConfigService, useValue: { get: jest.fn((key: string) => config[key]) } },
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(TeamTask), useValue: teamTaskRepository },
      ],
    }).compile();

    const service = module.get<SchedulerService>(SchedulerService);

    // NestJS가 모듈 초기화 시 남기는 로그("RootTestModule dependencies initialized")를 비운다.
    // 이걸 남겨두면 "서비스가 로그를 남기지 않아야 함" 검증이 프레임워크 로그에 오염된다.
    (Logger.prototype.log as jest.Mock).mockClear();

    return service;
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('실행 게이트 — 리더 replica(TASK_SLOT=1)에서만 동작해야 함', () => {
    it.each([
      ['QA', '1'],
      ['PROD', '1'],
      // 소문자 env도 대문자로 정규화되어 통과해야 한다
      ['prod', '1'],
      ['qa', '1'],
      // TASK_SLOT 미설정 시 기본값 1 → 단일 인스턴스 환경에서도 크론이 돌아야 한다
      ['PROD', undefined],
    ])('ENV=%s, TASK_SLOT=%s → 실행됨', async (env, taskSlot) => {
      const service = await buildService(env, taskSlot);
      teamTaskRepository.update.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });

      await service.handleDoTrash();
      await service.handleAutoArchiveTasks();

      expect(userRepository.count).toHaveBeenCalled();
      expect(teamTaskRepository.update).toHaveBeenCalled();
    });

    it.each([
      // 리더가 아닌 replica — 여기서 실행되면 중복이다
      ['PROD', '2'],
      ['PROD', '3'],
      ['QA', '2'],
      // 스케줄러 대상 환경이 아님
      ['LOCAL', '1'],
      ['DEV', '1'],
      ['', '1'],
      [undefined, '1'],
    ])('ENV=%s, TASK_SLOT=%s → 실행되지 않음', async (env, taskSlot) => {
      const service = await buildService(env, taskSlot);

      await service.handleDoTrash();
      await service.handleCpuIntensiveLoop();
      await service.handleAutoArchiveTasks();

      expect(userRepository.count).not.toHaveBeenCalled();
      expect(teamTaskRepository.update).not.toHaveBeenCalled();
    });

    it('TASK_SLOT이 숫자로 파싱되지 않으면 기본값 1로 취급해 실행해야 함', async () => {
      const service = await buildService('PROD', 'not-a-number');

      await service.handleDoTrash();

      expect(userRepository.count).toHaveBeenCalled();
    });
  });

  describe('handleAutoArchiveTasks', () => {
    it('완료·취소 상태이고 14일 경과한 활성 태스크만 비활성화해야 함', async () => {
      const service = await buildService('PROD', '1');
      teamTaskRepository.update.mockResolvedValue({ affected: 3, raw: [], generatedMaps: [] });

      await service.handleAutoArchiveTasks();

      const [criteria, patch] = teamTaskRepository.update.mock.calls[0];
      expect(criteria).toEqual({
        actStatus: ActStatus.ACTIVE,
        taskStatus: In([TaskStatus.COMPLETED, TaskStatus.CANCELLED]),
        completedAt: expect.anything(),
      });
      expect(patch).toEqual({ actStatus: ActStatus.INACTIVE });
    });

    it('cutoff는 현재 시각 기준 14일 전이어야 함', async () => {
      const service = await buildService('PROD', '1');
      teamTaskRepository.update.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });
      const before = Date.now();

      await service.handleAutoArchiveTasks();

      const criteria = teamTaskRepository.update.mock.calls[0][0] as {
        completedAt: ReturnType<typeof LessThan>;
      };
      const cutoff = (criteria.completedAt.value as Date).getTime();
      const expected = before - 14 * 24 * 60 * 60 * 1000;

      // 실행 시간 오차를 감안해 ±5초 이내인지 확인
      expect(Math.abs(cutoff - expected)).toBeLessThan(5_000);
    });

    it('DB 오류가 나도 예외를 전파하지 않아야 함 (크론이 죽으면 이후 실행이 끊긴다)', async () => {
      const service = await buildService('PROD', '1');
      teamTaskRepository.update.mockRejectedValue(new Error('ORA-12541: TNS:no listener'));

      await expect(service.handleAutoArchiveTasks()).resolves.toBeUndefined();
      expect(Logger.prototype.error).toHaveBeenCalled();
    });

    it('아카이브 대상이 0건이면 로그를 남기지 않아야 함', async () => {
      const service = await buildService('PROD', '1');
      teamTaskRepository.update.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });

      await service.handleAutoArchiveTasks();

      expect(Logger.prototype.log).not.toHaveBeenCalled();
    });

    it('아카이브 건수가 있으면 건수를 로그로 남겨야 함', async () => {
      const service = await buildService('PROD', '1');
      teamTaskRepository.update.mockResolvedValue({ affected: 7, raw: [], generatedMaps: [] });

      await service.handleAutoArchiveTasks();

      expect(Logger.prototype.log).toHaveBeenCalledWith(expect.stringContaining('7건'));
    });
  });

  describe('OCI 유휴 회수 방지용 더미 태스크', () => {
    it('handleDoTrash는 count 쿼리로 DB I/O를 발생시켜야 함', async () => {
      const service = await buildService('PROD', '1');

      await service.handleDoTrash();

      expect(userRepository.count).toHaveBeenCalledTimes(1);
    });

    it('handleDoTrash는 DB 오류를 삼켜야 함', async () => {
      const service = await buildService('PROD', '1');
      userRepository.count.mockRejectedValue(new Error('connection lost'));

      await expect(service.handleDoTrash()).resolves.toBeUndefined();
      expect(Logger.prototype.error).toHaveBeenCalled();
    });

    it('handleCpuIntensiveLoop는 DB를 건드리지 않고 끝나야 함', async () => {
      const service = await buildService('PROD', '1');

      await expect(service.handleCpuIntensiveLoop()).resolves.toBeUndefined();
      expect(userRepository.count).not.toHaveBeenCalled();
      expect(teamTaskRepository.update).not.toHaveBeenCalled();
    });
  });
});

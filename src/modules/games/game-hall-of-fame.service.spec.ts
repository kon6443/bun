import { And, LessThan, MoreThanOrEqual } from 'typeorm';
import { GameHallOfFameService, PodiumRow } from './game-hall-of-fame.service';
import { GameEngine, GameEngineRegistry, HallOfFamePeriod } from './game-engine.registry';
import { GameScore } from '../../entities/GameScore';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';

/**
 * GameHallOfFameService — 지난 기간별 1~3위와 로그인 사용자 배지 (docs/tasks/games-growth D-007·D-010).
 *
 * 기간 목록은 엔진이, 기간별 상위 3건은 랭킹과 같은 정렬로. 기간 필터 보드는 등록 시각 범위로 자른다.
 * 결과는 Redis에 10분 캐시하고, Redis를 못 쓰면 매번 계산한다.
 */
describe('GameHallOfFameService', () => {
  let service: GameHallOfFameService;
  let repository: MockRepository<GameScore>;
  let engine: { hallOfFamePeriods: jest.Mock; isPeriodRanking: jest.Mock };
  let redis: { status: string; get: jest.Mock; set: jest.Mock };

  const WEEK: HallOfFamePeriod = { kind: 'weekly', boardKey: 'default', startsAt: new Date('2026-10-11T15:00:00.000Z'), endsAt: new Date('2026-10-18T15:00:00.000Z') };
  const DAY: HallOfFamePeriod = { kind: 'daily', boardKey: 'daily-2026-10-20', startsAt: new Date('2026-10-19T15:00:00.000Z'), endsAt: new Date('2026-10-20T15:00:00.000Z') };
  // find의 select 결과 — 엔티티 일부 컬럼만 있다
  const row = (scoreId: number, userId: number | null): GameScore => ({
    scoreId,
    boardKey: 'default',
    playerName: `p${scoreId}`,
    score: 1000 - scoreId,
    detail: '{}',
    durationMs: 1,
    crtdAt: new Date('2026-10-12T00:00:00.000Z'),
    userId,
  }) satisfies PodiumRow as GameScore;

  beforeEach(() => {
    repository = createMockRepository<GameScore>();
    engine = { hallOfFamePeriods: jest.fn().mockReturnValue([WEEK, DAY]), isPeriodRanking: jest.fn((boardKey: string) => boardKey === 'default') };
    redis = { status: 'ready', get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };
    service = new GameHallOfFameService(repository as never, { TETRIS: engine as unknown as GameEngine } as GameEngineRegistry);
    service.setRedisClient(redis as never);
  });

  describe('getPodiums', () => {
    it('기간마다 상위 3건 — 기간 필터 보드는 등록 시각 범위, 아니면 보드 전체. 숨김 제외·랭킹 정렬', async () => {
      repository.find.mockResolvedValueOnce([row(1, 7), row(2, null)]).mockResolvedValueOnce([row(3, 7)]);

      const podiums = await service.getPodiums('TETRIS');

      expect(repository.find).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { gameType: 'TETRIS', boardKey: 'default', isHidden: 0, crtdAt: And(MoreThanOrEqual(WEEK.startsAt), LessThan(WEEK.endsAt)) },
          order: { score: 'DESC', scoreId: 'ASC' },
          take: 3,
        }),
      );
      expect(repository.find).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { gameType: 'TETRIS', boardKey: 'daily-2026-10-20', isHidden: 0 } }));
      expect(podiums).toEqual([
        { ...WEEK, rows: [row(1, 7), row(2, null)] },
        { ...DAY, rows: [row(3, 7)] },
      ]);
    });

    it('기록 없는 기간은 뺀다', async () => {
      repository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([row(3, null)]);

      await expect(service.getPodiums('TETRIS')).resolves.toEqual([{ ...DAY, rows: [row(3, null)] }]);
    });

    it('계산 결과를 10분 캐시하고, 캐시가 있으면 DB를 읽지 않는다(Date 복원)', async () => {
      repository.find.mockResolvedValue([row(1, 7)]);
      const first = await service.getPodiums('TETRIS');
      expect(redis.set).toHaveBeenCalledWith('game:hall-of-fame:TETRIS', JSON.stringify(first), 'EX', 600);

      repository.find.mockClear();
      redis.get.mockResolvedValue(JSON.stringify(first));

      await expect(service.getPodiums('TETRIS')).resolves.toEqual(first);
      expect(repository.find).not.toHaveBeenCalled();
    });

    it('Redis를 못 쓰면 매번 계산한다', async () => {
      redis.status = 'reconnecting';
      repository.find.mockResolvedValue([row(1, 7)]);

      await service.getPodiums('TETRIS');

      expect(repository.find).toHaveBeenCalledTimes(2);
      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('Redis 오류는 계산으로 넘어간다', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      redis.get.mockRejectedValue(new Error('down'));
      redis.set.mockRejectedValue(new Error('down'));
      repository.find.mockResolvedValue([row(1, 7)]);

      await expect(service.getPodiums('TETRIS')).resolves.toHaveLength(2);
    });
  });

  it('trophiesByUser — 로그인 기록만 순위별로 센다(비로그인 이름은 사칭 가능)', async () => {
    repository.find.mockResolvedValueOnce([row(1, 7), row(2, null), row(3, 8)]).mockResolvedValueOnce([row(4, 8), row(5, 7)]);

    const trophies = await service.trophiesByUser('TETRIS');

    expect(trophies).toEqual(
      new Map([
        [7, { gold: 1, silver: 1, bronze: 0 }],
        [8, { gold: 1, silver: 0, bronze: 1 }],
      ]),
    );
  });

  it('캐시가 빈 순간의 동시 요청은 계산 하나를 함께 기다린다 — 기간 쿼리가 한 벌만', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    repository.find.mockImplementation(() => gate.then(() => [row(1, 7)]));

    const first = service.getPodiums('TETRIS');
    const second = service.getPodiums('TETRIS');
    await Promise.resolve();
    await Promise.resolve();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([expect.any(Array), expect.any(Array)]);
    expect(repository.find).toHaveBeenCalledTimes(2); // 기간 2개 × 1벌
  });

  it('trophiesByUser — Redis를 못 쓰면 배지를 건너뛴다(랭킹마다 기간 수만큼 쿼리하지 않게)', async () => {
    redis.status = 'reconnecting';

    await expect(service.trophiesByUser('TETRIS')).resolves.toEqual(new Map());
    expect(repository.find).not.toHaveBeenCalled();
  });

  it('계산이 실패하면 진행 중 계산을 지운다 — 다음 호출은 실패를 물려받지 않고 다시 계산', async () => {
    repository.find.mockRejectedValueOnce(new Error('db')).mockResolvedValue([row(1, 7)]);

    await expect(service.getPodiums('TETRIS')).rejects.toThrow('db');
    await expect(service.getPodiums('TETRIS')).resolves.toHaveLength(2);
  });
});

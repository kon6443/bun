import { EntityManager, MoreThanOrEqual, Repository } from 'typeorm';
import { createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { FortressPlayer } from '../../entities/FortressPlayer';
import { User } from '../../entities/User';
import { UserPointLedger } from '../../entities/UserPointLedger';
import { UserPointService } from '../users/user-point.service';
import type { BaseAward } from './fortress-points.rules';
import { FortressPointsService } from './fortress-points.service';

const MATCH = 'AbCdEfGhIjKlMnOp';
/** 2026-11-01 00:00 KST = 2026-10-31 15:00 UTC */
const KST_MIDNIGHT = new Date(Date.UTC(2026, 9, 31, 15, 0, 0));

const award = (userId: number, playerId: string, others: number[], over: Partial<BaseAward> = {}): BaseAward => ({
  userId,
  playerId,
  participation: 20_000,
  win: 0,
  ko: 0,
  others,
  ...over,
});

/**
 * 포트리스 포인트 적립 트랜잭션 부분 (DESIGN §13 · D-006 #4·#5·#6) — 규칙 값은 rules spec, 여기서는
 * 잠금 순서·KST 하루 경계·오늘 합계/같은 조합 조회·원장 행 모양·탈퇴/0원 건너뛰기를 본다
 */
describe('FortressPointsService', () => {
  let record: jest.Mock;
  let playerRepository: MockRepository<FortressPlayer>;
  let ledgerRepository: MockRepository<UserPointLedger>;
  let service: FortressPointsService;
  /** 잠금 쿼리가 돌려줄 사용자(없으면 탈퇴) */
  let existingUsers: Set<number>;
  let lockOrder: number[];
  /** 오늘 합계 — userId → sum */
  let todaySums: Map<number, number>;
  let comboRows: { matchId: string; userId: number | string; otherId: number | string }[];
  let sumCalls: unknown[];
  let comboParams: Record<string, unknown>;
  let manager: EntityManager;

  beforeEach(() => {
    record = jest.fn().mockResolvedValue(undefined);
    playerRepository = createMockRepository<FortressPlayer>();
    ledgerRepository = createMockRepository<UserPointLedger>();
    service = new FortressPointsService(
      { record } as unknown as UserPointService,
      playerRepository as unknown as Repository<FortressPlayer>,
      ledgerRepository as unknown as Repository<UserPointLedger>,
    );
    existingUsers = new Set([7, 8, 9]);
    lockOrder = [];
    todaySums = new Map();
    comboRows = [];
    sumCalls = [];
    comboParams = {};

    const lockBuilder = () => {
      let userId = 0;
      const qb = {
        select: () => qb,
        setLock: (mode: string) => {
          expect(mode).toBe('pessimistic_write');
          return qb;
        },
        where: (_sql: string, params: { userId: number }) => {
          userId = params.userId;
          return qb;
        },
        getMany: async () => {
          lockOrder.push(userId);
          return existingUsers.has(userId) ? [{ userId }] : [];
        },
      };
      return qb;
    };
    const comboBuilder = () => {
      const qb = {
        select: () => qb,
        addSelect: () => qb,
        innerJoin: () => qb,
        where: (_sql: string, params: Record<string, unknown>) => (Object.assign(comboParams, params), qb),
        andWhere: (_sql: string, params: Record<string, unknown>) => (Object.assign(comboParams, params), qb),
        getRawMany: async () => comboRows,
      };
      return qb;
    };
    manager = {
      createQueryBuilder: (entity: unknown) => (entity === User ? lockBuilder() : comboBuilder()),
      getRepository: () => ({
        sum: async (_column: string, where: { userId: number }) => {
          sumCalls.push(where);
          return todaySums.get(where.userId) ?? null;
        },
      }),
    } as unknown as EntityManager;
  });

  it('대상이 없으면 잠금·조회·기록 없음', async () => {
    await service.awardInTransaction(manager, MATCH, [], KST_MIDNIGHT);
    expect(lockOrder).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it('#6 USERS 행을 userId 오름차순으로 잠근 뒤 적립 — 원장 행은 FORTRESS_MATCH · REF_KEY matchId:playerId · CRTD_AT = 저장 시각', async () => {
    await service.awardInTransaction(manager, MATCH, [award(9, 'p1', [7], { win: 30_000 }), award(7, 'p2', [9])], KST_MIDNIGHT);
    expect(lockOrder).toEqual([7, 9]);
    expect(record.mock.calls.map(([, entry]) => entry)).toEqual([
      { userId: 7, amount: 20_000, reason: 'FORTRESS_MATCH', refKey: `${MATCH}:p2`, memo: `포트리스 경기 ${MATCH} · 참가 20,000`, crtdAt: KST_MIDNIGHT },
      { userId: 9, amount: 50_000, reason: 'FORTRESS_MATCH', refKey: `${MATCH}:p1`, memo: `포트리스 경기 ${MATCH} · 참가 20,000 · 승리 30,000`, crtdAt: KST_MIDNIGHT },
    ]);
    expect(record.mock.calls.every(([m]) => m === manager)).toBe(true);
  });

  it('#5 KST 하루 경계 — 저장 시각이 KST 00:00이면 그날부터, 1초 전이면 전날 00:00부터 합계', async () => {
    await service.awardInTransaction(manager, MATCH, [award(7, 'p1', [])], KST_MIDNIGHT);
    expect(sumCalls[0]).toEqual({ userId: 7, reason: 'FORTRESS_MATCH', crtdAt: MoreThanOrEqual(KST_MIDNIGHT) });
    sumCalls = [];
    await service.awardInTransaction(manager, MATCH, [award(7, 'p1', [])], new Date(KST_MIDNIGHT.getTime() - 1_000));
    expect(sumCalls[0]).toEqual({ userId: 7, reason: 'FORTRESS_MATCH', crtdAt: MoreThanOrEqual(new Date(KST_MIDNIGHT.getTime() - 24 * 3600_000)) });
  });

  it('#5 오늘 합계로 상한 — 남은 한도만큼, 꽉 찼으면 원장 행 없음', async () => {
    todaySums.set(7, 495_000);
    todaySums.set(8, 500_000);
    await service.awardInTransaction(manager, MATCH, [award(7, 'p1', [8], { win: 30_000 }), award(8, 'p2', [7])], KST_MIDNIGHT);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][1]).toMatchObject({ userId: 7, amount: 5_000, memo: expect.stringContaining('일일 상한 도달') });
  });

  it('#4 같은 조합 경기 수: 오늘(경기 행 CRTD_AT) · 이 경기 제외 · 조합이 정확히 같은 경기만 센다 → 4번째면 승리·KO 50%', async () => {
    // 7의 오늘 경기: A·B·C = {8} (같은 조합 3번) · D = {8, 9} (다른 조합) → 이번이 4번째
    comboRows = [
      { matchId: 'A', userId: 7, otherId: 8 },
      { matchId: 'B', userId: '7', otherId: '8' },
      { matchId: 'C', userId: 7, otherId: 8 },
      { matchId: 'D', userId: 7, otherId: 8 },
      { matchId: 'D', userId: 7, otherId: 9 },
      // 8의 오늘 경기: A·B·C = {7} → 8도 4번째
      { matchId: 'A', userId: 8, otherId: 7 },
      { matchId: 'B', userId: 8, otherId: 7 },
      { matchId: 'C', userId: 8, otherId: 7 },
    ];
    await service.awardInTransaction(manager, MATCH, [award(7, 'p1', [8], { win: 30_000, ko: 10_000 }), award(8, 'p2', [7])], KST_MIDNIGHT);
    expect(comboParams).toEqual({ userIds: [7, 8], dayStart: KST_MIDNIGHT, matchId: MATCH });
    expect(record.mock.calls.map(([, e]) => [e.userId, e.amount])).toEqual([
      [7, 20_000 + 20_000],
      [8, 20_000],
    ]);
    expect(record.mock.calls[0][1].memo).toContain('같은 상대 4번째 · 승리·KO 50%');
  });

  it('#4 같은 조합 6번째부터 참가만', async () => {
    comboRows = ['A', 'B', 'C', 'D', 'E'].map((matchId) => ({ matchId, userId: 7, otherId: 8 }));
    await service.awardInTransaction(manager, MATCH, [award(7, 'p1', [8], { win: 30_000, ko: 30_000 })], KST_MIDNIGHT);
    expect(record.mock.calls[0][1]).toMatchObject({ userId: 7, amount: 20_000 });
  });

  it('로그인 상대가 없으면(others 빈 배열) 같은 조합 조회를 하지 않는다', async () => {
    const spy = jest.spyOn(manager, 'createQueryBuilder');
    await service.awardInTransaction(manager, MATCH, [award(7, 'p1', [])], KST_MIDNIGHT);
    expect(spy.mock.calls.map(([entity]) => entity)).toEqual([User]);
  });

  it('그 사이 탈퇴(잠금 결과 없음)한 사용자는 건너뛴다 — 원장 FK 위반으로 저장 전체가 실패하지 않게', async () => {
    existingUsers = new Set([7]);
    await service.awardInTransaction(manager, MATCH, [award(7, 'p1', [8]), award(8, 'p2', [7])], KST_MIDNIGHT);
    expect(lockOrder).toEqual([7, 8]);
    expect(record.mock.calls.map(([, e]) => e.userId)).toEqual([7]);
  });

  describe('pointsOf — 결과 화면용', () => {
    it('로그인 참가자가 아니면 participant false · 0', async () => {
      playerRepository.findOne.mockResolvedValue(null);
      await expect(service.pointsOf(MATCH, 7)).resolves.toEqual({ matchId: MATCH, participant: false, earned: 0, memo: null });
      expect(ledgerRepository.findOne).not.toHaveBeenCalled();
    });

    it('참가자면 그 자리의 원장 행 — 없으면(무효·기권·상한 소진) 0', async () => {
      playerRepository.findOne.mockResolvedValue({ playerId: 'p2' } as FortressPlayer);
      ledgerRepository.findOne.mockResolvedValue({ amount: 50_000, memo: 'm' } as UserPointLedger);
      await expect(service.pointsOf(MATCH, 7)).resolves.toEqual({ matchId: MATCH, participant: true, earned: 50_000, memo: 'm' });
      expect(playerRepository.findOne).toHaveBeenCalledWith({ where: { matchId: MATCH, userId: 7 }, select: { playerId: true } });
      expect(ledgerRepository.findOne).toHaveBeenCalledWith({
        where: { userId: 7, reason: 'FORTRESS_MATCH', refKey: `${MATCH}:p2` },
        select: { amount: true, memo: true },
      });
      ledgerRepository.findOne.mockResolvedValue(null);
      await expect(service.pointsOf(MATCH, 7)).resolves.toEqual({ matchId: MATCH, participant: true, earned: 0, memo: null });
    });
  });
});

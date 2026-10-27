import { LessThan, MoreThan } from 'typeorm';
import { createMockQueryBuilder, createMockRepository, MockRepository } from '../../common/__spec__/mock-repository';
import { UserPointLedger } from '../../entities/UserPointLedger';
import { UserPointService, tetrisScorePointEntry } from './user-point.service';

describe('UserPointService (skin-levels D-004)', () => {
  let ledger: MockRepository<UserPointLedger>;
  let service: UserPointService;

  /** 원장 합계 대역 — 조건(적립·소비)에 따라 다른 합계 */
  const ledgerSums = (repository: MockRepository<UserPointLedger>, earned: number | null, spent: number | null) =>
    repository.sum.mockImplementation(async (_column, where) =>
      JSON.stringify((where as { amount: unknown }).amount) === JSON.stringify(MoreThan(0)) ? earned : spent,
    );

  beforeEach(() => {
    ledger = createMockRepository<UserPointLedger>();
    service = new UserPointService(ledger as never);
  });

  it('잔액 = 원장 적립 합계 − 소비 합계, 소비는 양수로', async () => {
    ledgerSums(ledger, 4_222_137, -300_000);

    await expect(service.pointsOf(1)).resolves.toEqual({ earned: 4_222_137, spent: 300_000, balance: 3_922_137 });
    expect(ledger.sum).toHaveBeenCalledWith('amount', { userId: 1, amount: MoreThan(0) });
    expect(ledger.sum).toHaveBeenCalledWith('amount', { userId: 1, amount: LessThan(0) });
  });

  it('원장이 비면(합계 null) 모두 0', async () => {
    ledgerSums(ledger, null, null);
    await expect(service.pointsOf(1)).resolves.toEqual({ earned: 0, spent: 0, balance: 0 });
  });

  it('소비가 적립보다 많으면(이후 차감 기록 등) 잔액은 0', async () => {
    ledgerSums(ledger, 50_000, -100_000);
    await expect(service.pointsOf(1)).resolves.toEqual({ earned: 50_000, spent: 100_000, balance: 0 });
  });

  it('manager를 넘기면 그 트랜잭션의 저장소로 읽는다', async () => {
    const txLedger = createMockRepository<UserPointLedger>();
    ledgerSums(txLedger, 10, null);
    const manager = { getRepository: jest.fn(() => txLedger) };

    await expect(service.pointsOf(1, manager as never)).resolves.toEqual({ earned: 10, spent: 0, balance: 10 });
    expect(manager.getRepository).toHaveBeenCalledWith(UserPointLedger);
    expect(ledger.sum).not.toHaveBeenCalled();
  });

  it('record — 호출 쪽 트랜잭션 저장소에 1줄, 시각을 안 주면 지금', async () => {
    const txLedger = createMockRepository<UserPointLedger>();
    const manager = { getRepository: jest.fn(() => txLedger) };
    await service.record(manager as never, { userId: 1, amount: -100_000, reason: 'SKIN_UPGRADE', refKey: 'TETRIS_BLOCK:neon:2', memo: 'block neon Lv2 강화' });
    expect(txLedger.insert).toHaveBeenCalledWith({
      userId: 1,
      amount: -100_000,
      reason: 'SKIN_UPGRADE',
      refKey: 'TETRIS_BLOCK:neon:2',
      memo: 'block neon Lv2 강화',
      crtdAt: expect.any(Date),
    });
    expect(ledger.insert).not.toHaveBeenCalled();
  });

  it('테트리스 기록 적립 줄 — 소급 마이그레이션과 같은 REASON·REF_KEY·MEMO 형식', () => {
    const at = new Date('2026-10-27T00:00:00.000Z');
    expect(tetrisScorePointEntry(7, 41, 'daily-2026-10-27', 1_234_567, at)).toEqual({
      userId: 7,
      amount: 1_234_567,
      reason: 'TETRIS_SCORE',
      refKey: '41',
      memo: '테트리스 기록 #41 · daily-2026-10-27 보드 · 1,234,567점',
      crtdAt: at,
    });
  });

  describe('내역 (D-005)', () => {
    const at = (iso: string) => new Date(iso);
    const row = (ledgerId: number, crtdAt: string) =>
      ({ ledgerId, amount: 100, reason: 'TETRIS_SCORE', refKey: String(ledgerId), memo: 'm', crtdAt: at(crtdAt) }) as UserPointLedger;
    let qb: ReturnType<typeof createMockQueryBuilder>;

    beforeEach(() => {
      ledgerSums(ledger, 300, null);
      qb = createMockQueryBuilder({ getMany: [] });
      ledger.createQueryBuilder.mockReturnValue(qb as never);
    });

    it('내 줄만 시각·id 내림차순으로 limit+1개 읽고, 하나 더 있으면 hasMore', async () => {
      qb.getMany.mockResolvedValue([row(3, '2026-10-27T03:00:00Z'), row(2, '2026-10-27T02:00:00Z'), row(1, '2026-10-27T01:00:00Z')]);
      const page = await service.history(7, { limit: 2 });

      expect(qb.where).toHaveBeenCalledWith('l.userId = :userId', { userId: 7 });
      expect(qb.orderBy).toHaveBeenCalledWith('l.crtdAt', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('l.ledgerId', 'DESC');
      expect(qb.take).toHaveBeenCalledWith(3);
      expect(page.items.map((item) => item.id)).toEqual([3, 2]);
      expect(page.items[0]).toEqual({ id: 3, amount: 100, reason: 'TETRIS_SCORE', refKey: '3', meta: { scoreId: 3 }, memo: 'm', createdAt: at('2026-10-27T03:00:00Z') });
      expect(page).toMatchObject({ nextCursor: 2, points: { earned: 300, spent: 0, balance: 300 } });
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('beforeId — 내 줄의 시각·id 다음부터(같은 시각은 id로 가른다)', async () => {
      ledger.findOne.mockResolvedValue(row(5, '2026-10-27T02:00:00Z'));
      await service.history(7, { beforeId: 5 });
      expect(ledger.findOne).toHaveBeenCalledWith({ select: { ledgerId: true, crtdAt: true }, where: { ledgerId: 5, userId: 7 } });
      expect(qb.andWhere).toHaveBeenCalledWith('(l.crtdAt < :at OR (l.crtdAt = :at AND l.ledgerId < :id))', { at: at('2026-10-27T02:00:00Z'), id: 5 });
    });

    it('없거나 남의 줄 id를 beforeId로 주면 빈 페이지 — 목록을 읽지 않는다', async () => {
      ledger.findOne.mockResolvedValue(null);
      await expect(service.history(7, { beforeId: 999 })).resolves.toEqual({ points: { earned: 300, spent: 0, balance: 300 }, items: [], nextCursor: null });
      expect(qb.getMany).not.toHaveBeenCalled();
    });

    it('끝 페이지는 nextCursor null', async () => {
      qb.getMany.mockResolvedValue([row(1, '2026-10-27T01:00:00Z')]);
      expect((await service.history(7, { limit: 2 })).nextCursor).toBeNull();
    });

    it.each([
      ['earn', 'l.amount > 0'],
      ['spend', 'l.amount < 0'],
    ] as const)('type=%s → 서버에서 거른다', async (type, condition) => {
      await service.history(7, { type });
      expect(qb.andWhere).toHaveBeenCalledWith(condition);
    });

    it('meta — 사유별 대상을 구조화, 형식이 다르면 null', async () => {
      const mk = (ledgerId: number, reason: string, refKey: string) => ({ ...row(ledgerId, '2026-10-27T01:00:00Z'), reason, refKey }) as UserPointLedger;
      qb.getMany.mockResolvedValue([
        mk(4, 'SKIN_UPGRADE', 'TETRIS_BACKGROUND:clear:3'),
        mk(3, 'SKIN_UPGRADE', 'OTHER_SLOT:x:2'),
        mk(2, 'TETRIS_SCORE', 'abc'),
        mk(1, 'ATTENDANCE', '2026-10-27'),
      ]);
      const page = await service.history(7, {});
      expect(page.items.map((item) => item.meta)).toEqual([{ slot: 'background', skinId: 'clear', level: 3 }, null, null, null]);
    });
  });
});

import { createMockRepository, createMockQueryBuilder } from './mock-repository';

/**
 * 테스트 헬퍼 자체의 검증.
 *
 * Factory(entity.factory.ts)는 타입 체크된 객체 리터럴이라 컴파일이 곧 검증이지만,
 * 이 파일의 헬퍼들은 **동작 로직**(체이닝 반환, 종단 메서드 resolve)을 갖는다.
 * D5에서 이걸 믿고 수십 개 테스트를 쓰게 되므로, 헬퍼가 실제로 그렇게 동작하는지
 * 여기서 한 번 못 박아 둔다.
 */
describe('createMockRepository', () => {
  it('주요 Repository 메서드가 jest mock으로 제공되어야 함', () => {
    const repo = createMockRepository();

    expect(jest.isMockFunction(repo.findOne)).toBe(true);
    expect(jest.isMockFunction(repo.save)).toBe(true);
    expect(jest.isMockFunction(repo.createQueryBuilder)).toBe(true);
  });

  it('호출마다 독립 인스턴스를 반환해야 함 (테스트 간 상태 누수 방지)', () => {
    const a = createMockRepository();
    const b = createMockRepository();

    a.findOne.mockResolvedValue({ id: 1 });

    expect(a.findOne).not.toBe(b.findOne);
    expect(b.findOne.mock.calls).toHaveLength(0);
  });
});

describe('createMockQueryBuilder', () => {
  it('체이닝 메서드는 자기 자신을 반환해 체인이 끊기지 않아야 함', () => {
    const qb = createMockQueryBuilder();

    expect(qb.where({})).toBe(qb);
    expect(qb.andWhere({})).toBe(qb);
    expect(qb.setLock('pessimistic_write')).toBe(qb);
    expect(qb.innerJoinAndSelect('a', 'b')).toBe(qb);
    expect(qb.orderBy('x')).toBe(qb);
  });

  it('실제 사용 형태(긴 체이닝 → 종단 메서드)에서 설정한 값을 반환해야 함', async () => {
    const invite = { invId: 1, token: 'tok' };
    const qb = createMockQueryBuilder({ getOne: invite });

    // team.service.acceptTeamInvite와 동일한 체이닝 형태
    const result = await qb
      .setLock('pessimistic_write')
      .where('invite.teamId = :teamId', { teamId: 1 })
      .andWhere('invite.token = :token', { token: 'tok' })
      .getOne();

    expect(result).toBe(invite);
  });

  it('종단 메서드의 기본값은 빈 결과여야 함 (미설정 시 undefined로 터지지 않게)', async () => {
    const qb = createMockQueryBuilder();

    await expect(qb.getOne()).resolves.toBeNull();
    await expect(qb.getMany()).resolves.toEqual([]);
    await expect(qb.getRawMany()).resolves.toEqual([]);
    await expect(qb.getCount()).resolves.toBe(0);
  });
});

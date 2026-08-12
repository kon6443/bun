import { ObjectLiteral, Repository } from 'typeorm';

/**
 * 단위 테스트용 TypeORM Repository mock.
 *
 * 이 프로젝트는 LOCAL/PROD가 동일 Oracle DB를 공유하고 Entity에 Oracle 전용 타입이
 * 하드코딩되어 있어 인메모리 테스트 DB를 쓸 수 없다. 따라서 모든 단위 테스트는
 * 실제 DB 대신 이 mock으로 Repository 경계를 끊는다.
 *
 * 사용 예:
 *   const userRepository = createMockRepository<User>();
 *   userRepository.findOne.mockResolvedValue(createUser());
 *
 *   const module = await Test.createTestingModule({
 *     providers: [
 *       UsersService,
 *       { provide: getRepositoryToken(User), useValue: userRepository },
 *     ],
 *   }).compile();
 */

/** mock으로 제공하는 Repository 메서드 목록 — 필요해지면 여기에 추가한다. */
const MOCKED_METHODS = [
  'find',
  'findOne',
  'findOneBy',
  'findAndCount',
  'save',
  'create',
  'insert',
  'update',
  'delete',
  'remove',
  'count',
  'exists',
  'createQueryBuilder',
] as const;

type MockedMethod = (typeof MOCKED_METHODS)[number];

export type MockRepository<T extends ObjectLiteral = ObjectLiteral> = jest.Mocked<
  Pick<Repository<T>, MockedMethod>
>;

export const createMockRepository = <T extends ObjectLiteral>(): MockRepository<T> =>
  MOCKED_METHODS.reduce((acc, method) => {
    acc[method] = jest.fn();
    return acc;
  }, {} as Record<MockedMethod, jest.Mock>) as MockRepository<T>;

/**
 * QueryBuilder 체이닝 mock.
 *
 * TeamService처럼 `createQueryBuilder().where().andWhere().getOne()` 형태로
 * 길게 체이닝하는 코드를 테스트할 때 사용한다. 종단 메서드(getOne/getMany 등)를
 * 제외한 모든 메서드는 자기 자신을 반환해 체이닝이 끊기지 않는다.
 *
 * 사용 예:
 *   const qb = createMockQueryBuilder({ getOne: invite });
 *   repository.createQueryBuilder.mockReturnValue(qb);
 */
export const createMockQueryBuilder = (
  results: Partial<{
    getOne: unknown;
    getMany: unknown;
    getRawOne: unknown;
    getRawMany: unknown;
    getCount: number;
    execute: unknown;
  }> = {},
) => {
  const qb: Record<string, jest.Mock> = {};
  const chainable = [
    'select',
    'addSelect',
    'from',
    'where',
    'andWhere',
    'orWhere',
    'leftJoin',
    'leftJoinAndSelect',
    'innerJoin',
    'innerJoinAndSelect',
    'orderBy',
    'addOrderBy',
    'groupBy',
    'skip',
    'take',
    'limit',
    'offset',
    'setLock',
    'setParameter',
    'setParameters',
  ];

  for (const method of chainable) {
    qb[method] = jest.fn(() => qb);
  }

  qb.getOne = jest.fn().mockResolvedValue(results.getOne ?? null);
  qb.getMany = jest.fn().mockResolvedValue(results.getMany ?? []);
  qb.getRawOne = jest.fn().mockResolvedValue(results.getRawOne ?? null);
  qb.getRawMany = jest.fn().mockResolvedValue(results.getRawMany ?? []);
  qb.getCount = jest.fn().mockResolvedValue(results.getCount ?? 0);
  qb.execute = jest.fn().mockResolvedValue(results.execute ?? undefined);

  return qb;
};

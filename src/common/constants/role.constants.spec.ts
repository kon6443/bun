import {
  ROLE_HIERARCHY,
  ROLE_LABELS,
  MANAGEMENT_ROLES,
  RoleKey,
  isValidRole,
  canManageRole,
  canAssignRole,
  canChangeRole,
  hasManagementPermission,
} from './role.constants';

/**
 * 팀 권한 정책의 SSOT.
 *
 * TeamService의 권한 검증이 이 함수들에 위임돼 있어, 여기가 뚫리면 서비스 전체가 뚫린다.
 * 순수 함수라 조합을 전수 검증할 수 있으므로 3×3(관리) / 3×3(할당) / 3×3×3(종합)을
 * 표로 못 박아 둔다. 정책이 바뀌면 표가 깨지면서 "의도한 변경인지" 다시 판단하게 된다.
 */
const ALL_ROLES: RoleKey[] = ['MASTER', 'MANAGER', 'MEMBER'];

describe('ROLE_HIERARCHY', () => {
  it('MASTER > MANAGER > MEMBER 순서를 유지해야 함', () => {
    expect(ROLE_HIERARCHY.MASTER).toBeGreaterThan(ROLE_HIERARCHY.MANAGER);
    expect(ROLE_HIERARCHY.MANAGER).toBeGreaterThan(ROLE_HIERARCHY.MEMBER);
  });

  it('모든 역할에 라벨이 정의되어 있어야 함 (역할 추가 시 누락 방지)', () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_LABELS[role]).toBeTruthy();
    }
    expect(Object.keys(ROLE_LABELS).sort()).toEqual(Object.keys(ROLE_HIERARCHY).sort());
  });
});

describe('isValidRole', () => {
  it.each(ALL_ROLES)('%s는 유효한 역할', (role) => {
    expect(isValidRole(role)).toBe(true);
  });

  it.each([
    ['소문자', 'master'],
    ['존재하지 않는 역할', 'OWNER'],
    ['빈 문자열', ''],
    ['프로토타입 속성', 'toString'],
    ['constructor', 'constructor'],
  ])('%s(%s)는 무효해야 함', (_desc, role) => {
    expect(isValidRole(role)).toBe(false);
  });
});

describe('canManageRole — 요청자가 대상자를 관리할 수 있는가', () => {
  // 상위 역할만 하위 역할을 관리 가능. 동급끼리는 불가(MANAGER가 MANAGER를 못 건드림)
  it.each([
    ['MASTER', 'MASTER', false],
    ['MASTER', 'MANAGER', true],
    ['MASTER', 'MEMBER', true],
    ['MANAGER', 'MASTER', false],
    ['MANAGER', 'MANAGER', false],
    ['MANAGER', 'MEMBER', true],
    ['MEMBER', 'MASTER', false],
    ['MEMBER', 'MANAGER', false],
    ['MEMBER', 'MEMBER', false],
  ] as [RoleKey, RoleKey, boolean][])('%s → %s 관리: %s', (actor, target, expected) => {
    expect(canManageRole(actor, target)).toBe(expected);
  });

  it('자기 자신과 같은 역할은 누구도 관리할 수 없어야 함', () => {
    for (const role of ALL_ROLES) {
      expect(canManageRole(role, role)).toBe(false);
    }
  });
});

describe('canAssignRole — 요청자가 그 역할을 부여할 수 있는가', () => {
  // MASTER는 팀당 1명이므로 누구도 MASTER를 부여할 수 없다
  it.each(ALL_ROLES)('%s도 MASTER 역할은 부여할 수 없어야 함', (actor) => {
    expect(canAssignRole(actor, 'MASTER')).toBe(false);
  });

  it.each([
    ['MASTER', 'MANAGER', true],
    ['MASTER', 'MEMBER', true],
    // MANAGER는 승격(MEMBER→MANAGER)만 가능하고 강등은 불가
    ['MANAGER', 'MANAGER', true],
    ['MANAGER', 'MEMBER', false],
    ['MEMBER', 'MANAGER', false],
    ['MEMBER', 'MEMBER', false],
  ] as [RoleKey, RoleKey, boolean][])('%s → %s 부여: %s', (actor, newRole, expected) => {
    expect(canAssignRole(actor, newRole)).toBe(expected);
  });
});

describe('canChangeRole — 종합 검증 (관리 가능 AND 부여 가능)', () => {
  /**
   * 3×3×3 = 27조합 전수. true인 조합만 명시하고 나머지는 전부 false여야 한다.
   * 이 방식이면 정책이 느슨해지는 방향의 변경(권한 확대)이 반드시 표를 깬다.
   */
  const ALLOWED: [RoleKey, RoleKey, RoleKey][] = [
    // MASTER는 MANAGER/MEMBER를 자유롭게 조정 (단 MASTER 부여는 불가)
    ['MASTER', 'MANAGER', 'MEMBER'],
    ['MASTER', 'MANAGER', 'MANAGER'],
    ['MASTER', 'MEMBER', 'MANAGER'],
    ['MASTER', 'MEMBER', 'MEMBER'],
    // MANAGER는 MEMBER를 MANAGER로 승격하는 것만 가능
    ['MANAGER', 'MEMBER', 'MANAGER'],
  ];

  const key = (a: RoleKey, t: RoleKey, n: RoleKey) => `${a}|${t}|${n}`;
  const allowedKeys = new Set(ALLOWED.map(([a, t, n]) => key(a, t, n)));

  const allCombos: [RoleKey, RoleKey, RoleKey][] = ALL_ROLES.flatMap((actor) =>
    ALL_ROLES.flatMap((target) => ALL_ROLES.map((next) => [actor, target, next] as [RoleKey, RoleKey, RoleKey])),
  );

  it('27개 조합 중 허용은 정확히 5개여야 함', () => {
    const actualAllowed = allCombos.filter(([a, t, n]) => canChangeRole(a, t, n));

    expect(actualAllowed).toHaveLength(ALLOWED.length);
  });

  it.each(allCombos)('actor=%s, target=%s, new=%s', (actor, target, next) => {
    expect(canChangeRole(actor, target, next)).toBe(allowedKeys.has(key(actor, target, next)));
  });

  it('MASTER를 대상으로 하는 변경은 전부 차단되어야 함 (팀당 1명 보장)', () => {
    for (const actor of ALL_ROLES) {
      for (const next of ALL_ROLES) {
        expect(canChangeRole(actor, 'MASTER', next)).toBe(false);
      }
    }
  });

  it('MASTER로의 승격은 전부 차단되어야 함', () => {
    for (const actor of ALL_ROLES) {
      for (const target of ALL_ROLES) {
        expect(canChangeRole(actor, target, 'MASTER')).toBe(false);
      }
    }
  });
});

describe('MANAGEMENT_ROLES / hasManagementPermission', () => {
  it('관리 권한은 MASTER와 MANAGER만 가져야 함', () => {
    expect(MANAGEMENT_ROLES).toEqual(['MASTER', 'MANAGER']);
  });

  it.each([
    ['MASTER', true],
    ['MANAGER', true],
    ['MEMBER', false],
  ] as [RoleKey, boolean][])('%s의 관리 권한: %s', (role, expected) => {
    expect(hasManagementPermission(role)).toBe(expected);
  });

  it('MANAGEMENT_ROLES와 hasManagementPermission의 판정이 일치해야 함', () => {
    for (const role of ALL_ROLES) {
      expect(hasManagementPermission(role)).toBe(MANAGEMENT_ROLES.includes(role));
    }
  });
});

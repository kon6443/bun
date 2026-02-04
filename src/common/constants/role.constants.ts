/**
 * 팀 역할 관련 상수 및 유틸리티
 * 역할 추가 시 ROLE_HIERARCHY에만 추가하면 자동으로 권한 체크 로직이 적용됨
 */

/**
 * 역할 계층 구조 (숫자가 높을수록 상위 권한)
 */
export const ROLE_HIERARCHY = {
  MASTER: 3,
  MANAGER: 2,
  MEMBER: 1,
} as const;

export type RoleKey = keyof typeof ROLE_HIERARCHY;

/**
 * 유효한 역할인지 확인
 */
export function isValidRole(role: string): role is RoleKey {
  return role in ROLE_HIERARCHY;
}

/**
 * 요청자가 대상자의 역할을 관리할 수 있는지 확인
 * - 상위 역할만 하위 역할을 관리 가능
 * - MANAGER는 MEMBER만 관리 가능 (동급 MANAGER 관리 불가)
 */
export function canManageRole(actorRole: RoleKey, targetCurrentRole: RoleKey): boolean {
  return ROLE_HIERARCHY[actorRole] > ROLE_HIERARCHY[targetCurrentRole];
}

/**
 * 요청자가 특정 역할로 변경할 수 있는지 확인
 * - MASTER: MANAGER, MEMBER로 변경 가능
 * - MANAGER: MANAGER로만 변경 가능 (MEMBER → MANAGER 승격만)
 */
export function canAssignRole(actorRole: RoleKey, newRole: RoleKey): boolean {
  // MASTER는 변경 불가 (팀당 1명 유지)
  if (newRole === 'MASTER') {
    return false;
  }
  
  // MASTER는 MANAGER, MEMBER 모두 할당 가능
  if (actorRole === 'MASTER') {
    return true;
  }
  
  // MANAGER는 MANAGER로만 승격 가능 (MEMBER → MANAGER)
  if (actorRole === 'MANAGER') {
    return newRole === 'MANAGER';
  }
  
  return false;
}

/**
 * 요청자가 대상자의 역할을 newRole로 변경할 수 있는지 종합 검증
 * @param actorRole 요청자 역할
 * @param targetCurrentRole 대상자 현재 역할
 * @param newRole 변경하려는 역할
 * @returns 변경 가능 여부
 */
export function canChangeRole(
  actorRole: RoleKey,
  targetCurrentRole: RoleKey,
  newRole: RoleKey,
): boolean {
  // 1. 대상자 관리 가능한지 확인
  if (!canManageRole(actorRole, targetCurrentRole)) {
    return false;
  }
  
  // 2. 해당 역할로 변경 가능한지 확인
  if (!canAssignRole(actorRole, newRole)) {
    return false;
  }
  
  return true;
}

/**
 * 역할별 한글 라벨
 */
export const ROLE_LABELS: Record<RoleKey, string> = {
  MASTER: '마스터',
  MANAGER: '매니저',
  MEMBER: '멤버',
};

/**
 * 관리 권한이 있는 역할 목록 (초대, 권한 관리 등)
 */
export const MANAGEMENT_ROLES: RoleKey[] = ['MASTER', 'MANAGER'];

/**
 * 역할이 관리 권한을 가지는지 확인
 */
export function hasManagementPermission(role: RoleKey): boolean {
  return MANAGEMENT_ROLES.includes(role);
}

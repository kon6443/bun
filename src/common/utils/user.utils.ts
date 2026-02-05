/**
 * 사용자 관련 공통 유틸리티 함수
 */

/**
 * 기본 닉네임 생성: userName이 null/undefined인 경우 "사용자{userId}" 형식으로 반환
 * @param userName - 사용자 이름 (null/undefined 가능)
 * @param userId - 사용자 ID
 * @returns 표시할 이름
 */
export function getDisplayName(userName: string | null | undefined, userId: number): string {
  return userName ?? `사용자${userId}`;
}

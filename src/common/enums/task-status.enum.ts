/**
 * 태스크 작업 상태 Enum
 */
export enum TaskStatus {
  CREATED = 1, // 생성됨
  IN_PROGRESS = 2, // 진행중
  COMPLETED = 3, // 완료
  ON_HOLD = 4, // 보류
  CANCELLED = 5, // 취소
}

/**
 * 활성 상태 Enum (태스크 노출 여부)
 */
export enum ActStatus {
  INACTIVE = 0, // 비활성
  ACTIVE = 1, // 활성(노출)
}

/** Graceful shutdown 타임아웃 (밀리초) */
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;

/** 초대 링크 최대 만료 시간 (밀리초) — 7일 */
export const INVITE_MAX_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

/** 초대 링크 기본 최대 사용 횟수 — 미지정 시 적용. TeamInvitation.USAGE_MAX_CNT 컬럼 기본값과 같게 둔다 */
export const INVITE_DEFAULT_USAGE_MAX_CNT = 1;

/** 초대 토큰 JWT 만료 시간 (초) — 8일 */
export const INVITE_TOKEN_EXPIRY_SECONDS = 8 * 24 * 60 * 60;

/** 로그 파일 로테이션 보관 개수 */
export const LOG_ROTATION_COUNT = 7;

/** 팀 태그 이름 최대 길이 (앞뒤 공백 제거 후) — 프론트와 같은 값 (docs/tasks/team-task-tags D-014) */
export const TEAM_TAG_NAME_MAX_LENGTH = 20;

/** 팀당 태그 최대 개수 (D-014) */
export const TEAM_TAG_MAX_PER_TEAM = 100;

/** 태스크당 태그 최대 개수 (D-014) */
export const TASK_TAG_MAX_PER_TASK = 10;

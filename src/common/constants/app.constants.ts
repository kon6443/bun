/** Graceful shutdown 타임아웃 (밀리초) */
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;

/** 초대 링크 최대 만료 시간 (밀리초) — 7일 */
export const INVITE_MAX_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

/** 초대 토큰 JWT 만료 시간 (초) — 8일 */
export const INVITE_TOKEN_EXPIRY_SECONDS = 8 * 24 * 60 * 60;

/** 로그 파일 로테이션 보관 개수 */
export const LOG_ROTATION_COUNT = 7;

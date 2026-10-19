/**
 * 팀 채팅 한도 (SSOT) — docs/tasks/team-chat-persistence D-007·D-013
 */

/** 메시지 최대 글자 수 (프론트 입력창 maxLength와 맞춘다) */
export const CHAT_MESSAGE_MAX_LENGTH = 4000;

/**
 * 메시지 최대 바이트 수 (UTF-8) — 컬럼은 CLOB이라 DB 한도는 없고, 소켓·HTTP 페이로드 크기 방어용이다.
 * 한글 4,000자(12,000바이트)는 통과하고, "❤️"(1자로 세지만 6바이트) 같은 이모지 도배는 막는다.
 */
export const CHAT_MESSAGE_MAX_BYTES = 16000;

/** 이력 조회 페이지 크기 */
export const CHAT_HISTORY_DEFAULT_LIMIT = 50;
export const CHAT_HISTORY_MAX_LIMIT = 100;

/** 소켓 이벤트 레이트 리밋 — 유저 단위 고정 윈도 (모든 팀 합산) */
export const CHAT_RATE_LIMITS = {
  send: { limit: 20, windowSec: 10 },
  read: { limit: 60, windowSec: 10 },
} as const;

export type ChatRateLimitAction = keyof typeof CHAT_RATE_LIMITS;

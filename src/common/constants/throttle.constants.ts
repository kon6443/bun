/** 전역 스로틀: 초당 요청 제한 */
export const THROTTLE_SHORT = { ttl: 1000, limit: 5 };

/** 전역 스로틀: 분당 요청 제한 */
export const THROTTLE_LONG = { ttl: 60000, limit: 60 };

/** 인증 엔드포인트 스로틀: 초당 요청 제한 */
export const THROTTLE_AUTH_SHORT = { ttl: 1000, limit: 2 };

/** 인증 엔드포인트 스로틀: 분당 요청 제한 */
export const THROTTLE_AUTH_LONG = { ttl: 60000, limit: 10 };

/** 피드백 작성 스로틀: 초당 요청 제한 (docs/tasks/feedback D-005) */
export const THROTTLE_FEEDBACK_SHORT = { ttl: 1000, limit: 1 };

/** 피드백 작성 스로틀: 분당 요청 제한 */
export const THROTTLE_FEEDBACK_LONG = { ttl: 60000, limit: 3 };

/** 게임 세션 발급 스로틀: 초당·분당 (docs/tasks/games DESIGN §3) */
export const THROTTLE_GAME_SESSION_SHORT = { ttl: 1000, limit: 2 };
export const THROTTLE_GAME_SESSION_LONG = { ttl: 60000, limit: 20 };

/** 게임 점수(리플레이) 제출 스로틀: 초당·분당 — 서버가 리플레이를 재실행하므로 더 엄격하게 */
export const THROTTLE_GAME_SCORE_SHORT = { ttl: 1000, limit: 1 };
export const THROTTLE_GAME_SCORE_LONG = { ttl: 60000, limit: 10 };

/** 리플레이 조회 스로틀: 초당·분당 */
export const THROTTLE_GAME_REPLAY_SHORT = { ttl: 1000, limit: 2 };
export const THROTTLE_GAME_REPLAY_LONG = { ttl: 60000, limit: 30 };

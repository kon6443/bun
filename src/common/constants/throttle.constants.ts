/** 전역 스로틀: 초당 요청 제한 */
export const THROTTLE_SHORT = { ttl: 1000, limit: 5 };

/** 전역 스로틀: 분당 요청 제한 */
export const THROTTLE_LONG = { ttl: 60000, limit: 60 };

/** 인증 엔드포인트 스로틀: 초당 요청 제한 */
export const THROTTLE_AUTH_SHORT = { ttl: 1000, limit: 2 };

/** 인증 엔드포인트 스로틀: 분당 요청 제한 */
export const THROTTLE_AUTH_LONG = { ttl: 60000, limit: 10 };

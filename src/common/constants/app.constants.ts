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

/** 피드백 제목 최대 길이 (앞뒤 공백 제거 후) — 프론트와 같은 값 (docs/tasks/feedback DESIGN §2-1) */
export const FEEDBACK_TITLE_MAX_LENGTH = 100;

/** 피드백 내용 최대 길이 (앞뒤 공백 제거 후) */
export const FEEDBACK_CONTENT_MAX_LENGTH = 5000;

/** 피드백 작성 직전 화면 경로 최대 길이 */
export const FEEDBACK_PAGE_PATH_MAX_LENGTH = 500;

/** 피드백 User-Agent 저장 길이 — 넘으면 잘라서 저장 */
export const FEEDBACK_USER_AGENT_MAX_LENGTH = 500;

/** 사용자당 최근 24시간 피드백 작성 상한 (D-005) */
export const FEEDBACK_DAILY_LIMIT = 20;

/** 내 피드백 목록 기본·최대 페이지 크기 */
export const FEEDBACK_LIST_DEFAULT_LIMIT = 20;
export const FEEDBACK_LIST_MAX_LIMIT = 50;

/** 게임 랭킹 표시 이름 최대 길이 (앞뒤 공백 제거 후) — 프론트와 같은 값 (docs/tasks/games DESIGN §3) */
export const GAME_PLAYER_NAME_MAX_LENGTH = 12;

/** 게임 세션(seed) 유효 시간 (초) — 이 안에 끝난 판만 등록할 수 있다 */
export const GAME_SESSION_TTL_SECONDS = 2 * 60 * 60;

/** 리플레이 상한 — 60분(60fps) · 입력 배열 길이(동작 6만 개 = 60분 기준 초당 16.7회) (DESIGN §4-2, D-014) */
export const GAME_REPLAY_MAX_FRAMES = 216_000;
export const GAME_REPLAY_MAX_INPUT_LENGTH = 120_000;

/** 리플레이 프레임 수와 서버 경과 시간 비교 여유 (밀리초) — 네트워크 지연 */
export const GAME_REPLAY_TIME_TOLERANCE_MS = 5_000;

/** 랭킹 조회 기본·최대 개수 */
export const GAME_RANKING_DEFAULT_LIMIT = 50;
export const GAME_RANKING_MAX_LIMIT = 100;

/**
 * JSON 요청 본문 한도 — main.ts와 E2E(test/helpers/e2e-app.ts)가 같은 값을 쓴다.
 * 게임 리플레이 최대(입력 120,000개, delta 합 ≤ 216,000프레임) 본문이 이론상 약 262KB라 300kb (docs/tasks/games D-014).
 * Express 기본값은 100kb.
 */
export const JSON_BODY_LIMIT = '300kb';

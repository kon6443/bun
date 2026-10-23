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

/** 테트리스 세션(seed) 유효 시간 (초) — 이 안에 끝난 판만 등록할 수 있다. 게임별 값은 엔진 레지스트리 sessionTtlSeconds */
export const GAME_SESSION_TTL_SECONDS = 2 * 60 * 60;

/**
 * 리플레이 DTO 상한 — 모든 게임 중 최댓값(테트리스 60분·60fps, 입력 배열 길이 동작 6만 개) (games DESIGN §4-2, D-014).
 * 게임별 상한은 엔진 레지스트리 maxFrames·maxInputLength로 서비스가 다시 검사한다(defense DESIGN §B2)
 */
export const GAME_REPLAY_MAX_FRAMES = 216_000;
export const GAME_REPLAY_MAX_INPUT_LENGTH = 120_000;

/** 리플레이 프레임 수와 서버 경과 시간 비교 여유 (밀리초) — 네트워크 지연 */
export const GAME_REPLAY_TIME_TOLERANCE_MS = 5_000;

/** 검증이 밀렸을 때(503 GAME_VERIFY_BUSY) 다시 시도까지 기다릴 시간 (초) — Retry-After 헤더 (defense DESIGN §B4) */
export const GAME_VERIFY_RETRY_AFTER_SECONDS = 2;

/** 검증 워커를 쓸 수 없을 때(연속 크래시로 자리가 꺼짐, 최대 60초)의 Retry-After (초) — 2초 간격 재시도로 두드리지 않게 (games-polish BD-14) */
export const GAME_VERIFY_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/** 같은 세션의 검증이 이만큼 시간 초과하면 세션을 소모하고 422 — 결정적으로 느린 리플레이의 무한 503 재시도 차단 (games-polish BD-02) */
export const GAME_VERIFY_TIMEOUT_LIMIT = 2;

/** 디펜스 검증 워커 — 레플리카당 대기 작업 상한·작업 1건 시간 상한 (defense DESIGN §B5·§E5) */
export const DEFENSE_VERIFY_QUEUE_LIMIT = 4;
export const DEFENSE_VERIFY_TIMEOUT_MS = 5_000;

/** 리플레이 조회 응답의 브라우저 캐시 (초) — 입력 기록은 불변, 순위·숨김 반영 지연을 이 안으로 묶는다 (games-polish BD-06) */
export const GAME_REPLAY_CACHE_MAX_AGE_SECONDS = 60;

/** 랭킹 조회 기본·최대 개수 */
export const GAME_RANKING_DEFAULT_LIMIT = 50;
export const GAME_RANKING_MAX_LIMIT = 100;

/**
 * JSON 요청 본문 한도 — main.ts와 E2E(test/helpers/e2e-app.ts)가 같은 값을 쓴다.
 * 게임 리플레이 최대(입력 120,000개, delta 합 ≤ 216,000프레임) 본문이 이론상 약 262KB라 300kb (docs/tasks/games D-014).
 * Express 기본값은 100kb.
 */
export const JSON_BODY_LIMIT = '300kb';

/**
 * 게임 도메인 에러 (docs/tasks/games DESIGN.md §3)
 */
import { defineDomainError } from '../../common/dto/define-domain-error';

/** 지원하지 않는 게임 종류 (404) — 경로의 :gameType */
export const GameNotFoundErrorResponseDto = defineDomainError({
  code: 'GAME_NOT_FOUND',
  status: 404,
  message: '지원하지 않는 게임입니다.',
});

/** 랭킹 기록이 없거나 숨김 처리됨 (404) — 리플레이 조회 */
export const GameScoreNotFoundErrorResponseDto = defineDomainError({
  code: 'GAME_SCORE_NOT_FOUND',
  status: 404,
  message: '기록을 찾을 수 없습니다.',
});

/** 게임 세션이 없음·만료·이미 사용·엔진 버전 불일치 (409) — 새 게임을 시작해야 한다 */
export const GameSessionInvalidErrorResponseDto = defineDomainError({
  code: 'GAME_SESSION_INVALID',
  status: 409,
  message: '게임 세션이 만료되었거나 이미 사용되었습니다. 새 게임을 시작해주세요.',
});

/** 같은 보드에 같은 리플레이가 이미 등록됨 (409) — 세션 소모. 새 게임을 해야 한다 (games-polish D-003) */
export const GameReplayDuplicateErrorResponseDto = defineDomainError({
  code: 'GAME_REPLAY_DUPLICATE',
  status: 409,
  message: '이미 등록된 플레이 기록입니다.',
});

/** 게임 세션 저장소(Redis)를 쓸 수 없음 (503) — 플레이는 가능하지만 랭킹 등록 불가 */
export const GameSessionUnavailableErrorResponseDto = defineDomainError({
  code: 'GAME_SESSION_UNAVAILABLE',
  status: 503,
  message: '지금은 랭킹 등록을 준비할 수 없습니다. 잠시 후 다시 시도해주세요.',
});

/** 리플레이 검증을 지금 처리할 수 없음 (503) — 대기열 초과·타임아웃·검증기 오류. 세션은 남아 있어 Retry-After 뒤 같은 세션으로 다시 낸다 (defense DESIGN §B4) */
export const GameVerifyBusyErrorResponseDto = defineDomainError({
  code: 'GAME_VERIFY_BUSY',
  status: 503,
  message: '기록 확인이 밀려 있습니다. 잠시 후 다시 시도해주세요.',
});

/** 주간 도전을 열 수 없음 (503) — 주간 seed 시크릿 미설정. 다른 모드는 영향 없음 (defense DESIGN §B3) */
export const GameWeeklyUnavailableErrorResponseDto = defineDomainError({
  code: 'GAME_WEEKLY_UNAVAILABLE',
  status: 503,
  message: '지금은 주간 도전을 이용할 수 없습니다.',
});

/** 오늘의 테트리스를 열 수 없음 (503) — 데일리 seed 시크릿 미설정. 기본 보드는 영향 없음 (docs/tasks/games-growth D-004) */
export const GameDailyUnavailableErrorResponseDto = defineDomainError({
  code: 'GAME_DAILY_UNAVAILABLE',
  status: 503,
  message: '지금은 오늘의 테트리스를 이용할 수 없습니다.',
});

/** 도전장을 열 수 없음 (409) — 원본 기록의 엔진 버전이 현재와 달라 같은 seed로도 같은 판이 되지 않는다 (docs/tasks/games-growth D-009) */
export const GameChallengeExpiredErrorResponseDto = defineDomainError({
  code: 'GAME_CHALLENGE_EXPIRED',
  status: 409,
  message: '게임 버전이 바뀌어 이 도전장은 더 이상 플레이할 수 없습니다.',
});

/** 리플레이를 재현할 수 없음 (422) — 형식·게임 오버 불일치·실제 경과 시간 초과 */
export const GameReplayInvalidErrorResponseDto = defineDomainError({
  code: 'GAME_REPLAY_INVALID',
  status: 422,
  message: '플레이 기록을 확인할 수 없어 등록할 수 없습니다.',
});

/** 이름 형식 위반 (422) — 빈 값·12자 초과·48바이트 초과·허용 외 문자. 같은 세션으로 이름만 바꿔 다시 낼 수 있다 */
export const GamePlayerNameInvalidErrorResponseDto = defineDomainError({
  code: 'GAME_PLAYER_NAME_INVALID',
  status: 422,
  message: '이름은 1~12자의 한글·영문·숫자·공백·_·- 만 쓸 수 있습니다.',
});

/** 금칙어가 포함된 이름 (422) */
export const GamePlayerNameForbiddenErrorResponseDto = defineDomainError({
  code: 'GAME_PLAYER_NAME_FORBIDDEN',
  status: 422,
  message: '사용할 수 없는 이름입니다. 다른 이름을 입력해주세요.',
});

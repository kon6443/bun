/**
 * 테트리스 대전 REST 도메인 에러 — 경기 후 검증·결과 조회 (docs/tasks/tetris-battle DESIGN §17)
 * (소켓 에러는 ack code — tetris-battle.events.ts. 이쪽은 HTTP 상태 + code)
 */
import { defineDomainError } from '../../common/dto/define-domain-error';

/** 경기가 없음(만료·잘못된 id) · 숨김 (404) — DISPUTED도 공개한다(tetris-audit D-004) */
export const TetrisBattleMatchNotFoundErrorResponseDto = defineDomainError({
  code: 'TETRIS_BATTLE_MATCH_NOT_FOUND',
  status: 404,
  message: '경기를 찾을 수 없습니다.',
});

/** 리플레이가 없음 · 그 참가자가 검증 통과(VERIFIED)가 아님 (404) */
export const TetrisBattleReplayNotFoundErrorResponseDto = defineDomainError({
  code: 'TETRIS_BATTLE_REPLAY_NOT_FOUND',
  status: 404,
  message: '리플레이를 찾을 수 없습니다.',
});

/** playerToken이 이 경기의 어떤 참가자와도 맞지 않음 (403) */
export const TetrisBattlePlayerTokenInvalidErrorResponseDto = defineDomainError({
  code: 'TETRIS_BATTLE_PLAYER_TOKEN_INVALID',
  status: 403,
  message: '이 경기의 참가자가 아닙니다.',
});

/** 이미 제출함 (409) — 플레이어당 1번 */
export const TetrisBattleReplayAlreadySubmittedErrorResponseDto = defineDomainError({
  code: 'TETRIS_BATTLE_REPLAY_ALREADY_SUBMITTED',
  status: 409,
  message: '이미 리플레이를 제출했습니다.',
});

/** 경기가 아직 진행 중 (409) — matchEnded 이후에 제출 */
export const TetrisBattleMatchNotEndedErrorResponseDto = defineDomainError({
  code: 'TETRIS_BATTLE_MATCH_NOT_ENDED',
  status: 409,
  message: '경기가 아직 끝나지 않았습니다.',
});

/** 제출 마감(종료 후 60초)이 지남 (410) */
export const TetrisBattleSubmissionClosedErrorResponseDto = defineDomainError({
  code: 'TETRIS_BATTLE_SUBMISSION_CLOSED',
  status: 410,
  message: '리플레이 제출 시간이 지났습니다.',
});

/** 대전 상태 저장소(Redis) 사용 불가 (503) */
export const TetrisBattleUnavailableErrorResponseDto = defineDomainError({
  code: 'TETRIS_BATTLE_UNAVAILABLE',
  status: 503,
  message: '지금은 대전 기록을 처리할 수 없습니다. 잠시 후 다시 시도해주세요.',
});

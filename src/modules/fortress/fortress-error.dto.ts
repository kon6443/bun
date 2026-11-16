/**
 * 포트리스 REST 도메인 에러 — 경기 결과·리플레이 조회 (docs/tasks/fortress DESIGN §12)
 * (소켓 에러는 ack code — fortress.errors.ts·fortress.events.ts. 이쪽은 HTTP 상태 + code)
 */
import { defineDomainError } from '../../common/dto/define-domain-error';

/** 경기가 없음(잘못된 id·만료) · 숨김 · 아직 진행 중 (404) */
export const FortressMatchNotFoundErrorResponseDto = defineDomainError({
  code: 'FORTRESS_MATCH_NOT_FOUND',
  status: 404,
  message: '경기를 찾을 수 없습니다.',
});

/** 경기는 있는데 리플레이 행이 없음 (404) — 정상 저장이면 경기와 같은 트랜잭션이라 생기지 않는다(운영자 정리 등) */
export const FortressReplayNotFoundErrorResponseDto = defineDomainError({
  code: 'FORTRESS_REPLAY_NOT_FOUND',
  status: 404,
  message: '리플레이를 찾을 수 없습니다.',
});

/** AI전 업로드 — 올린 엔진 버전이 서버 엔진과 다름 (409). 클라이언트가 새로고침해 같은 엔진으로 다시 해야 한다 */
export const FortressSoloEngineMismatchErrorResponseDto = defineDomainError({
  code: 'FORTRESS_SOLO_ENGINE_MISMATCH',
  status: 409,
  message: '게임 버전이 바뀌어 이 기록을 저장할 수 없습니다. 새로고침 뒤 다시 플레이해 주세요.',
});

/**
 * AI전 업로드 — 서버 재시뮬레이션 검증 실패 (422). 사유는 details.reason:
 * CONFIG(설정·자리 목록 오류) · ACTION(규칙에 맞지 않는 행동, details.at = 행동 인덱스) · NOT_ENDED(끝나지 않은 경기) · HASH(마지막 상태가 다름)
 */
export const FortressSoloReplayInvalidErrorResponseDto = defineDomainError({
  code: 'FORTRESS_SOLO_REPLAY_INVALID',
  status: 422,
  message: '경기 기록을 확인할 수 없습니다.',
});

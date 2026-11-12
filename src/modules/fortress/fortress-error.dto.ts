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

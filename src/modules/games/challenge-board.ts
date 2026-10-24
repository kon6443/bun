/**
 * 도전장 보드 — `challenge-{원본 기록 ID}` (docs/tasks/games-growth D-005·D-009)
 *
 * 원본 기록과 같은 seed로 플레이한 기록을 모은다. seed가 공개 리플레이로 알려져 있어 메인 랭킹과 분리한다.
 * 보드 자체가 원본 1건 단위라 기간 필터를 쓰지 않고, 리플레이는 바로 공개한다(seed가 이미 공개).
 */
export const CHALLENGE_BOARD_PATTERN = /^challenge-([1-9]\d{0,14})$/;

export const challengeBoardKey = (scoreId: number) => `challenge-${scoreId}`;

/** 도전장 보드면 원본 기록 ID, 아니면 null */
export function challengeRootOf(boardKey: string): number | null {
  const match = CHALLENGE_BOARD_PATTERN.exec(boardKey);
  return match ? Number(match[1]) : null;
}

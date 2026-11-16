/**
 * 경기 목록 페이지 커서 (게임 공용) — 테트리스 대전·포트리스 경기 목록이 같은 정렬 키(CRTD_AT ms, MATCH_ID)로 넘긴다.
 * 커서는 불투명 문자열(base64url JSON)이다 — 클라이언트는 받은 nextCursor를 그대로 돌려줄 뿐 해석하지 않는다.
 */

/** 커서 시각 상한 여유 — 서버 시계 차이를 넉넉히 덮는 1일 */
const CURSOR_FUTURE_LIMIT_MS = 24 * 60 * 60 * 1000;

/** 커서 원문 — 직전 페이지 마지막 경기의 정렬 키 */
export interface GameMatchCursor {
  t: number;
  id: string;
}

export const encodeGameMatchCursor = (c: GameMatchCursor): string =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

/** 형식이 틀리면 null(→ 호출 쪽 422). idPattern은 각 게임의 matchId 형식 */
export const decodeGameMatchCursor = (
  raw: string,
  idPattern: RegExp,
  now = Date.now(),
): GameMatchCursor | null => {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<GameMatchCursor>;
    // 정수·0 이상·미래 1일 이내·유효한 Date만 — 범위 밖 값은 Invalid Date나 Oracle 바인드 오류(500)가 된다(테트리스 리뷰 N1)
    if (
      typeof c.t !== 'number' ||
      !Number.isSafeInteger(c.t) ||
      c.t < 0 ||
      c.t > now + CURSOR_FUTURE_LIMIT_MS
    )
      return null;
    if (Number.isNaN(new Date(c.t).getTime())) return null;
    if (typeof c.id !== 'string' || !idPattern.test(c.id)) return null;
    return { t: c.t, id: c.id };
  } catch {
    return null;
  }
};

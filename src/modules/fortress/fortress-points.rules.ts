import { type Action, type MatchConfig, type MatchResult, type MatchState, applyAction, createMatch } from './engine';

/**
 * 포트리스 경기 포인트 적립 규칙 — 순수 함수 (docs/tasks/fortress DESIGN §13, D-006·D-010)
 *
 * 두 단계로 나눈다:
 *  1. `baseAwards` — 경기 하나만 보고 정하는 값(유효 경기·참가·승리·KO·로그인 2명 조건). 트랜잭션 밖에서 계산
 *  2. `finalAward` — 그 사용자의 오늘(KST) 기록을 보고 정하는 값(같은 상대 감쇠·일일 상한). 사용자 행을 잠근 트랜잭션 안에서 계산
 * 모호한 규칙은 보수적으로(덜 주는 쪽) 정했다 — DESIGN §13 ⚖️
 */

export const FORTRESS_POINTS = {
  participation: 20_000,
  win: 30_000,
  ko: 10_000,
  /** KO 보상을 주는 최대 KO 수 */
  maxKos: 3,
  /** 유효 경기 — 자기 턴 실제 발사(파워 ≥ 1 fire) 최소 횟수 */
  minRealShots: 3,
  /** 유효 경기 — 경기 전체 최소 턴 수(진행한 턴 수 playedTurns) */
  minTurns: 6,
  /** 승리·KO 보상을 주는 최소 로그인 참가자 수 */
  minLoggedInForBonus: 2,
  /** KST 하루 포트리스 적립 상한 */
  dailyCap: 500_000,
} as const;

/** 같은 상대 감쇠 — n번째 경기(KST 하루, 같은 조합)의 승리·KO 몫 비율(%). 1~3: 100 · 4~5: 50 · 6~: 0 (참가만) */
export function sameOpponentBonusPercent(nth: number): number {
  if (nth <= 3) return 100;
  if (nth <= 5) return 50;
  return 0;
}

/**
 * slot별 실제 발사 수 — 파워 1 이상 fire만(D-010: 파워 0 넘기기·시간 초과 skip 제외). 행동에는 쏜 slot이 없어
 * 엔진으로 처음부터 재적용해 각 fire 직전의 턴 주인을 센다. 재적용이 실패하면(서버 버그) 그때까지만 센다 — 덜 세는 쪽
 */
export function realShotsBySlot(config: MatchConfig, actions: readonly Action[]): number[] {
  const shots = config.players.map(() => 0);
  const created = createMatch(config);
  if (!created.ok) return shots;
  let state = created.state;
  for (const action of actions) {
    const applied = applyAction(state, action);
    if (!applied.ok) break;
    if (action.kind === 'fire' && action.power >= 1 && state.turn.slot < shots.length) shots[state.turn.slot] += 1;
    state = applied.state;
  }
  return shots;
}

/**
 * 진행한 턴 수(유효 경기 최소 턴 판정용, 리뷰 B2) — 엔진(game.ts finish)은 승패를 낸 턴에서 turn.no를 올리지 않고 끝내므로
 * 그 턴을 더한다. 턴 상한 판정(no ≥ maxTurns)은 turn.no를 올린 뒤 끝나므로 그대로다. DB TURNS 컬럼·결과 API는 turn.no 그대로 둔다
 */
export function playedTurns(state: MatchState): number {
  return state.turn.no >= state.maxTurns ? state.turn.no : state.turn.no + 1;
}

/** 경기 하나의 참가자 사실 — 결과 저장 원본(Redis 경기)에서 만든다 */
export interface PointPlayerFacts {
  playerId: string;
  slot: number;
  /** 경기 시작 때 로그인 userId(게스트 null) — 결과 화면 로그인 소급 없음(D-006 #7) */
  userId: number | null;
  kos: number;
  realShots: number;
  /** 이 slot의 resign이 행동 로그에 있다(이탈·끊김 유예 초과) */
  resigned: boolean;
}

export interface PointMatchFacts {
  matchId: string;
  /** 진행한 턴 수 — playedTurns(최종 state). 승패를 낸 턴까지 센다(state.turn.no와 다를 수 있다) */
  turns: number;
  result: MatchResult;
  players: PointPlayerFacts[];
}

/** 경기 하나만 보고 정한 로그인 참가자 1명의 적립 */
export interface BaseAward {
  userId: number;
  playerId: string;
  participation: number;
  win: number;
  ko: number;
  /** 나 외 로그인 참가자 userId(오름차순) — 같은 상대 감쇠의 조합 키 */
  others: number[];
}

/**
 * 로그인 참가자별 기본 적립 — 유효 경기가 아니면(경기 6턴 미만 · 내 실제 발사 3회 미만) 또는 기권했으면 목록에서 뺀다(적립 0).
 * 승리 = result.kind 'win'이고 result.slots에 포함(ffa 승자·턴 상한 판정 승자·이긴 팀 전원), 무승부는 승리 없음.
 * 승리·KO는 서로 다른 로그인 userId가 2명 이상일 때만(D-006 #3)
 */
export function baseAwards(facts: PointMatchFacts): BaseAward[] {
  const loggedIn = [...new Set(facts.players.flatMap((p) => (p.userId === null ? [] : [p.userId])))].sort((a, b) => a - b);
  const bonusAllowed = loggedIn.length >= FORTRESS_POINTS.minLoggedInForBonus;
  const winners = facts.result.kind === 'win' ? facts.result.slots : [];
  if (facts.turns < FORTRESS_POINTS.minTurns) return [];
  // 한 계정은 한 자리만 — 방 서비스가 같은 userId를 같은 자리로 보내 생기지 않지만, 생기면 앞 slot만(두 번 적립하지 않게)
  const seen = new Set<number>();
  return facts.players.flatMap((p): BaseAward[] => {
    if (p.userId === null || seen.has(p.userId)) return [];
    seen.add(p.userId);
    if (p.resigned || p.realShots < FORTRESS_POINTS.minRealShots) return [];
    const userId = p.userId;
    return [
      {
        userId,
        playerId: p.playerId,
        participation: FORTRESS_POINTS.participation,
        win: bonusAllowed && winners.includes(p.slot) ? FORTRESS_POINTS.win : 0,
        ko: bonusAllowed ? Math.min(Math.max(0, p.kos), FORTRESS_POINTS.maxKos) * FORTRESS_POINTS.ko : 0,
        others: loggedIn.filter((id) => id !== userId),
      },
    ];
  });
}

export interface FinalAward {
  /** 원장에 넣을 금액 — 0이면 행을 넣지 않는다(원장 CHECK AMOUNT <> 0) */
  amount: number;
  /** 사람이 읽는 내역 (원장 MEMO) */
  memo: string;
  /** 일일 상한으로 잘렸다 */
  capped: boolean;
}

const won = (n: number) => n.toLocaleString('en-US');

/**
 * 감쇠·상한 적용 — `nth` = KST 오늘 같은 조합(나 외 로그인 참가자 집합) 경기 중 이 경기 순번(1부터),
 * `earnedToday` = KST 오늘 이미 적립한 포트리스 포인트 합계. 감쇠는 승리·KO 몫에만(참가는 그대로, "6번째부터 참가만"),
 * 50%는 내림. 상한은 감쇠 뒤 합계에 — 남은 한도로 잘라 적립하고 메모에 "일일 상한 도달"
 */
export function finalAward(matchId: string, base: BaseAward, nth: number, earnedToday: number): FinalAward {
  const percent = base.others.length > 0 ? sameOpponentBonusPercent(nth) : 100;
  const bonus = Math.floor(((base.win + base.ko) * percent) / 100);
  const total = base.participation + bonus;
  const remaining = Math.max(0, FORTRESS_POINTS.dailyCap - Math.max(0, earnedToday));
  const amount = Math.min(total, remaining);
  const capped = amount < total;

  const parts = [`포트리스 경기 ${matchId}`, `참가 ${won(base.participation)}`];
  if (base.win > 0) parts.push(`승리 ${won(base.win)}`);
  if (base.ko > 0) parts.push(`KO ${base.ko / FORTRESS_POINTS.ko}×${won(FORTRESS_POINTS.ko)}`);
  if (percent < 100 && base.win + base.ko > 0) parts.push(`같은 상대 ${nth}번째 · 승리·KO ${percent}%`);
  if (capped) parts.push('일일 상한 도달');
  return { amount, memo: parts.join(' · '), capped };
}

/** 원장 REF_KEY — (USER_ID, REASON, REF_KEY) 유니크라 같은 경기·같은 자리는 한 번만 */
export function fortressPointRefKey(matchId: string, playerId: string): string {
  return `${matchId}:${playerId}`;
}

import type { GameType } from '../../entities/GameScore';

/**
 * 게임별 리플레이 검증 엔진 레지스트리 (docs/tasks/games DESIGN.md §4, docs/tasks/defense DESIGN.md §B2)
 *
 * 서비스는 게임 종류를 몰라도 되게 이 인터페이스만 쓴다. 새 게임은 엔진 사본 + 여기 항목 1개를 추가한다.
 * DI 토큰으로 주입해 테스트가 가짜 엔진으로 검증 분기를 고정할 수 있게 한다.
 */
export interface ReplayInput {
  seed: number;
  /** 세션이 정한 랭킹 보드 — 보드별 규칙이 있는 게임(디펜스 주간 도전의 맵·규칙 변형)이 재현에 쓴다 */
  boardKey: string;
  /** 게임 틱 수 (게임별 ticksPerSecond) */
  frames: number;
  inputs: number[];
  /** 게임별 리플레이 설정 — 테트리스 { das, arr }. 키·값 형식은 isValidParams가 먼저 거른다 */
  params: Record<string, number>;
}

/** 랭킹 보드 — 한 게임 안에서 순위를 나누는 단위 (defense DESIGN §B1·§B6) */
export interface GameBoard {
  boardKey: string;
  /** 보드의 플레이 방식 — 테트리스는 null, 디펜스 'endless'·'weekly' */
  mode: string | null;
  /** 지금 등록받는 보드인지 (지난 시즌·지난 주는 false) */
  current: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

/**
 * 명예의 전당 기간 — 끝났고 재생이 공개된 기간 하나 (docs/tasks/games-growth D-010).
 * 기간 필터를 쓰는 보드(isPeriodRanking)면 등록 시각 [startsAt, endsAt)로, 아니면 보드 전체로 1~3위를 뽑는다
 */
export interface HallOfFamePeriod {
  kind: 'weekly' | 'daily';
  boardKey: string;
  startsAt: Date;
  endsAt: Date;
}

/** 세션 발급 시 정해지는 보드 — seed가 null이면 세션 서비스가 무작위로 정한다 */
export interface SessionBoard {
  boardKey: string;
  mode: string | null;
  seed: number | null;
}

export type VerifiedReplay =
  | { ok: true; score: number; detail: Record<string, number> }
  | { ok: false; reason: string };

export interface GameEngine {
  /** 서버가 받는 엔진 버전 — 세션 발급 시 내려주고 제출 시 일치를 확인한다 */
  engineVersion: number;
  /** 초당 틱 수 — 플레이 시간(DURATION_MS)과 실제 경과 시간 검사에 쓴다 */
  ticksPerSecond: number;
  /** 허용 최대 배속 — 시간 검사는 frames를 이 배속으로 돌렸을 때 걸리는 시간과 비교한다 */
  maxSpeed: number;
  /** 이 게임의 리플레이 상한 (DTO 상한은 모든 게임 중 최댓값) */
  maxFrames: number;
  maxInputLength: number;
  /** 세션 유효 시간 (초) */
  sessionTtlSeconds: number;
  /** board 쿼리를 생략한 랭킹 조회가 보는 보드 */
  defaultBoardKey: string;
  /** 도전장(원본 기록과 같은 seed, `challenge-{scoreId}` 보드)을 열 수 있는지 — 세션은 서비스가 원본에서 연다 (games-growth D-005) */
  supportsChallenge: boolean;
  /** 세션 발급 요청의 board(플레이 방식) → 보드 키·seed. 지원하지 않으면 null(422). 지원하지만 지금 못 여는 방식은 도메인 에러를 던진다(디펜스 주간 503) */
  resolveSessionBoard(board: string | undefined, now: Date): SessionBoard | null;
  /** 랭킹 조회에 쓸 수 있는 보드 키인지 */
  isRankingBoard(boardKey: string, now: Date): boolean;
  /** 랭킹 기간(일간·주간·전체) 필터를 쓰는 보드인지 — 디펜스 주간 보드는 보드 자체가 1주라 false */
  isPeriodRanking(boardKey: string): boolean;
  /** 리플레이 응답 최상위에도 펼치는 params 키 — 테트리스 기존 계약 das·arr (games DESIGN §3) */
  topLevelReplayParams: readonly string[];
  /** 이 보드 기록의 리플레이를 지금 공개하는지 — 디펜스 주간은 전원 같은 seed라 보드가 끝나기 전엔 비공개(입력 복제 방지) */
  isReplayPublic(boardKey: string, now: Date): boolean;
  /** /boards 응답 — 현재·지난 보드 목록 */
  listBoards(now: Date): GameBoard[];
  /** 명예의 전당 기간 목록(최근 순) — 끝났고 재생이 공개된 기간만 (games-growth D-010) */
  hallOfFamePeriods(now: Date): HallOfFamePeriod[];
  /** 제출된 params가 이 게임의 키 집합·정수 형식인지 — 세션을 쓰기 전에 422로 거른다. 값의 범위는 verify가 판정 */
  isValidParams(params: Record<string, number>): boolean;
  /**
   * 리플레이를 화면 없이 재실행해 점수·상세 값을 계산한다. 재현 불가면 ok: false.
   * 예외(타임아웃·검증기 오류)는 확정 결과가 아니다 — 서비스가 503으로 바꾸고 세션을 남긴다
   */
  verify(input: ReplayInput): Promise<VerifiedReplay>;
}

export type GameEngineRegistry = Record<GameType, GameEngine>;

export const GAME_ENGINE_REGISTRY = Symbol('GAME_ENGINE_REGISTRY');

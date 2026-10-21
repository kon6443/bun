import type { GameType } from '../../entities/GameScore';

/**
 * 게임별 리플레이 검증 엔진 레지스트리 (docs/tasks/games DESIGN.md §4)
 *
 * 서비스는 게임 종류를 몰라도 되게 이 인터페이스만 쓴다. 새 게임은 엔진 사본 + 여기 항목 1개를 추가한다.
 * DI 토큰으로 주입해 테스트가 가짜 엔진으로 검증 분기를 고정할 수 있게 한다.
 */
export interface ReplayInput {
  seed: number;
  das: number;
  arr: number;
  frames: number;
  inputs: number[];
}

export type VerifiedReplay =
  | { ok: true; score: number; detail: Record<string, number> }
  | { ok: false; reason: string };

export interface GameEngine {
  /** 서버가 받는 엔진 버전 — 세션 발급 시 내려주고 제출 시 일치를 확인한다 */
  engineVersion: number;
  /** 리플레이를 화면 없이 재실행해 점수·상세 값을 계산한다. 재현 불가면 ok: false */
  verify(input: ReplayInput): VerifiedReplay;
}

export type GameEngineRegistry = Record<GameType, GameEngine>;

export const GAME_ENGINE_REGISTRY = Symbol('GAME_ENGINE_REGISTRY');
